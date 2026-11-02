import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ChannelManager, McpGateway, StateStore, parseSettings, silentLogger, type Profile } from "../src/index.ts";
import { FakePlatform, FakeProvider } from "./fakes.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "uq-gw-"));
  const store = new StateStore(join(dir, "state.db"));
  const settings = parseSettings({ profiles: { main: { provider: "fake" } }, queue: { debounceMs: 0 } });
  const provider = new FakeProvider((input, s) => {
    s.emit({ type: "text", segmentId: "a", final: `answer to: ${input.text.split("\n").at(-1)}` }, { type: "turn_end", turnId: s.turnId(), reason: "done" });
  });
  const platform = new FakePlatform();
  const profile: Profile = { name: "main", provider: "fake", permissions: settings.profiles.main!.permissions, options: {} };
  let mgr!: ChannelManager;
  const gw = new McpGateway(() => mgr, silentLogger);
  gw.start("127.0.0.1", 0);
  mgr = new ChannelManager({ log: silentLogger, settings, store, projectDir: dir, instanceId: "t",
    providers: new Map([["fake", provider]]), platforms: new Map([["tg", platform]]), profiles: new Map([["main", profile]]),
    gatewayFor: (k) => gw.endpointFor(k), systemPrompt: async () => ({ fragments: [] }), providerEnv: async () => ({}) });
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }), () => store.close(), () => gw.stop(), () => mgr.stop());
  return { gw, mgr, store, platform };
}

async function client(url: string) {
  const c = new Client({ name: "t", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(url)));
  cleanups.push(() => c.close());
  return c;
}
const text = (r: unknown) => ((r as { content: { text: string }[] }).content[0]!.text);

test("tools are listed and identity comes from the token", async () => {
  const { gw, store, platform } = setup();
  const a = await client(gw.endpointFor("tg:-1")!.url);
  expect((await a.listTools()).tools.map((t) => t.name).sort()).toEqual(["agent_ask", "agent_trigger", "agents_list", "notify", "task_status"]);
  // notify from tg:-1 to the DM → echo lands on "global", attributed to tg:-1
  await a.callTool({ name: "notify", arguments: { target: "tg:100", text: "hello human" } });
  expect(platform.sent[0]!.text).toBe("hello human");
  const pending = store.drainPending("global");
  expect(JSON.parse(pending[0]!.payload).label).toContain("tg:-1");
});

test("agent_ask round-trip through MCP", async () => {
  const { gw } = setup();
  const a = await client(gw.endpointFor("tg:-1")!.url);
  const r = await a.callTool({ name: "agent_ask", arguments: { to: "tg:-2", message: "ping?" } });
  expect(text(r)).toBe("answer to: ping?");
});

test("unknown token is rejected", async () => {
  const { gw } = setup();
  gw.endpointFor("tg:-1");
  const bad = gw.endpointFor("tg:-1")!.url.replace(/[a-f0-9]+$/, "deadbeef");
  await expect(client(bad)).rejects.toThrow();
});

test("task_status is only visible to the two sessions involved", async () => {
  const { gw, mgr } = setup();
  const { taskId } = await mgr.ask("tg:-1", "tg:-2", "q", true);
  const outsider = await client(gw.endpointFor("tg:-3")!.url);
  const r = await outsider.callTool({ name: "task_status", arguments: { taskId } });
  expect(text(r)).toContain("unknown task");
});
