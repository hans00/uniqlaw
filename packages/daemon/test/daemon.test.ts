import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listInstances, readRuntime, startDaemon, type Daemon } from "../src/index.ts";
import { instances } from "./fixtures/fake-platform.ts";
import { lastSpecs } from "./fixtures/fake-provider.ts";

const FIX = join(import.meta.dir, "fixtures");
const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });
process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "uq-xdg-"));

function project(token = "bot-token-1") {
  const dir = mkdtempSync(join(tmpdir(), "uq-proj-"));
  mkdirSync(join(dir, ".uniqlaw"), { recursive: true });
  mkdirSync(join(dir, "prompts"));
  writeFileSync(join(dir, "prompts", "IDENTITY.md"), "You are Testy.");
  writeFileSync(join(dir, ".uniqlaw", "settings.json"), JSON.stringify({
    profiles: { main: { provider: "fake" } },
    queue: { debounceMs: 0 },
    plugins: { fake: { module: join(FIX, "fake-provider.ts") }, tg: { module: join(FIX, "fake-platform.ts"), token } },
  }));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function start(dir: string): Promise<Daemon> {
  const d = await startDaemon(dir);
  cleanups.push(() => d.stop());
  return d;
}

test("boots, writes runtime.json, routes a message end-to-end, serves the API", async () => {
  const dir = project();
  const d = await start(dir);
  const rt = readRuntime(dir)!;
  expect(rt.pid).toBe(process.pid);
  expect(rt.webPort).toBeGreaterThan(0);
  expect(listInstances().some((i) => i.projectDir === dir)).toBe(true);

  const tg = instances.at(-1)!;
  tg.sink!.message({ platform: "tg", channelKey: "global", replyTarget: { platform: "tg", chatId: "100" }, ref: { platform: "tg", chatId: "100", messageId: "1" },
    sender: { id: "7", name: "Hans" }, trusted: true, multiparty: false, text: "hello", attachments: [], receivedAt: Date.now() });
  for (let i = 0; i < 100 && !tg.sent.some((m) => m.text === "echo: Message: hello"); i++) await Bun.sleep(10);
  expect(tg.sent.map((m) => m.text)).toContain("echo: Message: hello");

  // system prompt: brand + prompt file + dir scope + bus tools; MCP endpoint issued
  const spec = lastSpecs.at(-1) as { systemPrompt: { fragments: { id: string; text: string }[] }; mcp: { url: string; toolNames: string[] }; env: Record<string, string> };
  expect(spec.systemPrompt.fragments.map((f) => f.id)).toEqual(["brand", "file:prompts/IDENTITY.md", "dir-scope", "reactions", "bus-tools"]);
  expect(spec.mcp.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/[a-f0-9]+$/);
  expect(spec.env.UNIQLAW_INSTANCE).toBe(rt.instanceId);
  expect(Object.keys(spec.env).some((k) => k.includes("TOKEN") || k.includes("KEY"))).toBe(false);

  const status = await (await fetch(`http://127.0.0.1:${d.webPort}/api/status`)).json() as { agents: { name: string }[] };
  expect(status.agents.map((a) => a.name)).toContain("global");
  const send = await (await fetch(`http://127.0.0.1:${d.webPort}/api/send`, { method: "POST", body: JSON.stringify({ target: "tg:100", text: "from api" }) })).json() as { ok: boolean; inboxOwner: string };
  expect(send).toMatchObject({ ok: true, inboxOwner: "global" });
});

test("a second daemon for the same project is refused", async () => {
  const dir = project("bot-token-2");
  // Another live process (our parent) holds the lock.
  writeFileSync(join(dir, ".uniqlaw", "daemon.lock"), String(process.ppid));
  await expect(startDaemon(dir)).rejects.toThrow(/already running/);
  // A stale lock (dead pid) is taken over.
  writeFileSync(join(dir, ".uniqlaw", "daemon.lock"), "999999");
  const d = await start(dir);
  expect(d.webPort).toBeGreaterThan(0);
});

test("two projects cannot share one bot token; different tokens run side by side", async () => {
  const a = project("shared-token");
  await start(a);
  // Pretend another live process (our parent) owns "shared-token" for a different project.
  const { claimsDir } = await import("../src/instance.ts");
  const { createHash } = await import("node:crypto");
  const { readdirSync, readFileSync } = await import("node:fs");
  const file = readdirSync(claimsDir()).map((f) => join(claimsDir(), f)).find((f) => JSON.parse(readFileSync(f, "utf8")).projectDir === a)!;
  writeFileSync(file, JSON.stringify({ pid: process.ppid, projectDir: "/somewhere/else", what: "tg bot token", at: Date.now() }));
  void createHash;
  const b = project("shared-token");
  await expect(startDaemon(b)).rejects.toThrow(/already used by the UniQlaw instance at \/somewhere\/else/);
  const c = project("other-token");
  const dc = await start(c);
  expect(dc.webPort).toBeGreaterThan(0);
});

test("cron is on by default and its MCP tools manage job files", async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const { existsSync, readFileSync } = await import("node:fs");
  const dir = project("bot-token-cron");
  await start(dir);
  lastSpecs.length = 0;
  instances.at(-1)!.sink!.message({ platform: "tg", channelKey: "global", replyTarget: { platform: "tg", chatId: "100" }, ref: { platform: "tg", chatId: "100", messageId: "1" },
    sender: { id: "7", name: "Hans" }, trusted: true, multiparty: false, text: "hi", attachments: [], receivedAt: Date.now() });
  for (let i = 0; i < 100 && !lastSpecs.length; i++) await Bun.sleep(10);
  const spec = lastSpecs.at(-1) as { mcp: { url: string; toolNames: string[] } };
  expect(spec.mcp.toolNames).toContain("cron_save");
  const c = new Client({ name: "t", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(spec.mcp.url)));
  const r = await c.callTool({ name: "cron_save", arguments: { name: "standup", schedule: "0 9 * * 1-5", prompt: "Summarise yesterday." } }) as { content: { text: string }[] };
  expect(r.content[0]!.text).toContain("standup");
  const file = join(dir, ".uniqlaw", "jobs", "standup.md");
  expect(existsSync(file)).toBe(true);
  expect(readFileSync(file, "utf8")).toContain("schedule: \"0 9 * * 1-5\"");
  const bad = await c.callTool({ name: "cron_save", arguments: { name: "x", schedule: "every day", prompt: "?" } }) as { isError?: boolean };
  expect(bad.isError).toBe(true);
  const list = await c.callTool({ name: "cron_list", arguments: {} }) as { content: { text: string }[] };
  expect(JSON.parse(list.content[0]!.text)[0]).toMatchObject({ name: "standup", target: "global" });
  await c.close();
});
