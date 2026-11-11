import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, type Daemon } from "../src/index.ts";
import { tailFile } from "../src/api.ts";
import { instances } from "./fixtures/fake-platform.ts";

const FIX = join(import.meta.dir, "fixtures");
const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });
process.env.XDG_STATE_HOME ??= mkdtempSync(join(tmpdir(), "uq-xdg-"));

function project(extra: Record<string, unknown> = {}, token = `web-${Math.random()}`) {
  const dir = mkdtempSync(join(tmpdir(), "uq-web-"));
  mkdirSync(join(dir, ".uniqlaw", "jobs"), { recursive: true });
  writeFileSync(join(dir, ".uniqlaw", "jobs", "standup.md"), "---\nschedule: \"0 9 * * 1-5\"\nreplyTo: tg:100\n---\nSummarise yesterday.\n");
  writeFileSync(join(dir, ".uniqlaw", "settings.json"), JSON.stringify({
    profiles: { main: { provider: "fake" } }, queue: { debounceMs: 0 },
    plugins: { fake: { module: join(FIX, "fake-provider.ts") }, tg: { module: join(FIX, "fake-platform.ts"), token } },
    ...extra,
  }));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
async function start(dir: string): Promise<Daemon> { const d = await startDaemon(dir); cleanups.push(() => d.stop()); return d; }
const sendHi = (text = "hello") => instances.at(-1)!.sink!.message({ platform: "tg", channelKey: "tg:100", replyTarget: { platform: "tg", chatId: "100" },
  ref: { platform: "tg", chatId: "100", messageId: "1" }, sender: { id: "7", name: "Hans" }, trusted: true, multiparty: false, text, attachments: [], receivedAt: Date.now() });
const until = async (c: () => boolean | Promise<boolean>, ms = 3000) => { const e = Date.now() + ms; while (!(await c())) { if (Date.now() > e) throw new Error("timeout"); await Bun.sleep(20); } };

test("dashboard page + static assets are served", async () => {
  const d = await start(project());
  const base = `http://127.0.0.1:${d.webPort}`;
  const page = await fetch(`${base}/`);
  expect(page.headers.get("content-type")).toContain("text/html");
  const html = await page.text();
  expect(html).toContain("<title>UniQlaw</title>");
  expect(html).toContain('src="/app.js"');
  expect((await fetch(`${base}/app.js`)).headers.get("content-type")).toContain("javascript");
  expect((await fetch(`${base}/style.css`)).status).toBe(200);
});

test("agents, transcript, jobs, logs, stop/reset; v2 endpoints still work", async () => {
  const d = await start(project());
  const base = `http://127.0.0.1:${d.webPort}`;
  sendHi("what's up");
  let entries: { kind: string; text: string }[] = [];
  await until(async () => {
    entries = ((await (await fetch(`${base}/api/sessions/tg%3A100/transcript`)).json()) as { entries: typeof entries }).entries;
    return entries.some((e) => e.kind === "turn_end");
  });
  expect(entries.map((e) => e.kind)).toEqual(["prompt", "assistant", "turn_end"]);
  expect(entries[0]!.text).toContain("Message: what's up");
  expect(entries[1]!.text).toBe("echo: Message: what's up");

  const agents = (await (await fetch(`${base}/api/agents`)).json()) as { agents: { name: string; providerSessionId: string; lastTarget: { chatId: string }; pending: number }[] };
  expect(agents.agents.find((a) => a.name === "tg:100")).toMatchObject({ providerSessionId: "p-tg:100", lastTarget: { chatId: "100" }, pending: 0 });

  const jobs = (await (await fetch(`${base}/api/jobs`)).json()) as { jobs: { name: string; replyTo: string; next: string }[] };
  expect(jobs.jobs[0]).toMatchObject({ name: "standup", replyTo: "tg:100" });
  expect(Date.parse(jobs.jobs[0]!.next)).toBeGreaterThan(Date.now());

  const logs = (await (await fetch(`${base}/api/logs?lines=5`)).json()) as { lines: string[] };
  expect(logs.lines.length).toBeGreaterThan(0);
  expect(logs.lines.length).toBeLessThanOrEqual(5);

  expect(await (await fetch(`${base}/api/sessions/tg%3A100/stop`, { method: "POST" })).json()).toMatchObject({ ok: true, stopped: false });
  expect(await (await fetch(`${base}/api/sessions/tg%3A100/reset`, { method: "POST" })).json()).toMatchObject({ ok: true });
  expect((await fetch(`${base}/api/sessions/nope/reset`, { method: "POST" })).status).toBe(404);

  expect(await (await fetch(`${base}/api/status`)).json()).toMatchObject({ ok: true });
  expect(await (await fetch(`${base}/api/send`, { method: "POST", body: JSON.stringify({ target: "tg:100", text: "x" }) })).json()).toMatchObject({ ok: true, inboxOwner: "tg:100" });
});

test("SSE stream emits state, turn and transcript events", async () => {
  const d = await start(project());
  const res = await fetch(`http://127.0.0.1:${d.webPort}/api/events`);
  expect(res.headers.get("content-type")).toBe("text/event-stream");
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const seen = new Set<string>();
  const pump = (async () => {
    while (!(seen.has("turn_start") && seen.has("turn_end") && seen.has("transcript") && seen.has("state"))) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value);
      for (const m of buf.matchAll(/^event: (\w+)$/gm)) seen.add(m[1]!);
    }
  })();
  await until(() => seen.has("hello"));
  sendHi();
  await Promise.race([pump, Bun.sleep(3000)]);
  await reader.cancel();
  expect([...seen].sort()).toEqual(["hello", "state", "transcript", "turn_end", "turn_start"]);
});

test("web.token: required when set; cookie login; non-loopback without token refuses to start", async () => {
  process.env.UQ_TEST_WEB_TOKEN = "s3cret";
  const d = await start(project({ web: { token: { env: "UQ_TEST_WEB_TOKEN" } } }));
  const base = `http://127.0.0.1:${d.webPort}`;
  expect((await fetch(`${base}/api/agents`)).status).toBe(401);
  expect((await fetch(`${base}/`)).status).toBe(401);
  expect((await fetch(`${base}/api/agents`, { headers: { authorization: "Bearer s3cret" } })).status).toBe(200);
  const login = await fetch(`${base}/?token=s3cret`, { redirect: "manual" });
  expect(login.status).toBe(302);
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  expect((await fetch(`${base}/api/agents`, { headers: { cookie } })).status).toBe(200);
  expect((await fetch(`${base}/api/agents`, { headers: { authorization: "Bearer wrong" } })).status).toBe(401);

  await expect(startDaemon(project({ web: { host: "0.0.0.0", port: 0 } }))).rejects.toThrow(/not loopback/);
});

test("transcript is bounded per session", async () => {
  const { StateStore, TranscriptStore } = await import("@uniqlaw/core");
  const dir = mkdtempSync(join(tmpdir(), "uq-tr-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = new StateStore(join(dir, "s.db"));
  cleanups.push(() => store.close());
  const t = new TranscriptStore(store, 10);
  for (let i = 0; i < 25; i++) t.append("a", "assistant", `m${i}`);
  t.append("b", "prompt", "other");
  const a = t.list("a");
  expect(a.map((e) => e.text)).toEqual(Array.from({ length: 10 }, (_, i) => `m${i + 15}`));
  expect(t.list("a", 100, a[7]!.id).map((e) => e.text)).toEqual(["m23", "m24"]);
  expect(t.list("b")).toHaveLength(1);
});

test("tailFile reads only the end", () => {
  const dir = mkdtempSync(join(tmpdir(), "uq-tail-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const f = join(dir, "x.log");
  writeFileSync(f, Array.from({ length: 50000 }, (_, i) => `line ${i}`).join("\n") + "\n");
  expect(tailFile(f, 3)).toEqual(["line 49997", "line 49998", "line 49999"]);
  expect(tailFile(join(dir, "missing"), 3)).toEqual([]);
});

test("restart API: a session is only trusted as the requester with proof (its gateway token, or web.token)", async () => {
  const dir = project();
  const d = await startDaemon(dir, { onRestart: () => false });
  cleanups.push(() => d.stop());
  const base = `http://127.0.0.1:${d.webPort}`;
  await sendHi();
  await until(() => !!d.manager.runtimes.get("tg:100") && d.manager.runtimes.get("tg:100")!.state !== "opening");
  const { readFileSync } = await import("node:fs");
  const tok = (JSON.parse(readFileSync(join(dir, ".uniqlaw", "gateway.json"), "utf8")) as { tokens: Record<string, string> }).tokens["tg:100"]!;
  const ask = async (body: Record<string, unknown>) => {
    const r = await (await fetch(`${base}/api/restart`, { method: "POST", body: JSON.stringify({ in: "10m", ...body }) })).json() as { requestedBy: string[] };
    await fetch(`${base}/api/restart`, { method: "POST", body: JSON.stringify({ cancel: true }) });
    return r.requestedBy;
  };
  expect(await ask({ from: "tg:100" })).toEqual(["api"]);                         // a claim alone: ignored
  expect(await ask({ from: "tg:100", fromToken: "nope" })).toEqual(["api"]);
  expect(await ask({ fromLabel: "tg:100" })).toEqual(["api"]);
  expect(await ask({ from: "tg:100", fromToken: tok })).toEqual(["tg:100"]);       // proven
  expect(await ask({ from: "cli" })).toEqual(["cli"]);                             // not a session: a plain label
});
