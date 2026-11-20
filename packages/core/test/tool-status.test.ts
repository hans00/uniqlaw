// Tool-status message: one per turn, edited in place at the platform's pace (no new message per tool call, not even
// when an edit is rate limited); always removed when the turn ends; shown by default only for a human's own turns
// outside group chats (output.toolStatus / channels.<key>.toolStatus).
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChannelManager, StateStore, parseSettings, silentLogger, type AgentEvent, type InboundMessage, type MsgRef } from "../src/index.ts";
import { FakePlatform, FakeProvider, type FakeSession, type Script } from "./fakes.ts";

let dir: string;
let store: StateStore;
let managers: ChannelManager[] = [];
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "uq-status-")); store = new StateStore(join(dir, "state.db")); });
afterEach(async () => { for (const m of managers) await m.stop(); managers = []; store.close(); rmSync(dir, { recursive: true, force: true }); });
const until = async (c: () => boolean, ms = 3000) => { const e = Date.now() + ms; while (!c()) { if (Date.now() > e) throw new Error("timeout"); await Bun.sleep(5); } };

/** Discord-like: edits paced, and the first `failEdits` edits fail (429 retries used up). */
class PacedPlatform extends FakePlatform {
  failEdits = 0;
  sendDelayMs = 0;
  constructor(editIntervalMs: number) { super(); this.capabilities = { ...this.capabilities, editIntervalMs } as typeof this.capabilities; }
  override async send(target: import("../src/index.ts").Target, text: string) {
    if (this.sendDelayMs) await Bun.sleep(this.sendDelayMs);
    return super.send(target, text);
  }
  override async edit(ref: MsgRef, text: string) {
    if (this.failEdits > 0) { this.failEdits--; return false; }
    return super.edit(ref, text);
  }
}

function setup(script: Script, o: { settings?: Record<string, unknown>; platform?: FakePlatform } = {}) {
  const s = parseSettings({ profiles: { main: { provider: "fake" } }, queue: { debounceMs: 0 }, groups: { mode: "always" }, ...o.settings });
  const provider = new FakeProvider(script);
  const platform = o.platform ?? new FakePlatform();
  const mgr = new ChannelManager({ log: silentLogger, settings: s, store, projectDir: dir, instanceId: "t",
    providers: new Map([["fake", provider]]), platforms: new Map([["tg", platform]]),
    profiles: new Map([["main", { name: "main", provider: "fake", permissions: s.profiles.main!.permissions, options: {} }]]),
    gatewayFor: () => undefined, systemPrompt: async () => ({ fragments: [] }), providerEnv: async () => ({}) });
  managers.push(mgr);
  return { mgr, provider, platform };
}
let n = 0;
const dm = (text: string, chatId = "100"): InboundMessage => ({ platform: "tg", channelKey: `tg:${chatId}`, replyTarget: { platform: "tg", chatId },
  ref: { platform: "tg", chatId, messageId: `m${++n}` }, sender: { id: "7", name: "Hans" }, trusted: true, multiparty: false, text, attachments: [], receivedAt: Date.now() });
const group = (text: string): InboundMessage => ({ ...dm(text, "-5"), multiparty: true, addressed: true });
const tool = (id: string, command = `cmd-${id}`): AgentEvent => ({ type: "tool_start", id, name: "Bash", input: { command } });
const isStatus = (t: string) => t.includes("cmd-");

// ── 1. one message per turn, edited in place, at the platform's pace ─────────────────────────────

test("a burst of tool calls is one status message; edits are coalesced to editIntervalMs", async () => {
  let s!: FakeSession;
  const platform = new PacedPlatform(200);
  const { mgr } = setup((_i, sess) => { s = sess; }, { platform });
  await mgr.handleInbound(dm("go"));
  await until(() => !!s);
  for (let i = 1; i <= 12; i++) { s.emit(tool(String(i))); await Bun.sleep(10); }
  await Bun.sleep(700);
  expect(platform.sent.filter((m) => isStatus(m.text))).toHaveLength(1);
  // 12 calls over ~120 ms + the wait: a handful of edits, not 11; the last one shows the newest call.
  expect(platform.edits.length).toBeGreaterThanOrEqual(1);
  expect(platform.edits.length).toBeLessThanOrEqual(4);
  expect(platform.edits.at(-1)!.text).toContain("cmd-12");
  expect(platform.edits.at(-1)!.text.split("\n")).toHaveLength(8); // latest 8 calls
  for (let i = 1; i < platform.edits.length; i++) expect(platform.edits[i]!.ref).toEqual(platform.edits[0]!.ref);
  s.emit({ type: "turn_end", turnId: s.turnId(), reason: "done" });
});

test("a rate-limited edit is retried later, never replaced by a new message", async () => {
  let s!: FakeSession;
  const platform = new PacedPlatform(50);
  platform.failEdits = 2;
  const { mgr } = setup((_i, sess) => { s = sess; }, { platform });
  await mgr.handleInbound(dm("go"));
  await until(() => !!s);
  s.emit(tool("1"));
  await until(() => platform.sent.length === 1);
  s.emit(tool("2"));
  await until(() => platform.edits.some((e) => e.text.includes("cmd-2")), 3000);
  expect(platform.sent.filter((m) => isStatus(m.text))).toHaveLength(1);
  s.emit({ type: "turn_end", turnId: s.turnId(), reason: "done" });
});

test("one status message per turn, also across text between tool calls", async () => {
  const { mgr, platform } = setup((_i, s) => s.emit(tool("1"), { type: "text", segmentId: "a", final: "looking…" }, tool("2"),
    { type: "text", segmentId: "b", final: "answer" }, { type: "turn_end", turnId: s.turnId(), reason: "done" }), { settings: { output: { stream: "off" } } });
  await mgr.handleInbound(dm("go"));
  await until(() => platform.deletes.length === 1);
  expect(platform.sent.filter((m) => isStatus(m.text))).toHaveLength(1);
});

// ── 2. always removed when the turn ends ───────────────────────────────────────────────────────

test("the status message is deleted however the turn ends: reply, NO_REPLY, nothing, reaction only, error, interrupt", async () => {
  const endings: AgentEvent[][] = [
    [{ type: "text", segmentId: "x", final: "answer" }, { type: "turn_end", turnId: "", reason: "done" }],
    [{ type: "text", segmentId: "x", final: "NO_REPLY" }, { type: "turn_end", turnId: "", reason: "done" }],
    [{ type: "turn_end", turnId: "", reason: "done" }],
    [{ type: "text", segmentId: "x", final: "[react:👍]" }, { type: "turn_end", turnId: "", reason: "done" }],
    [{ type: "turn_end", turnId: "", reason: "error", error: "boom" }],
    [{ type: "turn_end", turnId: "", reason: "interrupted" }],
  ];
  let turn = 0;
  const { mgr, platform } = setup((_i, s) => {
    const evs = endings[turn++]!.map((e) => (e.type === "turn_end" ? { ...e, turnId: s.turnId() } : e));
    s.emit(tool(String(turn)), ...evs);
  });
  for (let i = 0; i < endings.length; i++) {
    await mgr.handleInbound(dm(`turn ${i}`));
    await until(() => platform.deletes.length === i + 1);
  }
  const bubbles = platform.sent.map((m, i) => ({ ...m, id: String(i + 1) })).filter((m) => isStatus(m.text));
  expect(bubbles).toHaveLength(endings.length);
  expect(platform.deletes.map((d) => d.messageId).sort()).toEqual(bubbles.map((b) => b.id).sort());
});

test("a status message still being posted when the turn ends is deleted once it lands; nothing more is shown", async () => {
  let s!: FakeSession;
  const platform = new PacedPlatform(0);
  platform.sendDelayMs = 150;
  const { mgr } = setup((_i, sess) => { s = sess; }, { platform });
  await mgr.handleInbound(dm("go"));
  await until(() => !!s);
  s.emit(tool("1"), { type: "turn_end", turnId: s.turnId(), reason: "done" });
  await until(() => platform.deletes.length === 1, 2000);
  expect(platform.sent.filter((m) => isStatus(m.text))).toHaveLength(1);
  await Bun.sleep(100);
  expect(platform.edits).toHaveLength(0);
});

test("the status message goes when the session is closed or detached mid-turn (/new, restart drain)", async () => {
  let s!: FakeSession;
  const { mgr, platform } = setup((_i, sess) => { s = sess; });
  await mgr.handleInbound(dm("go"));
  await until(() => !!s);
  s.emit(tool("1"));
  await until(() => platform.sent.length === 1);
  await mgr.stop();
  await until(() => platform.deletes.length === 1);
});

// ── 3. who sees it: auto / on / off, per chat ─────────────────────────────────────────────────

const toolTurn: Script = (_i, s) => s.emit(tool("1"), { type: "text", segmentId: "x", final: "done" }, { type: "turn_end", turnId: s.turnId(), reason: "done" });

test("auto (default): a human DM gets status; a group chat, a cron job and an agent_trigger don't", async () => {
  const { mgr, platform } = setup(toolTurn);
  await mgr.handleInbound(dm("hi"));
  await until(() => platform.sent.some((m) => m.text === "done"));
  expect(platform.sent.filter((m) => isStatus(m.text))).toHaveLength(1);

  await mgr.handleInbound(group("hi all"));
  await mgr.fireScheduled({ channelKey: "cron:j", job: "j", text: "check", sourceLine: "[cron]", deliverTo: "tg:100" });
  await mgr.trigger("tg:100", "tg:200", "do it", { platform: "tg", chatId: "200" });
  await until(() => platform.sent.filter((m) => m.text === "done").length === 4);
  await Bun.sleep(50);
  expect(platform.sent.filter((m) => isStatus(m.text))).toHaveLength(1);
});

test("output.toolStatus true is auto; false and \"off\" hide it; \"on\" shows it for cron and groups too", async () => {
  for (const [value, expected] of [[true, 1], [false, 0], ["off", 0], ["on", 3]] as const) {
    const { mgr, platform } = setup(toolTurn, { settings: { output: { toolStatus: value } } });
    await mgr.handleInbound(dm("hi"));
    await mgr.handleInbound(group("hi all"));
    await mgr.fireScheduled({ channelKey: "cron:j", job: "j", text: "check", sourceLine: "[cron]", deliverTo: "tg:100" });
    await until(() => platform.sent.filter((m) => m.text === "done").length === 3);
    await Bun.sleep(50);
    expect([value, platform.sent.filter((m) => isStatus(m.text)).length]).toEqual([value, expected]);
  }
});

test("channels.<key>.toolStatus overrides per chat (and channels.defaults for all)", async () => {
  const { mgr, platform } = setup(toolTurn, { settings: { channels: { "tg:-5": { toolStatus: "on" }, "tg:100": { toolStatus: "off" } } } });
  await mgr.handleInbound(dm("hi"));
  await mgr.handleInbound(group("hi all"));
  await until(() => platform.sent.filter((m) => m.text === "done").length === 2);
  await Bun.sleep(50);
  const status = platform.sent.filter((m) => isStatus(m.text));
  expect(status.map((m) => m.target.chatId)).toEqual(["-5"]);

  const b = setup(toolTurn, { settings: { channels: { defaults: { toolStatus: "off" } } } });
  await b.mgr.handleInbound(dm("hi"));
  await until(() => b.platform.sent.some((m) => m.text === "done"));
  expect(b.platform.sent.filter((m) => isStatus(m.text))).toHaveLength(0);
});
