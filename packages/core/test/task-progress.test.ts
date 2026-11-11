// task_status while a task is still open: elapsed time, whether it runs or waits in the answering session's queue,
// the latest assistant text (also mid-stream) and a bounded tail of recent activity. Also pins down what happens when
// agent_ask reaches a session that is mid-turn: queued by default (no interrupt), merged into the turn in steer mode.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ChannelManager, McpGateway, StateStore, parseSettings, silentLogger, type Profile } from "../src/index.ts";
import { CAPS, FakePlatform, FakeProvider, type Script } from "./fakes.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

const until = async (cond: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error("timeout"); await Bun.sleep(5); }
};

function setup(queueMode: "queue" | "steer" = "queue") {
  const dir = mkdtempSync(join(tmpdir(), "uq-tp-"));
  const store = new StateStore(join(dir, "state.db"));
  const settings = parseSettings({ profiles: { main: { provider: "fake" } }, output: { toolStatus: false }, queue: { debounceMs: 0, mode: queueMode } });
  const gate: { release?: () => void } = {};
  const script: Script = async (input, s) => {
    if (input.text.includes("long job")) {
      s.emit({ type: "tool_start", id: "t1", name: "Bash", input: { command: "bun test" } },
        { type: "text", segmentId: "a", final: "Running the tests now." },
        { type: "text", segmentId: "b", delta: "Half of them " }, { type: "text", segmentId: "b", delta: "pass so far" });
      await new Promise<void>((r) => { gate.release = r; });
      s.emit({ type: "text", segmentId: "b", final: "All tests pass." }, { type: "turn_end", turnId: s.turnId(), reason: "done" });
    } else {
      s.emit({ type: "text", segmentId: "a", final: "quick answer" }, { type: "turn_end", turnId: s.turnId(), reason: "done" });
    }
  };
  const provider = new FakeProvider(script, CAPS);
  const profile: Profile = { name: "main", provider: "fake", permissions: settings.profiles.main!.permissions, options: {} };
  let mgr!: ChannelManager;
  const gw = new McpGateway(() => mgr, silentLogger);
  gw.start("127.0.0.1", 0);
  mgr = new ChannelManager({ log: silentLogger, settings, store, projectDir: dir, instanceId: "t",
    providers: new Map([["fake", provider]]), platforms: new Map([["tg", new FakePlatform()]]), profiles: new Map([["main", profile]]),
    gatewayFor: (k) => gw.endpointFor(k), systemPrompt: async () => ({ fragments: [] }), providerEnv: async () => ({}) });
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }), () => store.close(), () => gw.stop(), () => mgr.stop());
  return { gw, mgr, provider, gate };
}

test("a running task reports elapsed time, the text being streamed and recent activity; a finished one only its result", async () => {
  const { gw, mgr, gate } = setup();
  const { taskId } = await mgr.ask("tg:-1", "tg:-2", "long job", false);
  await until(() => mgr.taskReport(taskId)?.progress?.latestText === "Half of them pass so far");
  const r = mgr.taskReport(taskId, Date.now() + 5000)!;
  expect(r).toMatchObject({ state: "working", result: null, progress: { phase: "running" } });
  expect(r.elapsedSec).toBeGreaterThanOrEqual(5);
  expect(r.progress!.turnElapsedSec).toBeGreaterThanOrEqual(5);
  expect(r.progress!.recent).toEqual(["tool: Bash", "text: Running the tests now."]); // tool names only, no inputs
  expect(JSON.stringify(r)).not.toContain("bun test");

  // The same through the MCP tool, for the asker.
  const c = new Client({ name: "t", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(gw.endpointFor("tg:-1")!.url)));
  cleanups.push(() => c.close());
  const viaTool = JSON.parse((await c.callTool({ name: "task_status", arguments: { taskId } }) as { content: { text: string }[] }).content[0]!.text);
  expect(viaTool).toMatchObject({ state: "working", progress: { phase: "running", latestText: "Half of them pass so far" } });

  gate.release!();
  await until(() => mgr.taskReport(taskId)?.state === "completed");
  const done = mgr.taskReport(taskId)!;
  expect(done.result).toBe("Running the tests now.\n\nAll tests pass.");
  expect(done.progress).toBeUndefined();
  expect(typeof done.elapsedSec).toBe("number");
});

test("agent_ask to a session mid-turn is queued, not an interrupt (default queue mode)", async () => {
  const { mgr, provider, gate } = setup();
  const first = await mgr.ask("tg:-1", "tg:-2", "long job", false);
  await until(() => mgr.taskReport(first.taskId)?.progress?.phase === "running");
  const second = await mgr.ask("tg:-3", "tg:-2", "quick question", false);
  expect(mgr.taskReport(second.taskId)!.progress).toEqual({ phase: "queued", queuePosition: 1 });
  const s = provider.sessions.get("tg:-2")!;
  expect(s.interrupted).toBe(0);
  expect(s.steered).toHaveLength(0);
  gate.release!();
  await until(() => mgr.taskReport(second.taskId)?.state === "completed");
  expect(mgr.taskReport(first.taskId)!.result).toBe("Running the tests now.\n\nAll tests pass.");
  expect(mgr.taskReport(second.taskId)!.result).toBe("quick answer"); // its own turn, after the first one ended
});

test("queue.mode steer: agent_ask to a session mid-turn joins the running turn and shares its answer", async () => {
  const { mgr, provider, gate } = setup("steer");
  const first = await mgr.ask("tg:-1", "tg:-2", "long job", false);
  await until(() => mgr.taskReport(first.taskId)?.progress?.phase === "running");
  const second = await mgr.ask("tg:-3", "tg:-2", "quick question", false);
  const s = provider.sessions.get("tg:-2")!;
  expect(s.steered).toHaveLength(1);
  // The second asker joined mid-turn: nothing from before (the first asker's tool, texts, half-streamed text).
  const joined = mgr.taskReport(second.taskId)!.progress!;
  expect(joined.phase).toBe("running");
  expect(joined.latestText).toBeUndefined();
  expect(joined.recent).toBeUndefined();
  s.emit({ type: "tool_start", id: "t2", name: "Read", input: { file_path: "/secret/of/first/asker" } },
    { type: "text", segmentId: "c", delta: "Answering the quick one" });
  await until(() => mgr.taskReport(second.taskId)?.progress?.latestText === "Answering the quick one");
  expect(mgr.taskReport(second.taskId)!.progress!.recent).toEqual(["tool: Read"]);
  expect(mgr.taskReport(first.taskId)!.progress!.recent).toEqual(["tool: Bash", "text: Running the tests now.", "tool: Read"]);
  expect(JSON.stringify(mgr.taskReport(second.taskId))).not.toContain("/secret");
  gate.release!();
  await until(() => mgr.taskReport(second.taskId)?.state === "completed");
  expect(mgr.taskReport(second.taskId)!.result).toBe(mgr.taskReport(first.taskId)!.result!);
});
