// Foreground runner. Graceful restart / reload (docs §11.4): a request (SIGHUP, POST /api/reload|restart,
// `uniqlaw reload|restart`, the daemon_restart tool) drains first; then
//  - reload: restart in-process with fresh settings (already-loaded code stays);
//  - restart: a new process (new code too). The old one releases its lock and ports, starts the new one detached
//    and exits; the new one waits for the old pid to be gone. UNIQLAW_RESTART_MODE=exit: just exit 75 and let a
//    supervisor (systemd Restart=on-failure, …) start the new one.
// stop() detaches provider sessions (claude-tmux keeps tmux alive), so conversations survive both.
import { mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import type { RestartKind } from "@uniqlaw/core";
import { startDaemon, loadSettings, type Daemon } from "./index.ts";
import { isAlive, stateDirOf } from "./instance.ts";

/** Exit code of a restart left to the supervisor (UNIQLAW_RESTART_MODE=exit). */
export const RESTART_EXIT_CODE = 75;

export async function runForever(projectDir: string, opts: { logToStderr?: boolean } = {}): Promise<void> {
  // Started by a restart: the old process may still be closing its ports.
  const waitPid = Number(process.env.UNIQLAW_WAIT_PID);
  delete process.env.UNIQLAW_WAIT_PID;
  if (waitPid && waitPid !== process.pid) for (let i = 0; i < 150 && isAlive(waitPid); i++) await Bun.sleep(100);

  let daemon!: Daemon;
  let reloading: Promise<boolean> | undefined;
  const onRestart = (kind: RestartKind) => (kind === "reload" ? reload() : restart());
  const start = () => startDaemon(projectDir, { ...opts, onRestart });

  /** false = rejected, nothing was stopped (the coordinator ends the drain). */
  const reload = () => {
    reloading ??= (async () => {
      try {
        loadSettings(projectDir); // validate first: a broken settings.json must not take the daemon down
      } catch (e) {
        console.error(`[uniqlaw] reload rejected, keeping the running config: ${e instanceof Error ? e.message : e}`);
        return false;
      }
      await daemon.stop();
      try {
        daemon = await start();
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
    await daemon.stop();
    if (process.env.UNIQLAW_RESTART_MODE === "exit") { console.error("[uniqlaw] restarting (exit for the supervisor)"); process.exit(RESTART_EXIT_CODE); }
    const logDir = join(stateDirOf(projectDir), "logs");
    mkdirSync(logDir, { recursive: true });
    try {
      const out = openSync(join(logDir, "stdout.log"), "a");
      const child = Bun.spawn([process.execPath, ...process.argv.slice(1)], {
        stdio: ["ignore", out, out], env: { ...process.env, UNIQLAW_WAIT_PID: String(process.pid) }, detached: true,
      });
      child.unref();
      console.error(`[uniqlaw] restarting as pid ${child.pid}`);
      process.exit(0);
    } catch (e) {
      // Already stopped: the restart record is in state.db, so a manual `uniqlaw start` still sends the notices.
      console.error(`[uniqlaw] restart could not start the new process: ${e instanceof Error ? e.message : e}; exiting`);
      process.exit(1);
    }
  };

  daemon = await start();

  process.on("SIGHUP", () => {
    try { daemon.restart.request({ kind: "reload", requestedBy: "SIGHUP" }); }
    catch (e) { console.error(`[uniqlaw] reload rejected, keeping the running config: ${e instanceof Error ? e.message : e}`); }
  });
  const shutdown = async (signal: string) => {
    await reloading;
    daemon.restart.recordStop(signal); // the next start tells sessions whose turn this cut off
    await daemon.stop();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}
