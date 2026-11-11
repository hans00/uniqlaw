// Foreground runner. Graceful restart / reload (docs §11.3): a request (SIGHUP, POST /api/reload|restart,
// `uniqlaw reload|restart`, the daemon_restart tool) drains first; then
//  - reload: restart in-process with fresh settings (already-loaded code stays);
//  - restart: a new process (new code too). The old one stops (lock, ports, bot claims released), starts the
//    same command detached and waits until it is up (runtime.json names it) before exiting. If it doesn't come
//    up, the old process starts the daemon again in-process (old code) rather than leave nothing running.
//    Under a supervisor (systemd service, or UNIQLAW_RESTART_MODE=exit) it exits 75 instead and lets the
//    supervisor start the new process: systemd's KillMode=control-group would kill a detached child.
// stop() detaches provider sessions (claude-tmux keeps tmux alive), so conversations survive both.
import { mkdirSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RESTART_FALLBACK_KEY, StateStore, type RestartKind } from "@uniqlaw/core";
import { startDaemon, loadSettings, type Daemon } from "./index.ts";
import { isAlive, readRuntime, stateDirOf } from "./instance.ts";

/** Exit code of a restart left to the supervisor. */
export const RESTART_EXIT_CODE = 75;

/**
 * spawn: start the new process ourselves. exit: exit 75 for a supervisor. UNIQLAW_RESTART_MODE wins. Otherwise
 * exit only for a system service systemd started directly: INVOCATION_ID / NOTIFY_SOCKET set, our cgroup is a
 * *.service unit, and our parent is pid 1. Anything else — a terminal (its own scope), a cron.service job or CI
 * runner, a user-manager unit (parent is not pid 1) — spawns; set UNIQLAW_RESTART_MODE=exit there explicitly.
 * Guessing "exit" wrong leaves nothing running; guessing "spawn" wrong at worst loses the child to KillMode.
 */
export function restartMode(env: Record<string, string | undefined> = process.env, cgroup = readOwnCgroup(), ppid = process.ppid): "spawn" | "exit" {
  const m = env.UNIQLAW_RESTART_MODE;
  if (m === "exit" || m === "spawn") return m;
  const unit = cgroup.trim().split("\n").map((l) => l.split(":").slice(2).join(":")).find(Boolean)?.split("/").filter(Boolean).at(-1) ?? "";
  return (env.INVOCATION_ID || env.NOTIFY_SOCKET) && unit.endsWith(".service") && ppid === 1 ? "exit" : "spawn";
}

function readOwnCgroup(): string {
  try { return readFileSync("/proc/self/cgroup", "utf8"); } catch { return ""; }
}

export async function runForever(projectDir: string, opts: { logToStderr?: boolean } = {}): Promise<void> {
  let daemon!: Daemon;
  let reloading: Promise<boolean> | undefined;
  /** Single-flight stop of the current daemon (a SIGTERM during a restart must not stop it twice). */
  let stopping: Promise<void> | undefined;
  const stopOnce = () => (stopping ??= daemon.stop());
  const onRestart = (kind: RestartKind) => (kind === "reload" ? reload() : restart());
  const start = async () => { const d = await startDaemon(projectDir, { ...opts, onRestart }); daemon = d; stopping = undefined; return d; };

  /** false = rejected, nothing was stopped (the coordinator ends the drain). */
  const reload = () => {
    reloading ??= (async () => {
      try {
        loadSettings(projectDir); // validate first: a broken settings.json must not take the daemon down
      } catch (e) {
        console.error(`[uniqlaw] reload rejected, keeping the running config: ${e instanceof Error ? e.message : e}`);
        return false;
      }
      await stopOnce();
      try {
        await start();
        console.error("[uniqlaw] reloaded");
        return true;
      } catch (e) {
        console.error(`[uniqlaw] reload failed to start: ${e instanceof Error ? e.message : e}; exiting`);
        process.exit(1);
      }
    })().finally(() => { reloading = undefined; });
    return reloading;
  };

  const restart = async () => {
    const mode = restartMode();
    await stopOnce();
    if (mode === "exit") { console.error("[uniqlaw] restarting: exiting for the supervisor"); process.exit(RESTART_EXIT_CODE); }
    const logDir = join(stateDirOf(projectDir), "logs");
    mkdirSync(logDir, { recursive: true });
    let why: string;
    try {
      const out = openSync(join(logDir, "stdout.log"), "a");
      const child = Bun.spawn([process.execPath, ...process.argv.slice(1)], { stdio: ["ignore", out, out], env: process.env, detached: true });
      child.unref();
      const readyMs = Number(process.env.UNIQLAW_RESTART_READY_MS ?? 60_000);
      const until = Date.now() + readyMs;
      while (Date.now() < until && child.exitCode === null && readRuntime(projectDir)?.pid !== child.pid) await Bun.sleep(200);
      if (readRuntime(projectDir)?.pid === child.pid && isAlive(child.pid)) {
        console.error(`[uniqlaw] restarted as pid ${child.pid}`);
        process.exit(0);
      }
      why = child.exitCode !== null ? `the new process exited with code ${child.exitCode}` : `the new process was not up after ${readyMs / 1000}s`;
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        for (let i = 0; i < 30 && isAlive(child.pid); i++) await Bun.sleep(100);
        if (isAlive(child.pid)) child.kill("SIGKILL");
      }
    } catch (e) {
      why = `could not start the new process: ${e instanceof Error ? e.message : e}`;
    }
    console.error(`[uniqlaw] RESTART FAILED: ${why} (see ${join(logDir, "stdout.log")}). Starting the current code again in this process.`);
    try {
      const st = new StateStore(join(stateDirOf(projectDir), "state.db"));
      try { st.set(RESTART_FALLBACK_KEY, why); } finally { st.close(); }
      await start();
      console.error("[uniqlaw] running again on the previous code");
      return true;
    } catch (e) {
      console.error(`[uniqlaw] could not start again either: ${e instanceof Error ? e.message : e}; exiting`);
      process.exit(1);
    }
  };

  await start();

  process.on("SIGHUP", () => {
    try { daemon.restart.request({ kind: "reload", requestedBy: "SIGHUP" }); }
    catch (e) { console.error(`[uniqlaw] reload rejected, keeping the running config: ${e instanceof Error ? e.message : e}`); }
  });
  const shutdown = async (signal: string) => {
    await reloading;
    if (!stopping) daemon.restart.recordStop(signal); // the next start tells sessions whose turn this cut off
    await stopOnce();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}
