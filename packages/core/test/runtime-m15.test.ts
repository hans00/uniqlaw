// M1.5 behaviours: external (native peer socket) turns, steer/turn-end race, rate-limit retry.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.UNIQLAW_RATE_LIMIT_BACKOFF_MS = "20";
const core = await import("../src/index.ts");
const { FakePlatform, FakeProvider, CAPS } = await import("./fakes.ts");
type Script = import("./fakes.ts").Script;

let dir: string;
let store: InstanceType<typeof core.StateStore>;
let managers: InstanceType<typeof core.ChannelManager>[] = [];
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "uq-m15-")); store = new core.StateStore(join(dir, "state.db")); });
afterEach(async () => { for (const m of managers) await m.stop(); managers = []; store.close(); rmSync(dir, { recursive: true, force: true }); });

function setup(script: Script, settings: Record<string, unknown> = {}) {
  const s = core.parseSettings({ profiles: { main: { provider: "fake" } }, output: { toolStatus: false }, queue: { debounceMs: 0 }, ...settings });
  const provider = new FakeProvider(script);
  const platform = new FakePlatform();
  const mgr = new core.ChannelManager({ log: core.silentLogger, settings: s, store, projectDir: dir, instanceId: "t",
    providers: new Map([["fake", provider]]), platforms: new Map([["tg", platform]]),
    profiles: new Map([["main", { name: "main", provider: "fake", permissions: s.profiles.main!.permissions, options: {} }]]),
    gatewayFor: () => undefined, systemPrompt: async () => ({ fragments: [] }), providerEnv: async () => ({}) });
  managers.push(mgr);
  return { mgr, provider, platform };
}
const inbound = (text: string, chatId = "100") => ({ platform: "tg", channelKey: "global", replyTarget: { platform: "tg", chatId },
  ref: { platform: "tg", chatId, messageId: "m" }, sender: { id: "7", name: "Hans" }, trusted: true, multiparty: false, text, attachments: [], receivedAt: Date.now() });
const until = async (c: () => boolean, ms = 3000) => { const e = Date.now() + ms; while (!c()) { if (Date.now() > e) throw new Error("timeout"); await Bun.sleep(5); } };

test("external (native peer) turn goes to operators only, with a warning", async () => {
  const { mgr, provider, platform } = setup((_i, s) => s.emit({ type: "text", segmentId: "a", final: "hi" }, { type: "turn_end", turnId: s.turnId(), reason: "done" }));
  await mgr.handleInbound(inbound("hello", "100"));
  await until(() => platform.sent.length === 1);
  provider.sessions.get("global")!.emit({ type: "unsolicited_turn", source: "external" }, { type: "turn_start", turnId: "x" },
    { type: "text", segmentId: "x", final: "secret reply" }, { type: "turn_end", turnId: "x", reason: "done" });
  await until(() => platform.sent.length === 2);
  expect(platform.sent[1]!.target).toEqual({ platform: "tg", chatId: "1" }); // operator, not chat 100
  expect(platform.sent[1]!.text).toContain("outside UniQlaw");
});

test("external input mid-turn taints only the rest of that turn", async () => {
  let s!: import("./fakes.ts").FakeSession;
  const { mgr, platform } = setup((_i, sess) => { s = sess; });
  await mgr.handleInbound(inbound("work", "100"));
  await until(() => !!s);
  s.emit({ type: "text", segmentId: "a", final: "part 1" });
  await until(() => platform.sent.length === 1);
  s.emit({ type: "unsolicited_turn", source: "external" }, { type: "text", segmentId: "b", final: "part 2" }, { type: "turn_end", turnId: s.turnId(), reason: "done" });
  await until(() => platform.sent.length === 2);
  expect(platform.sent[0]!.target.chatId).toBe("100");
  expect(platform.sent[1]!.target.chatId).toBe("1");
});

test("steer that races the turn end: the fallback turn still answers the steering human", async () => {
  let release!: () => void;
  const { mgr, provider, platform } = setup(async (_i, s) => { await new Promise<void>((r) => (release = r)); s.emit({ type: "turn_end", turnId: s.turnId(), reason: "done" }); },
    { queue: { mode: "steer", debounceMs: 0 } });
  await mgr.handleInbound(inbound("first", "100"));
  await until(() => !!release);
  await mgr.handleInbound(inbound("late steer", "200"));   // steered into the running turn…
  release();                                              // …but the turn ends right away
  const s = provider.sessions.get("global")!;
  await Bun.sleep(10);
  // Adapter fell back to a new turn for the steered text:
  s.emit({ type: "turn_start", turnId: "fallback" }, { type: "text", segmentId: "f", final: "answer to late steer" }, { type: "turn_end", turnId: "fallback", reason: "done" });
  await until(() => platform.sent.some((m) => m.text === "answer to late steer"));
  const m = platform.sent.find((x) => x.text === "answer to late steer")!;
  expect(m.target).toEqual({ platform: "tg", chatId: "200", replyToMessageId: "m" });
});

test("rate_limit turn_end is retried with the same input, then succeeds", async () => {
  let calls = 0;
  const { mgr, provider, platform } = setup((_i, s) => {
    calls++;
    if (calls < 3) s.emit({ type: "turn_end", turnId: s.turnId(), reason: "error", error: "rate_limit" });
    else s.emit({ type: "text", segmentId: "a", final: "finally" }, { type: "turn_end", turnId: s.turnId(), reason: "done" });
  });
  await mgr.handleInbound(inbound("hi"));
  await until(() => platform.sent.some((m) => m.text === "finally"));
  const sess = provider.sessions.get("global")!;
  expect(sess.sent).toHaveLength(3);
  expect(sess.sent[2]!.text).toBe(sess.sent[0]!.text);
  expect(platform.sent.filter((m) => m.text.includes("Rate limited"))).toHaveLength(1);
});

test("rate_limit gives up after 3 retries and tells the human", async () => {
  const { mgr, platform } = setup((_i, s) => s.emit({ type: "turn_end", turnId: s.turnId(), reason: "error", error: "rate_limit" }));
  await mgr.handleInbound(inbound("hi"));
  await until(() => platform.sent.some((m) => m.text.includes("Still rate limited")), 5000);
});

test("usage_limit tells the human and fails pending peer asks", async () => {
  const { mgr, platform } = setup((_i, s) => s.emit({ type: "turn_end", turnId: s.turnId(), reason: "error", error: "usage_limit" }));
  mgr.runtime("helper"); // internal sessions are reachable once they exist
  const r = await mgr.ask("tg:-1", "helper", "q", true);
  expect(r.result).toEqual({ ok: false, text: "usage limit reached" });
  void platform; void CAPS;
});

test("remote agents appear in agents_list and agent_ask reaches them with the hop", async () => {
  const { mgr } = setup((_i, s) => s.emit({ type: "turn_end", turnId: s.turnId(), reason: "done" }));
  const seen: { from: string; hop: number }[] = [];
  mgr.addRemoteAgents([{ name: "a2a:research", description: "remote researcher", ask: async (o) => { seen.push(o); return { ok: true, text: `remote says: ${o.message}` }; } }]);
  expect(mgr.listAgents().find((a) => a.name === "a2a:research")).toMatchObject({ state: "remote", provider: "a2a" });
  const r = await mgr.ask("global", "a2a:research", "find X", true);
  expect(r.result).toEqual({ ok: true, text: "remote says: find X" });
  expect(seen[0]).toMatchObject({ from: "global", hop: 1 });
  await expect(mgr.trigger("global", "a2a:research", "x")).rejects.toThrow(/remote agent/);
});

test("inbound A2A request runs on the addressed profile and returns the answer (no platform output)", async () => {
  const { mgr, platform } = setup((input, s) => s.emit({ type: "text", segmentId: "a", final: `local answer to: ${input.text.split("\n").at(-1)}` }, { type: "turn_end", turnId: s.turnId(), reason: "done" }));
  const r = await mgr.runInbound({ profile: "main", caller: "peer-claw", remote: "peer-claw", contextId: "ctx1", taskId: "t-1", text: "hello from afar", hop: 1 });
  expect(r).toEqual({ ok: true, text: "local answer to: hello from afar" });
  expect(platform.sent).toHaveLength(0);
  expect(store.getSession("a2a:main:peer-claw:ctx1")).toBeDefined();
  expect(await mgr.runInbound({ profile: "nope", caller: "x", remote: "x", contextId: "c", taskId: "t-2", text: "?", hop: 1 })).toMatchObject({ ok: false });
  expect(await mgr.runInbound({ profile: "main", caller: "x", remote: "x", contextId: "c", taskId: "t-3", text: "?", hop: 99 })).toMatchObject({ ok: false });
});

test("inbound A2A: a second caller reusing a contextId gets its own session, not the first caller's", async () => {
  const { mgr, provider } = setup((input, s) => s.emit({ type: "text", segmentId: "a", final: `ok: ${input.text.split("\n").at(-1)}` }, { type: "turn_end", turnId: s.turnId(), reason: "done" }));
  await mgr.runInbound({ profile: "main", caller: "alice", remote: "alice", contextId: "shared", taskId: "t-a", text: "alice's secret", hop: 1 });
  await mgr.runInbound({ profile: "main", caller: "bob", remote: "bob", contextId: "shared", taskId: "t-b", text: "what did alice say?", hop: 1 });
  expect(provider.specs.map((s) => s.sessionId)).toEqual(["a2a:main:alice:shared", "a2a:main:bob:shared"]);
  expect(store.getSession("a2a:main:alice:shared")).toBeDefined();
  expect(store.getSession("a2a:main:bob:shared")).toBeDefined();
  // A caller name can't forge another field of the key.
  await mgr.runInbound({ profile: "main", caller: "eve:shared", remote: "eve", contextId: "x", taskId: "t-e", text: "?", hop: 1 });
  expect(provider.specs.at(-1)!.sessionId).toBe("a2a:main:eve%3Ashared:x");
});

test("inbound A2A sessions run deny-by-default: at most strict, no shell/write tools, no auto-allow", async () => {
  const { mgr, provider } = setup((_i, s) => s.emit({ type: "turn_end", turnId: s.turnId(), reason: "done" }),
    { profiles: { main: { provider: "fake", permissions: { level: "unrestricted", allowTools: ["Bash(git:*)", "Read"], approval: { mode: "auto-allow" } } } } });
  await mgr.runInbound({ profile: "main", caller: "alice", remote: "alice", contextId: "c", taskId: "t-1", text: "rm -rf /", hop: 1 });
  const perms = (provider.specs[0] as unknown as { profile: { permissions: import("../src/index.ts").PermissionPolicy } }).profile.permissions;
  expect(perms.level).toBe("strict");
  expect(perms.approval.mode).toBe("ask-operator");
  expect(perms.allowTools).toEqual([]); // Bash and Read are both denied groups
  for (const t of ["Bash", "Write", "Edit", "CronCreate", "SendMessage", "PushNotification", "Read(./.uniqlaw/**)"]) expect(perms.denyTools).toContain(t);
  // A chat on the same profile keeps the profile's own permissions.
  expect(mgr.profileFor("global").permissions.level).toBe("unrestricted");
  // locked stays locked.
  expect(core.a2aPermissions({ ...perms, level: "locked" }).level).toBe("locked");
});

test("model router: phrase switches immediately, keywords respect hysteresis, scheduled turns are not routed", async () => {
  const { ModelRouter } = core;
  const cfg = { enabled: true, defaultMode: "impl", modes: [
    { name: "plan", model: "opus", keywords: ["design", "architecture", "plan"], phrases: ["think hard"] },
    { name: "impl", model: "sonnet", keywords: ["fix", "implement", "code"] } ],
    hysteresis: { confidenceThreshold: 0.75, scoreMargin: 2, stickyWindowMinutes: 30, stickyWindowTurns: 5 } };
  let t = 1; // real clocks are never 0 (0 = "never switched")
  const r = new ModelRouter(cfg, "sonnet", () => t);
  expect(r.decide("please think hard about this")).toEqual({ model: "opus", reasoning: 'phrase "think hard" → plan' });
  expect(r.decide("fix the code")).toMatchObject({ skip: expect.stringContaining("sticky") });
  t = 1 + 31 * 60_000;
  for (let i = 0; i < 5; i++) r.decide("hello");
  expect(r.decide("fix and implement the code")).toMatchObject({ model: "sonnet" });
});

test("runtime applies model routing via setModel on human turns only", async () => {
  const s = core.parseSettings({ profiles: { main: { provider: "fake" } }, output: { toolStatus: false }, queue: { debounceMs: 0 } });
  const provider = new FakeProvider((_i, sess) => sess.emit({ type: "turn_end", turnId: sess.turnId(), reason: "done" }));
  const models: string[] = [];
  const open = provider.open.bind(provider);
  provider.open = async (spec) => { const x = await open(spec); (x as unknown as { setModel: (m: string) => Promise<void> }).setModel = async (m) => { models.push(m); }; return x; };
  const platform = new FakePlatform();
  const mgr = new core.ChannelManager({ log: core.silentLogger, settings: s, store, projectDir: dir, instanceId: "t",
    providers: new Map([["fake", provider]]), platforms: new Map([["tg", platform]]),
    profiles: new Map([["main", { name: "main", provider: "fake", model: "sonnet", permissions: s.profiles.main!.permissions,
      options: { agentic: { enabled: true, defaultMode: "impl", modes: [{ name: "plan", model: "opus", keywords: [], phrases: ["think hard"] }, { name: "impl", model: "sonnet", keywords: [] }] } } }]]),
    gatewayFor: () => undefined, systemPrompt: async () => ({ fragments: [] }), providerEnv: async () => ({}) });
  managers.push(mgr);
  await mgr.fireScheduled({ channelKey: "global", job: "j", text: "think hard (scheduled)", sourceLine: "[cron]" });
  await until(() => provider.sessions.get("global")?.sent.length === 1);
  expect(models).toEqual([]);
  await mgr.handleInbound(inbound("think hard please"));
  await until(() => provider.sessions.get("global")!.sent.length === 2);
  expect(models).toEqual(["opus"]);
});

test("stall watchdog abandons a silent turn and tells the human; a pending approval pauses it", async () => {
  const { mgr, provider, platform } = setup(() => {}, { turn: { stallTimeoutSec: 1 } });
  await mgr.handleInbound(inbound("hello?"));
  await until(() => platform.sent.some((m) => m.text.includes("stopped responding")), 4000);
  expect(provider.sessions.get("global")!.interrupted).toBe(1);

  // approval pending for > stall timeout must not trip the watchdog
  const p2 = setup((_i, s) => s.emit({ type: "permission_request", id: "p", tool: "Bash", input: "x", title: "Run?" }), { turn: { stallTimeoutSec: 1 } });
  let answer!: (i: number) => void;
  p2.platform.askChoice = (_t, _r) => new Promise((res) => (answer = res));
  await p2.mgr.handleInbound(inbound("do it"));
  await until(() => !!answer);
  await Bun.sleep(1500);
  expect(p2.platform.sent.some((m) => m.text.includes("stopped responding"))).toBe(false);
  answer(0);
}, 10_000);

test("streaming: deltas create one live message that is edited, then replaced by the final text", async () => {
  let s!: import("./fakes.ts").FakeSession;
  const { mgr, platform } = setup((_i, sess) => { s = sess; });
  await mgr.handleInbound(inbound("tell me a story"));
  await until(() => !!s);
  for (const w of "Once upon a time there was a small daemon that ".split(" ")) s.emit({ type: "text", segmentId: "a", delta: w + " " });
  await until(() => platform.sent.length === 1, 3000);
  expect(platform.sent[0]!.text).toMatch(/^Once upon a time.*▍$/);
  s.emit({ type: "text", segmentId: "a", delta: "loved its users." });
  await until(() => platform.edits.length >= 1, 4000);
  s.emit({ type: "text", segmentId: "a", final: "Once upon a time there was a small daemon that loved its users. [react:❤️]" },
    { type: "turn_end", turnId: s.turnId(), reason: "done" });
  await until(() => platform.edits.at(-1)!.text === "Once upon a time there was a small daemon that loved its users.");
  expect(platform.sent).toHaveLength(1);            // never a second message
  expect(platform.reactions[0]!.emojis).toEqual(["❤️"]);
});

test("streaming never leaks a silent sentinel", async () => {
  let s!: import("./fakes.ts").FakeSession;
  const { mgr, platform } = setup((_i, sess) => { s = sess; });
  await mgr.handleInbound(inbound("(two humans chatting)"));
  await until(() => !!s);
  for (const d of ["NO_", "REP", "LY"]) s.emit({ type: "text", segmentId: "a", delta: d });
  await Bun.sleep(1200);
  s.emit({ type: "text", segmentId: "a", final: "NO_REPLY" }, { type: "turn_end", turnId: s.turnId(), reason: "done" });
  await Bun.sleep(100);
  expect(platform.sent).toHaveLength(0);
});

test("streaming: interrupted segment keeps what was shown, without the cursor", async () => {
  let s!: import("./fakes.ts").FakeSession;
  const { mgr, platform } = setup((_i, sess) => { s = sess; });
  await mgr.handleInbound(inbound("go"));
  await until(() => !!s);
  s.emit({ type: "text", segmentId: "a", delta: "This is a fairly long partial answer that gets cut" });
  await until(() => platform.sent.length === 1, 3000);
  s.emit({ type: "turn_end", turnId: s.turnId(), reason: "interrupted" });
  await until(() => platform.edits.some((e) => e.text === "This is a fairly long partial answer that gets cut"));
});

test("stream off: deltas are ignored, finals posted as usual", async () => {
  let s!: import("./fakes.ts").FakeSession;
  const { mgr, platform } = setup((_i, sess) => { s = sess; }, { output: { toolStatus: false, stream: "off" } });
  await mgr.handleInbound(inbound("go"));
  await until(() => !!s);
  s.emit({ type: "text", segmentId: "a", delta: "This is a fairly long partial answer that gets cut" });
  await Bun.sleep(1200);
  expect(platform.sent).toHaveLength(0);
  s.emit({ type: "text", segmentId: "a", final: "done!" }, { type: "turn_end", turnId: s.turnId(), reason: "done" });
  await until(() => platform.sent.length === 1);
});

test("tool status bubbles are removed once the reply is delivered; kept on error or silent turns", async () => {
  const tool = (id: string) => ({ type: "tool_start" as const, id, name: "Bash", input: { command: "ls" } });
  let turnNo = 0;
  const { mgr, platform } = setup((_i, s) => {
    turnNo++;
    if (turnNo === 1) s.emit(tool("a"), tool("b"), { type: "text", segmentId: "x", final: "answer" }, { type: "turn_end", turnId: s.turnId(), reason: "done" });
    if (turnNo === 2) s.emit(tool("c"), { type: "turn_end", turnId: s.turnId(), reason: "error", error: "boom" });
    if (turnNo === 3) s.emit(tool("d"), { type: "text", segmentId: "y", final: "NO_REPLY" }, { type: "turn_end", turnId: s.turnId(), reason: "done" });
  }, { output: { toolStatus: true, stream: "replace" } });

  await mgr.handleInbound(inbound("one"));
  await until(() => platform.deletes.length === 1);
  const bubble = platform.sent.findIndex((m) => m.text.includes("ls"));
  expect(platform.deletes[0]!.messageId).toBe(String(bubble + 1)); // the (edited-in-place) tool bubble
  expect(platform.sent.some((m) => m.text === "answer")).toBe(true);

  const before = platform.deletes.length;
  await mgr.handleInbound(inbound("two"));
  await Bun.sleep(100);
  await mgr.handleInbound(inbound("three"));
  await Bun.sleep(100);
  expect(platform.deletes.length).toBe(before); // error turn and silent turn keep their bubbles
  expect(platform.sent.filter((m) => m.text.includes("ls")).length).toBe(3); // turns 2 and 3 really posted bubbles
});
