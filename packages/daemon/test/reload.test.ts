import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FIX = join(import.meta.dir, "fixtures");
const dir = mkdtempSync(join(tmpdir(), "uq-reload-"));
const xdg = mkdtempSync(join(tmpdir(), "uq-reload-xdg-"));
mkdirSync(join(dir, ".uniqlaw"), { recursive: true });
const settings = (extra: Record<string, unknown> = {}) => JSON.stringify({
  profiles: { main: { provider: "fake" } }, web: { port: 0 },
  plugins: { fake: { module: join(FIX, "fake-provider.ts") }, tg: { module: join(FIX, "fake-platform.ts"), token: "reload-tok" } }, ...extra });
writeFileSync(join(dir, ".uniqlaw", "settings.json"), settings());
const child = Bun.spawn([process.execPath, join(import.meta.dir, "..", "src", "index.ts"), dir], { env: { ...process.env, XDG_STATE_HOME: xdg }, stderr: "pipe", stdout: "ignore" });
let stderr = "";
void (async () => { for await (const c of child.stderr) stderr += new TextDecoder().decode(c); })();
afterAll(() => { child.kill(); rmSync(dir, { recursive: true, force: true }); rmSync(xdg, { recursive: true, force: true }); });

const runtime = () => JSON.parse(readFileSync(join(dir, ".uniqlaw", "runtime.json"), "utf8")) as { pid: number; webPort: number; startedAt: number };
const waitFor = async (c: () => boolean, ms = 8000) => { const e = Date.now() + ms; while (!c()) { if (Date.now() > e) throw new Error(`timeout; stderr=${stderr.slice(-800)}`); await Bun.sleep(50); } };

test("SIGHUP / POST /api/reload restarts in-process; broken settings are rejected", async () => {
  await waitFor(() => { try { return runtime().pid === child.pid; } catch { return false; } });
  const first = runtime();
  // valid change → reload
  writeFileSync(join(dir, ".uniqlaw", "settings.json"), settings({ timezone: "Asia/Taipei" }));
  const r = await (await fetch(`http://127.0.0.1:${first.webPort}/api/reload`, { method: "POST" })).json() as { ok: boolean };
  expect(r.ok).toBe(true);
  await waitFor(() => stderr.includes("[uniqlaw] reloaded"));
  await waitFor(() => { try { return runtime().startedAt > first.startedAt; } catch { return false; } });
  expect(runtime().pid).toBe(child.pid);
  // broken change → rejected, daemon keeps serving
  writeFileSync(join(dir, ".uniqlaw", "settings.json"), "{ not json");
  const bad = await fetch(`http://127.0.0.1:${runtime().webPort}/api/reload`, { method: "POST" });
  expect(bad.status).toBe(400);
  expect(((await bad.json()) as { ok: boolean }).ok).toBe(false);
  child.kill("SIGHUP");
  await waitFor(() => stderr.includes("reload rejected"));
  const st = await (await fetch(`http://127.0.0.1:${runtime().webPort}/api/status`)).json() as { ok: boolean };
  expect(st.ok).toBe(true);
}, 30_000);
