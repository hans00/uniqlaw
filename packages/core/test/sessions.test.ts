// Per-chat DM sessions, internal sessions (heartbeat / cron jobs) with their own profile or
// model, silent scheduled turns, and internal → chat messaging over the bus.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChannelManager, StateStore, parseSettings, silentLogger, type Profile, type ProviderCapabilities } from "../src/index.ts";
import { CAPS, FakePlatform, FakeProvider, type Script } from "./fakes.ts";

let dir: string;
let store: StateStore;
let managers: ChannelManager[] = [];
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "uq-sess-")); store = new StateStore(join(dir, "state.db")); });
afterEach(async () => {
  for (const m of managers) await m.stop();
  managers = [];
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function setup(script: Script, caps: ProviderCapabilities = CAPS, settings: Record<string, unknown> = {}) {
  const s = parseSettings({ profiles: { main: { provider: "fake" }, cheap: { provider: "fake", model: "small" } }, output: { toolStatus: false }, queue: { debounceMs: 0 }, ...settings });
  const provider = new FakeProvider(script, caps);
  const platform = new FakePlatform();
  const prof = (name: string, model?: string): Profile => ({ name, provider: "fake", ...(model ? { model } : {}), permissions: s.profiles.main!.permissions, options: {} });
  const mgr = new ChannelManager({
    log: silentLogger, settings: s, store, projectDir: dir, instanceId: "test",
    providers: new Map([["fake", provider]]), platforms: new Map([["tg", platform]]),
    profiles: new Map([["main", prof("main", "big")], ["cheap", prof("cheap", "small")]]),
    gatewayFor: () => undefined, providerEnv: async () => ({}),
    systemPrompt: async (_p, _m, _t, session) => ({ fragments: session?.internal ? [{ id: "internal-session", text: "" }] : [] }),
  });
  managers.push(mgr);
  return { mgr, provider, platform };
}

const until = async (cond: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error("timeout"); await Bun.sleep(5); }
};
const reply = (text: string): Script => (_i, s) => { s.emit({ type: "text", segmentId: "a", final: text }, { type: "turn_end", turnId: s.turnId(), reason: "done" }); };
const dm = (chatId: string, text: string) => ({ platform: "tg", channelKey: `tg:${chatId}`, replyTarget: { platform: "tg", chatId }, ref: { platform: "tg", chatId, messageId: "m" },
  sender: { id: chatId, name: "u" + chatId }, trusted: true, multiparty: false, text, attachments: [], receivedAt: Date.now() });

test("each DM is its own session; agents_list marks chat vs internal", async () => {
  const { mgr, provider, platform } = setup(reply("ok"));
  await mgr.handleInbound(dm("100", "hi"));
  await mgr.handleInbound(dm("200", "hi"));
  await until(() => platform.sent.length === 2);
  expect([...provider.sessions.keys()].sort()).toEqual(["tg:100", "tg:200"]);
  await mgr.fireScheduled({ channelKey: "heartbeat", job: "heartbeat", text: "beat", sourceLine: "[heartbeat]", deliverTo: "none" });
  await until(() => provider.sessions.has("heartbeat"));
  const kinds = Object.fromEntries(mgr.listAgents().map((a) => [a.name, a.kind]));
  expect(kinds).toEqual({ "tg:100": "chat", "tg:200": "chat", heartbeat: "internal" });
  // only the internal session gets the internal-session prompt
  expect(provider.specs.find((s) => s.sessionId === "heartbeat")!.systemPrompt!.fragments.map((f) => f.id)).toEqual(["internal-session"]);
  expect(provider.specs.find((s) => s.sessionId === "tg:100")!.systemPrompt!.fragments).toEqual([]);
});

test("replyTo none: the scheduled turn's reply is not posted anywhere", async () => {
  const { mgr, provider, platform } = setup(reply("nothing to report"));
  await mgr.fireScheduled({ channelKey: "heartbeat", job: "heartbeat", text: "beat", sourceLine: "[heartbeat]", deliverTo: "none" });
  await until(() => provider.sessions.get("heartbeat")?.sent.length === 1);
  await Bun.sleep(50);
  expect(platform.sent).toHaveLength(0);
});

test("internal session reaches a DM session with agent_trigger; reply lands on that DM", async () => {
  const { mgr, provider, platform } = setup((input, s) => {
    const text = input.text.includes("Triggered by session heartbeat") ? "hey, your build finished" : "noted";
    s.emit({ type: "text", segmentId: "a", final: text }, { type: "turn_end", turnId: s.turnId(), reason: "done" });
  });
  await mgr.fireScheduled({ channelKey: "heartbeat", job: "heartbeat", text: "beat", sourceLine: "[heartbeat]", deliverTo: "none" });
  await until(() => provider.sessions.get("heartbeat")?.sent.length === 1);
  await mgr.trigger("heartbeat", "tg:100", "tell them the build finished");
  await until(() => platform.sent.length === 1);
  expect(platform.sent[0]).toEqual({ target: { platform: "tg", chatId: "100" }, text: "hey, your build finished" });
  await until(() => store.countPending("heartbeat") === 1); // trigger result echoed back to the caller
  // and notify from the internal session lands in the DM session's pending input
  await mgr.notify("heartbeat", "tg:200", "fyi");
  expect(store.countPending("tg:200")).toBe(1);
});

test("profile pin: the job's session opens on that profile and keeps it after a restart", async () => {
  const a = setup(reply("ok"));
  await a.mgr.fireScheduled({ channelKey: "cron:digest", job: "digest", text: "go", sourceLine: "[cron]", profile: "cheap" });
  await until(() => a.provider.sessions.get("cron:digest")?.sent.length === 1);
  expect(a.provider.specs.at(-1)!.profile).toMatchObject({ name: "cheap", model: "small" });
  await a.mgr.stop();
  // new daemon run: restore() must reopen it on the pinned profile, not bindings.default
  const b = setup(reply("ok"));
  await b.mgr.restore();
  expect(b.mgr.runtimes.get("cron:digest")!.profile.name).toBe("cheap");
  expect(b.mgr.profileFor("tg:100").name).toBe("main");
});

test("profile pin on an idle session already open on another profile reopens it", async () => {
  const { mgr, provider } = setup(reply("ok"));
  await mgr.fireScheduled({ channelKey: "heartbeat", job: "heartbeat", text: "1", sourceLine: "[heartbeat]" });
  await until(() => provider.sessions.get("heartbeat")?.sent.length === 1);
  await until(() => mgr.runtimes.get("heartbeat")!.state === "idle");
  await mgr.fireScheduled({ channelKey: "heartbeat", job: "heartbeat", text: "2", sourceLine: "[heartbeat]", profile: "cheap" });
  await until(() => provider.specs.filter((s) => s.sessionId === "heartbeat").length === 2);
  expect(mgr.runtimes.get("heartbeat")!.profile.name).toBe("cheap");
});

test("job model: switched live for the scheduled turn, switched back on the next human turn", async () => {
  const { mgr, provider, platform } = setup(reply("ok"));
  await mgr.handleInbound(dm("100", "hi"));
  await until(() => platform.sent.length === 1);
  const s = provider.sessions.get("tg:100")!;
  await mgr.fireScheduled({ channelKey: "tg:100", job: "digest", text: "summarise", sourceLine: "[cron]", model: "small" });
  await until(() => s.sent.length === 2);
  expect(s.models).toEqual(["small"]);
  await until(() => platform.sent.length === 2);
  await mgr.handleInbound(dm("100", "thanks"));
  await until(() => s.sent.length === 3);
  expect(s.models).toEqual(["small", "big"]);
});

test("job model on a provider without live switching is ignored (use a profile)", async () => {
  const { mgr, provider } = setup(reply("ok"), { ...CAPS, modelSwitch: "spawn" });
  await mgr.fireScheduled({ channelKey: "cron:x", job: "x", text: "go", sourceLine: "[cron]", model: "small" });
  await until(() => provider.sessions.get("cron:x")?.sent.length === 1);
  expect(provider.sessions.get("cron:x")!.models).toEqual([]);
});

test("unknown internal names are not created by agent_ask", async () => {
  const { mgr } = setup(reply("ok"));
  await expect(mgr.ask("tg:100", "heartbat", "typo?", true)).rejects.toThrow(/unknown agent/);
});
