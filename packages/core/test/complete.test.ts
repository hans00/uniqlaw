// ChannelManager.complete(): a plugin runs one turn in an internal session and gets the final reply
// (used by the dreaming sweep). noteToOpenChats(): a note for every open chat session.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChannelManager, StateStore, parseSettings, silentLogger, type Profile } from "../src/index.ts";
import { CAPS, FakePlatform, FakeProvider, type Script } from "./fakes.ts";

let dir: string;
let store: StateStore;
let mgr: ChannelManager | undefined;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "uq-complete-")); store = new StateStore(join(dir, "state.db")); });
afterEach(async () => { await mgr?.stop(); mgr = undefined; store.close(); rmSync(dir, { recursive: true, force: true }); });

function setup(script: Script) {
  const s = parseSettings({ profiles: { main: { provider: "fake" }, cheap: { provider: "fake", model: "small" } }, output: { toolStatus: false }, queue: { debounceMs: 0 } });
  const provider = new FakeProvider(script, CAPS);
  const platform = new FakePlatform();
  const prof = (name: string, model?: string): Profile => ({ name, provider: "fake", ...(model ? { model } : {}), permissions: s.profiles.main!.permissions, options: {} });
  mgr = new ChannelManager({
    log: silentLogger, settings: s, store, projectDir: dir, instanceId: "test",
    providers: new Map([["fake", provider]]), platforms: new Map([["tg", platform]]),
    profiles: new Map([["main", prof("main")], ["cheap", prof("cheap", "small")]]),
    gatewayFor: () => undefined, providerEnv: async () => ({}), systemPrompt: async () => ({ fragments: [] }),
  });
  return { mgr, provider, platform };
}
const dm = (chatId: string, text: string) => ({ platform: "tg", channelKey: `tg:${chatId}`, replyTarget: { platform: "tg", chatId }, ref: { platform: "tg", chatId, messageId: "m" },
  sender: { id: chatId, name: "u" + chatId }, trusted: true, multiparty: false, text, attachments: [], receivedAt: Date.now() });
const reply: Script = (input, s) => s.emit({ type: "text", segmentId: "a", final: `answer to: ${input.text.split("\n").at(-1)}` }, { type: "turn_end", turnId: s.turnId(), reason: "done" });

test("complete() returns the reply, posts nothing, and fresh starts a new provider session on the pinned profile", async () => {
  const { mgr, provider, platform } = setup(reply);
  const a = await mgr.complete({ channelKey: "dream", job: "dreaming:consolidate", text: "first prompt", profile: "cheap", fresh: true });
  expect(a).toEqual({ ok: true, text: "answer to: first prompt" });
  const b = await mgr.complete({ channelKey: "dream", job: "dreaming:diary", text: "second prompt", profile: "cheap", fresh: true });
  expect(b.text).toBe("answer to: second prompt");
  const opens = provider.specs.filter((x) => x.sessionId === "dream");
  expect(opens).toHaveLength(2);
  expect(opens.every((x) => x.profile?.name === "cheap" && !x.providerSessionId)).toBe(true);
  expect(platform.sent).toHaveLength(0);
  await expect(mgr.complete({ channelKey: "tg:1", job: "x", text: "y" })).rejects.toThrow("internal sessions only");
});

test("a failed turn resolves ok:false and doesn't message the operator", async () => {
  const { mgr, platform } = setup((_i, s) => s.emit({ type: "turn_end", turnId: s.turnId(), reason: "error", error: "boom" }));
  const r = await mgr.complete({ channelKey: "dream", job: "dreaming:consolidate", text: "go" });
  expect(r.ok).toBe(false);
  expect(r.text).toContain("boom");
  await Bun.sleep(20);
  expect(platform.sent).toHaveLength(0);
});

test("noteToOpenChats reaches open chat sessions only", async () => {
  const { mgr } = setup(reply);
  await mgr.handleInbound(dm("1", "hello"));
  for (let i = 0; i < 100 && mgr.isBusy("tg:1"); i++) await Bun.sleep(5);
  await mgr.complete({ channelKey: "heartbeat", job: "x", text: "ping" });
  expect(mgr.noteToOpenChats("UniQlaw memory", "MEMORY.md changed")).toBe(1);
  expect(store.countPending("tg:1")).toBe(1);
  expect(store.countPending("heartbeat")).toBe(0);
});
