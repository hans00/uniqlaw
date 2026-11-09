// A turn still running in the provider when the daemon detaches (restart / reload) is reattached on
// restore, and its reply goes to the chat that asked — not dropped, not treated as background output.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChannelManager, StateStore, parseSettings, silentLogger, type Profile } from "../src/index.ts";
import { CAPS, FakePlatform, FakeProvider, FakeSession } from "./fakes.ts";

let dir: string;
let store: StateStore;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "uq-inflight-")); store = new StateStore(join(dir, "state.db")); });
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
const until = async (cond: () => boolean, ms = 2000) => { const end = Date.now() + ms; while (!cond()) { if (Date.now() > end) throw new Error("timeout"); await Bun.sleep(5); } };

/** A provider whose sessions survive detach (like claude-tmux). */
class DetachableSession extends FakeSession { detached = false; detach() { this.detached = true; } }
function manager(provider: FakeProvider, platform: FakePlatform) {
  const s = parseSettings({ profiles: { main: { provider: "fake" } }, queue: { debounceMs: 0 }, backgroundNotify: { mode: "off" } });
  const prof: Profile = { name: "main", provider: "fake", permissions: s.profiles.main!.permissions, options: {} };
  return new ChannelManager({
    log: silentLogger, settings: s, store, projectDir: dir, instanceId: "test",
    providers: new Map([["fake", provider]]), platforms: new Map([["tg", platform]]), profiles: new Map([["main", prof]]),
    gatewayFor: () => undefined, providerEnv: async () => ({}), systemPrompt: async () => ({ fragments: [] }),
  });
}

test("reply of a turn interrupted by a daemon restart reaches the original chat", async () => {
  const platform = new FakePlatform();
  const p1 = new FakeProvider(() => { /* keeps working: no turn_end before the restart */ }, { ...CAPS });
  p1.open = async (spec: { sessionId: string }) => {
    const s = new DetachableSession(CAPS, () => {});
    p1.sessions.set(spec.sessionId, s);
    s.emit({ type: "session", providerSessionId: "p-1" });
    return s;
  };
  const m1 = manager(p1, platform);
  await m1.handleInbound({ platform: "tg", channelKey: "tg:7", replyTarget: { platform: "tg", chatId: "7" }, ref: { platform: "tg", chatId: "7", messageId: "42" },
    sender: { id: "7", name: "u" }, trusted: true, multiparty: false, text: "long task", attachments: [], receivedAt: Date.now() });
  await until(() => (p1.sessions.get("tg:7")?.sent.length ?? 0) === 1);
  await m1.stop(); // detach while the turn runs
  expect((p1.sessions.get("tg:7") as DetachableSession).detached).toBe(true);

  // New daemon: the reattached provider session is still mid-turn and finishes it.
  const p2 = new FakeProvider(() => {}, CAPS);
  p2.open = async (spec: { sessionId: string }) => {
    const s = new FakeSession(CAPS, () => {});
    p2.sessions.set(spec.sessionId, s);
    s.emit({ type: "session", providerSessionId: "p-1" }, { type: "unsolicited_turn" }, { type: "text", segmentId: "a", final: "done!" },
      { type: "turn_end", turnId: "x", reason: "done" });
    return s;
  };
  const m2 = manager(p2, platform);
  await m2.restore(); // reopens right away, no inbound message needed
  await until(() => platform.sent.some((x) => x.text === "done!"));
  const sent = platform.sent.find((x) => x.text === "done!")!;
  expect(sent.target).toMatchObject({ chatId: "7", replyToMessageId: "42" });
  expect(store.get("inflight-turn:tg:7")).toBeUndefined();
  await m2.stop();
});
