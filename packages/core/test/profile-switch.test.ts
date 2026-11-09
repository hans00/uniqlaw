// Profile switching: usage limit → the owner is asked (others get the error); /profile switches and back;
// the conversation moves as raw transcript (handoff), or resumes the earlier session with what happened meanwhile.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChannelManager, StateStore, TranscriptStore, parseSettings, silentLogger, type InboundMessage, type Profile } from "../src/index.ts";
import { CAPS, FakePlatform, FakeProvider, type Script } from "./fakes.ts";

let dir: string;
let store: StateStore;
let mgr: ChannelManager;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "uq-switch-")); store = new StateStore(join(dir, "state.db")); });
afterEach(async () => { await mgr.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); });
const until = async (cond: () => boolean, ms = 2000) => { const end = Date.now() + ms; while (!cond()) { if (Date.now() > end) throw new Error("timeout"); await Bun.sleep(5); } };

/** Replies "<tag>:<last line>", or fails with usage_limit when the prompt says LIMIT. */
const scripted = (tag: string): Script => (input, s) => {
  if (input.text.trim().split("\n").at(-1)!.includes("LIMIT") && tag === "A") { s.emit({ type: "turn_end", turnId: s.turnId(), reason: "error", error: "usage_limit" }); return; }
  s.emit({ type: "text", segmentId: "x", final: `${tag}:${input.text.trim().split("\n").at(-1)}` }, { type: "turn_end", turnId: s.turnId(), reason: "done" });
};

function setup() {
  const s = parseSettings({ profiles: { main: { provider: "pa", fallback: ["backup"] }, backup: { provider: "pb" } }, output: { toolStatus: false }, queue: { debounceMs: 0 } });
  const a = new FakeProvider(scripted("A"), CAPS);
  const b = new FakeProvider(scripted("B"), CAPS);
  const platform = new FakePlatform();
  const prof = (name: string, provider: string, fallback?: string[]): Profile => ({ name, provider, permissions: s.profiles.main!.permissions, options: {}, ...(fallback ? { fallback } : {}) });
  mgr = new ChannelManager({
    log: silentLogger, settings: s, store, transcript: new TranscriptStore(store), projectDir: dir, instanceId: "test",
    providers: new Map([["pa", a], ["pb", b]]), platforms: new Map([["tg", platform]]),
    profiles: new Map([["main", prof("main", "pa", ["backup"])], ["backup", prof("backup", "pb")]]),
    gatewayFor: () => undefined, providerEnv: async () => ({}), systemPrompt: async () => ({ fragments: [] }),
  });
  return { a, b, platform };
}
let n = 0;
const msg = (text: string, trusted = true): InboundMessage => ({ platform: "tg", channelKey: "tg:1", replyTarget: { platform: "tg", chatId: "1" },
  ref: { platform: "tg", chatId: "1", messageId: String(++n) }, sender: { id: "1", name: "Owner" }, trusted, multiparty: false, text, attachments: [], receivedAt: Date.now() });

test("usage limit: owner picks the fallback; the chat moves with a raw handoff and the failed message is re-sent", async () => {
  const { a, b, platform } = setup();
  await mgr.handleInbound(msg("hello there"));
  await until(() => platform.sent.some((x) => x.text === "A:Message: hello there"));
  platform.choiceAnswer = 0;
  await mgr.handleInbound(msg("please LIMIT"));
  await until(() => (b.sessions.get("tg:1")?.sent.length ?? 0) === 1);
  expect(platform.choices[0]).toMatchObject({ options: ["Switch to backup", "Not now"], approverIds: ["1"] });
  const first = b.sessions.get("tg:1")!.sent[0]!.text;
  expect(first).toContain('[Handover: this chat was running on profile "main" (pa)');
  expect(first).toContain("hello there");
  expect(first).toContain("A:Message: hello there");
  expect(first.indexOf("please LIMIT")).toBeGreaterThan(first.indexOf("[End of transcript]")); // re-sent after the transcript, not inside it
  await until(() => platform.sent.some((x) => x.text.startsWith("🔀 Switched to **backup**")));
  expect(platform.sent.some((x) => x.text.startsWith("⛔"))).toBe(false);
  expect(mgr.profileFor("tg:1").name).toBe("backup");

  // Back to main: its old provider session is resumed and gets what ran meanwhile.
  await until(() => platform.sent.some((x) => x.text.startsWith("B:")));
  await mgr.handleInbound(msg("/profile reset"));
  expect(platform.sent.at(-1)!.text).toContain("resumed its earlier session");
  await mgr.handleInbound(msg("and now?"));
  await until(() => (a.sessions.get("tg:1")?.sent.length ?? 0) >= 1 && a.specs.length === 2);
  expect(a.specs[1]!.providerSessionId).toBe("p-tg:1");
  const back = a.sessions.get("tg:1")!.sent.at(-1)!.text;
  expect(back).toContain('[While you were away, this chat ran on profile "backup" (pb)');
  expect(back).toContain("B:");
  expect(back).not.toContain("hello there"); // only what happened since main's last turn
  expect(mgr.profileFor("tg:1").name).toBe("main");
});

test("usage limit for a non-owner is reported as an error; nobody is asked", async () => {
  const { platform } = setup();
  await mgr.handleInbound(msg("LIMIT", false));
  await until(() => platform.sent.some((x) => x.text.startsWith("⛔")));
  expect(platform.sent.at(-1)!.text).toContain('usage limit of profile "main"');
  expect(platform.choices).toHaveLength(0);
});

test("/profile lists and refuses unknown profiles; untrusted /profile is a normal message", async () => {
  const { a, platform } = setup();
  await mgr.handleInbound(msg("/profile"));
  expect(platform.sent.at(-1)!.text).toContain("Profile: **main** (pa)");
  await mgr.handleInbound(msg("/profile nope"));
  expect(platform.sent.at(-1)!.text).toContain('unknown profile "nope"');
  await mgr.handleInbound(msg("/profile backup", false));
  await until(() => (a.sessions.get("tg:1")?.sent.length ?? 0) === 1);
  expect(mgr.profileFor("tg:1").name).toBe("main");
});

test("profiles on providers that share sessions carry the provider session over (no handoff)", async () => {
  const s = parseSettings({ profiles: { main: { provider: "pa" }, big: { provider: "pa", model: "large" } }, output: { toolStatus: false }, queue: { debounceMs: 0 } });
  const a = new FakeProvider(scripted("A"), CAPS);
  const platform = new FakePlatform();
  const prof = (name: string, model?: string): Profile => ({ name, provider: "pa", permissions: s.profiles.main!.permissions, options: {}, ...(model ? { model } : {}) });
  mgr = new ChannelManager({
    log: silentLogger, settings: s, store, transcript: new TranscriptStore(store), projectDir: dir, instanceId: "test",
    providers: new Map([["pa", a]]), platforms: new Map([["tg", platform]]), profiles: new Map([["main", prof("main")], ["big", prof("big", "large")]]),
    gatewayFor: () => undefined, providerEnv: async () => ({}), systemPrompt: async () => ({ fragments: [] }),
  });
  await mgr.handleInbound(msg("first"));
  await until(() => platform.sent.some((x) => x.text.startsWith("A:")));
  await mgr.handleInbound(msg("/profile big"));
  expect(platform.sent.at(-1)!.text).toContain("same conversation");
  await mgr.handleInbound(msg("second"));
  await until(() => a.specs.length === 2 && (a.sessions.get("tg:1")?.sent.length ?? 0) === 1);
  expect(a.specs[1]).toMatchObject({ providerSessionId: "p-tg:1", profile: { name: "big", model: "large" } });
  expect(a.sessions.get("tg:1")!.sent[0]!.text).not.toContain("Handover");
});
