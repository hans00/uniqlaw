// `uniqlaw restart` end to end on a real process (isolated temp project, fake provider/platform): the daemon
// drains, writes its record, starts a new process and exits; the new one comes up on the same project.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isAlive } from "../src/instance.ts";
import { restartMode } from "../src/run.ts";

const FIX = join(import.meta.dir, "fixtures");
const CLI = join(import.meta.dir, "..", "..", "cli", "src", "main.ts");
const xdg = mkdtempSync(join(tmpdir(), "uq-restart-xdg-"));
const dirs: string[] = [];
const pids = new Set<number>();
afterAll(() => {
  // Re-exec'd daemons are not our children: also kill whatever each project's runtime.json names.
  for (const d of dirs) { const pid = runtime(d)?.pid; if (pid) pids.add(pid); }
  for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch {} }
  for (const d of [...dirs, xdg]) rmSync(d, { recursive: true, force: true });
});

function project(token: string) {
  const dir = mkdtempSync(join(tmpdir(), "uq-restart-"));
  dirs.push(dir);
  mkdirSync(join(dir, ".uniqlaw"), { recursive: true });
  writeFileSync(join(dir, ".uniqlaw", "settings.json"), JSON.stringify({
    profiles: { main: { provider: "fake" } }, web: { port: 0 },
    plugins: { fake: { module: join(FIX, "fake-provider.ts") }, tg: { module: join(FIX, "fake-platform.ts"), token },
      "flaky-start": { module: join(FIX, "flaky-start.ts") } } }));
  return dir;
}
const runtime = (dir: string) => { try { return JSON.parse(readFileSync(join(dir, ".uniqlaw", "runtime.json"), "utf8")) as { pid: number; webPort: number }; } catch { return undefined; } };
const waitFor = async (c: () => boolean, ms = 15_000, what = "condition") => { const e = Date.now() + ms; while (!c()) { if (Date.now() > e) throw new Error(`timeout: ${what}`); await Bun.sleep(50); } };
const env = (extra: Record<string, string> = {}) => {
  const e: Record<string, string | undefined> = { ...process.env, XDG_STATE_HOME: xdg, UNIQLAW_SESSION: "", ...extra };
  if (!extra.INVOCATION_ID) { delete e.INVOCATION_ID; delete e.NOTIFY_SOCKET; } // not under systemd here
  return e;
};
async function cli(dir: string, ...args: string[]) {
  const p = Bun.spawn([process.execPath, CLI, ...args, "--project", dir], { env: env(), stdout: "pipe", stderr: "pipe" });
  const [out, err] = [await new Response(p.stdout).text(), await new Response(p.stderr).text()];
  return { code: await p.exited, out: out + err };
}
function run(dir: string, extra: Record<string, string> = {}) {
  const child = Bun.spawn([process.execPath, CLI, "run", "--project", dir], { env: env(extra), stdout: "ignore", stderr: "pipe" });
  pids.add(child.pid);
  const out = { stderr: "" };
  void (async () => { for await (const c of child.stderr) out.stderr += new TextDecoder().decode(c); })();
  return Object.assign(child, { out });
}

test("restart: drains, starts a new process on the same project, exits; --in schedules one; status shows it", async () => {
  const dir = project("restart-tok-1");
  const child = run(dir);
  await waitFor(() => runtime(dir)?.pid === child.pid, 15_000, "first start");

  const r = await cli(dir, "restart", "--reason", "test", "--from", "cli-test");
  expect(r.code).toBe(0);
  expect(r.out).toContain("restart");
  expect(await child.exited).toBe(0);
  await waitFor(() => !!runtime(dir) && runtime(dir)!.pid !== child.pid && isAlive(runtime(dir)!.pid), 15_000, "new process");
  const second = runtime(dir)!.pid;
  pids.add(second);
  const log = readFileSync(join(dir, ".uniqlaw", "logs", "daemon.log"), "utf8");
  expect(log).toContain("restart record written");
  expect(log).toContain("back from restart");

  // Scheduled: --in 2s shows up in status, then fires.
  const s = await cli(dir, "restart", "--in", "2s");
  expect(s.out).toContain("scheduled (at ");
  expect((await cli(dir, "status")).out).toContain("restart scheduled at");
  await waitFor(() => !isAlive(second), 15_000, "scheduled restart");
  await waitFor(() => !!runtime(dir) && runtime(dir)!.pid !== second && isAlive(runtime(dir)!.pid), 15_000, "third process");
  pids.add(runtime(dir)!.pid);
  // Invalid settings: refused, the daemon keeps running.
  writeFileSync(join(dir, ".uniqlaw", "settings.json"), "{ nope");
  const bad = await cli(dir, "restart");
  expect(bad.code).toBe(1);
  expect(bad.out).toContain("refused");
  expect(isAlive(runtime(dir)!.pid)).toBe(true);
}, 60_000);

test("UNIQLAW_RESTART_MODE=exit leaves the restart to a supervisor (exit 75)", async () => {
  const dir = project("restart-tok-2");
  const child = run(dir, { UNIQLAW_RESTART_MODE: "exit" });
  await waitFor(() => runtime(dir)?.pid === child.pid, 15_000, "start");
  const r = await fetch(`http://127.0.0.1:${runtime(dir)!.webPort}/api/restart`, { method: "POST", body: JSON.stringify({ reason: "supervised" }) });
  expect(((await r.json()) as { ok: boolean }).ok).toBe(true);
  expect(await child.exited).toBe(75);
  expect(runtime(dir)).toBeUndefined(); // released: the supervisor's new process can take the project
}, 30_000);

test("a new process that fails to start: the old one starts again in-process, never exits 0, and says so", async () => {
  const dir = project("restart-tok-3");
  const child = run(dir);
  await waitFor(() => runtime(dir)?.pid === child.pid, 15_000, "start");
  writeFileSync(join(dir, ".fail-next-start"), "");
  const r = await fetch(`http://127.0.0.1:${runtime(dir)!.webPort}/api/restart`, { method: "POST", body: JSON.stringify({ reason: "will fail" }) });
  expect(((await r.json()) as { ok: boolean }).ok).toBe(true);
  await waitFor(() => child.out.stderr.includes("running again on the previous code"), 30_000, "fallback");
  expect(child.out.stderr).toContain("RESTART FAILED: the new process exited with code 1");
  expect(child.exitCode).toBeNull();
  expect(runtime(dir)!.pid).toBe(child.pid);
  const log = readFileSync(join(dir, ".uniqlaw", "logs", "daemon.log"), "utf8");
  expect(log).toContain("back from restart");
  const st = await (await fetch(`http://127.0.0.1:${runtime(dir)!.webPort}/api/status`)).json() as { ok: boolean };
  expect(st.ok).toBe(true);
}, 60_000);

test("restart mode: a systemd service exits for its supervisor; a terminal under systemd's user manager does not", () => {
  const svc = "0::/user.slice/user-1000.slice/user@1000.service/app.slice/uniqlaw.service\n";
  const term = "0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-org.gnome.Terminal.slice/vte-spawn-1.scope\n";
  expect(restartMode({ INVOCATION_ID: "x" }, svc)).toBe("exit");
  expect(restartMode({ NOTIFY_SOCKET: "/run/x" }, "0::/system.slice/uniqlaw.service\n")).toBe("exit");
  expect(restartMode({ INVOCATION_ID: "x" }, term)).toBe("spawn");
  expect(restartMode({}, svc)).toBe("spawn");
  expect(restartMode({ INVOCATION_ID: "x", UNIQLAW_RESTART_MODE: "spawn" }, svc)).toBe("spawn");
  expect(restartMode({ UNIQLAW_RESTART_MODE: "exit" }, term)).toBe("exit");
});
