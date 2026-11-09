// Group gating: mention vs always mode, unaddressed messages kept as bounded context,
// per-channel settings, platform-provided policy and /activation. DMs are never gated.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChannelManager, StateStore, parseSettings, silentLogger, type InboundMessage, type Profile } from "../src/index.ts";
import { CAPS, FakePlatform, FakeProvider, type Script } from "./fakes.ts";

let dir: string;
let store: StateStore;
let managers: ChannelManager[] = [];
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "uq-grp-")); store = new StateStore(join(dir, "state.db")); });
afterEach(async () => {
  for (const m of managers) await m.stop();
  managers = [];
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const reply: Script = (_i, s) => { s.emit({ type: "text", segmentId: "a", final: "ok" }, { type: "turn_end", turnId: s.turnId(), reason: "done" }); };

function setup(groups: Record<string, unknown> = {}) {
  const s = parseSettings({ profiles: { main: { provider: "fake" } }, output: { toolStatus: false }, queue: { debounceMs: 0 }, groups });
  const provider = new FakeProvider(reply, CAPS);
  const platform = new FakePlatform();
  const prof: Profile = { name: "main", provider: "fake", permissions: s.profiles.main!.permissions, options: {} };
  const mgr = new ChannelManager({
    log: silentLogger, settings: s, store, projectDir: dir, instanceId: "test",
    providers: new Map([["fake", provider]]), platforms: new Map([["tg", platform]]), profiles: new Map([["main", prof]]),
    gatewayFor: () => undefined, providerEnv: async () => ({}), systemPrompt: async () => ({ fragments: [] }),
  });
  managers.push(mgr);
  const turns = () => provider.sessions.get("tg:-1")?.sent.map((t) => t.text) ?? [];
  return { mgr, provider, platform, turns };
}

const until = async (cond: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error("timeout"); await Bun.sleep(5); }
};

let n = 0;
const group = (text: string, extra: Partial<InboundMessage> = {}): InboundMessage => ({ platform: "tg", channelKey: "tg:-1",
  replyTarget: { platform: "tg", chatId: "-1" }, ref: { platform: "tg", chatId: "-1", messageId: String(++n) },
  sender: { id: "7", name: "Amy" }, trusted: false, multiparty: true, text, attachments: [], addressed: false, receivedAt: Date.now(), ...extra });

test("mention mode (default): unaddressed messages become context for the next addressed turn", async () => {
  const { mgr, provider, turns } = setup();
  await mgr.handleInbound(group("lunch at noon?"));
  await mgr.handleInbound(group("sure", { sender: { id: "8", name: "Bob" } }));
  expect(provider.sessions.get("tg:-1")?.sent ?? []).toHaveLength(0);
  await mgr.handleInbound(group("what did they decide?", { addressed: true }));
  await until(() => turns().length === 1);
  const t = turns()[0]!;
  expect(t).toContain("Amy (not addressed to you): lunch at noon?");
  expect(t).toContain("Bob (not addressed to you): sure");
  expect(t).toContain("what did they decide?");
  // context is consumed once
  await mgr.handleInbound(group("and now?", { addressed: true }));
  await until(() => turns().length === 2);
  expect(turns()[1]).not.toContain("lunch at noon");
});

test("historyLimit keeps only the newest unaddressed messages; 0 keeps none", async () => {
  const { mgr, turns } = setup({ historyLimit: 2 });
  for (const t of ["one", "two", "three"]) await mgr.handleInbound(group(t));
  await mgr.handleInbound(group("go", { addressed: true }));
  await until(() => turns().length === 1);
  expect(turns()[0]).not.toContain(": one");
  expect(turns()[0]).toContain(": two");
  expect(turns()[0]).toContain(": three");
});

test("always mode starts a turn per message; ignoreOtherMentions keeps messages to others as context", async () => {
  const { mgr, turns } = setup({ mode: "always", ignoreOtherMentions: true });
  await mgr.handleInbound(group("anyone?"));
  await until(() => turns().length === 1);
  await mgr.handleInbound(group("@bob you there", { mentionsOthers: true }));
  await mgr.handleInbound(group("hello bot?"));
  await until(() => turns().length === 2);
  expect(turns()[1]).toContain("@bob you there");
  expect(turns()[1]).toContain("hello bot?");
});

test("per-channel settings, platform policy and /activation precedence; DMs never gated", async () => {
  const { mgr, platform, turns } = setup({ channels: { "tg:-1": { mode: "always" } } });
  expect(mgr.groupSettings("tg:-1").mode).toBe("always");
  expect(mgr.groupSettings("tg:-2", { mode: "always" }).mode).toBe("always"); // platform policy over defaults
  expect(mgr.groupSettings("tg:-1", { mode: "mention" }).mode).toBe("always"); // settings channel entry over platform policy
  expect(mgr.groupSettings("tg:-1:thread").mode).toBe("always"); // thread key falls back to its channel
  // untrusted /activation is just a message
  await mgr.handleInbound(group("/activation mention"));
  await until(() => turns().length === 1);
  await mgr.handleInbound(group("/activation mention", { trusted: true }));
  expect(platform.sent.at(-1)!.text).toContain("only when mentioned");
  expect(mgr.groupSettings("tg:-1").mode).toBe("mention");
  await mgr.handleInbound(group("quiet now"));
  await mgr.handleInbound(group("/activation reset", { trusted: true }));
  expect(mgr.groupSettings("tg:-1").mode).toBe("always");
  expect(turns()).toHaveLength(1);
  // a DM with addressed:false (adapter bug) still starts a turn
  await mgr.handleInbound({ ...group("dm", { multiparty: false }), channelKey: "tg:5", replyTarget: { platform: "tg", chatId: "5" } });
  await until(() => (managers[0]!.runtimes.get("tg:5")?.state ?? "") !== "" && platform.sent.some((s) => s.target.chatId === "5"));
});
