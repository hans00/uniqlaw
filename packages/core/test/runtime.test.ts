import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ChannelManager, StateStore, parseSettings, silentLogger, type InboundMessage, type Profile, type ProviderCapabilities,
} from "../src/index.ts";

import { CAPS, FakePlatform, FakeProvider, type FakeSession, type Script } from "./fakes.ts";

// ── harness ────────────────────────────────────────────────────────────────

let dir: string;
let store: StateStore;
let managers: ChannelManager[] = [];
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "uq-core-")); store = new StateStore(join(dir, "state.db")); });
afterEach(async () => {
  for (const m of managers) await m.stop();
  managers = [];
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function setup(script: Script, opts: { settings?: Record<string, unknown>; caps?: ProviderCapabilities; approval?: Profile["permissions"]["approval"]["mode"] } = {}) {
  const settings = parseSettings({ timezone: "UTC+8", profiles: { main: { provider: "fake" } }, output: { toolStatus: false }, queue: { debounceMs: 0 }, ...opts.settings });
  const provider = new FakeProvider(script, opts.caps);
  const platform = new FakePlatform();
  const profile: Profile = { name: "main", provider: "fake", permissions: { ...settings.profiles.main!.permissions, approval: { mode: opts.approval ?? "ask-operator", timeoutSec: 5 } }, options: {} };
  const mgr = new ChannelManager({
    log: silentLogger, settings, store, projectDir: dir, instanceId: "test",
    providers: new Map([["fake", provider]]), platforms: new Map([["tg", platform]]), profiles: new Map([["main", profile]]),
    gatewayFor: () => undefined, systemPrompt: async () => ({ fragments: [] }), providerEnv: async () => ({}),
  });
  managers.push(mgr);
  return { mgr, provider, platform };
}

function inbound(text: string, chatId = "100", channelKey = "global", extra: Partial<InboundMessage> = {}): InboundMessage {
  return { platform: "tg", channelKey, replyTarget: { platform: "tg", chatId }, ref: { platform: "tg", chatId, messageId: "m1" },
    sender: { id: "7", name: "Hans", username: "hans" }, trusted: true, multiparty: false, text, attachments: [], receivedAt: Date.now(), ...extra };
}

const until = async (cond: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error("timeout"); await Bun.sleep(5); }
};

const reply = (text: string): Script => (_i, s) => { s.emit({ type: "text", segmentId: "a", final: text }, { type: "turn_end", turnId: s.turnId(), reason: "done" }); };

// ── tests ──────────────────────────────────────────────────────────────────

describe("ChannelRuntime", () => {
  test("human turn: prompt carries timestamp + source; reply goes to the sender's chat", async () => {
    const { mgr, provider, platform } = setup(reply("hello back"));
    await mgr.handleInbound(inbound("hi"));
    await until(() => platform.sent.length === 1);
    const s = provider.sessions.get("global")!;
    expect(s.sent[0]!.text).toMatch(/^\[\d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC\+8\]\n\[Tg from Hans \(@hans · 7\)\]\nMessage: hi$/);
    expect(platform.sent[0]).toEqual({ target: { platform: "tg", chatId: "100", replyToMessageId: "m1" }, text: "hello back" });
    expect(store.getSession("global")!.providerSessionId).toBe("p-global");
  });

  test("NO_REPLY is suppressed, reactions are applied and stripped", async () => {
    const { mgr, platform } = setup((_i, s) => s.emit(
      { type: "text", segmentId: "a", final: "`NO_REPLY`." },
      { type: "text", segmentId: "b", final: "nice [react:👍]" },
      { type: "turn_end", turnId: s.turnId(), reason: "done" }));
    await mgr.handleInbound(inbound("yo"));
    await until(() => platform.sent.length === 1 && platform.reactions.length === 1);
    expect(platform.sent[0]!.text).toBe("nice");
    expect(platform.reactions[0]!.emojis).toEqual(["👍"]);
  });

  test("queue mode: messages during a turn are merged into one follow-up prompt", async () => {
    let release!: () => void;
    const { mgr, provider } = setup(async (input, s) => {
      if (s.sent.length === 1) await new Promise<void>((r) => (release = r));
      s.emit({ type: "turn_end", turnId: s.turnId(), reason: "done" });
    });
    await mgr.handleInbound(inbound("first"));
    await until(() => !!release);
    await mgr.handleInbound(inbound("second"));
    await mgr.handleInbound(inbound("third"));
    release();
    const s = provider.sessions.get("global")!;
    await until(() => s.sent.length === 2);
    expect(s.sent[1]!.text).toContain("[Queued messages while agent was busy]");
    expect(s.sent[1]!.text).toContain("Message: second");
    expect(s.sent[1]!.text).toContain("Message: third");
  });

  test("steer mode: mid-turn message is steered into the running turn", async () => {
    let release!: () => void;
    const { mgr, provider } = setup(async (_i, s) => { await new Promise<void>((r) => (release = r)); s.emit({ type: "turn_end", turnId: s.turnId(), reason: "done" }); },
      { settings: { queue: { mode: "steer", debounceMs: 0 } } });
    await mgr.handleInbound(inbound("first"));
    await until(() => !!release);
    await mgr.handleInbound(inbound("also this"));
    const s = provider.sessions.get("global")!;
    expect(s.steered).toHaveLength(1);
    expect(s.steered[0]!.text).toContain("Message: also this");
    release();
    await Bun.sleep(20);
    expect(s.sent).toHaveLength(1);
  });

  test("/stop interrupts the running turn", async () => {
    const { mgr, provider, platform } = setup(() => {});
    await mgr.handleInbound(inbound("long task"));
    const s = await (async () => { await until(() => provider.sessions.has("global")); return provider.sessions.get("global")!; })();
    await until(() => s.sent.length === 1);
    await mgr.handleInbound(inbound("/stop"));
    expect(s.interrupted).toBe(1);
    expect(platform.sent.at(-1)!.text).toContain("Stopped");
  });

  test("permission request goes to the triggering trusted human; deny is honoured", async () => {
    const { mgr, provider, platform } = setup((_i, s) => s.emit({ type: "permission_request", id: "p1", tool: "Bash", input: { command: "rm -rf x" }, title: "Run?" }));
    platform.choiceAnswer = 1; // "Deny"
    await mgr.handleInbound(inbound("clean up"));
    const s = await (async () => { await until(() => provider.sessions.has("global")); return provider.sessions.get("global")!; })();
    await until(() => s.permissions.length === 1);
    expect(platform.choices[0]!.options).toEqual(["Allow", "Deny"]);
    expect(s.permissions[0]!.d.behavior).toBe("deny");
  });

  test("denyEndsTurn: provider ending the turn on deny gets a recovery turn", async () => {
    const { mgr, provider, platform } = setup((input, s) => {
      if (s.sent.length === 1) s.emit({ type: "permission_request", id: "p1", tool: "Bash", input: "x", title: "Run?", options: ["Yes", "No"] });
      else s.emit({ type: "text", segmentId: "r", final: "ok, other way" }, { type: "turn_end", turnId: s.turnId(), reason: "done" });
    }, { caps: { ...CAPS, denyEndsTurn: true } });
    platform.choiceAnswer = 1; // "No"
    await mgr.handleInbound(inbound("do it"));
    await until(() => provider.sessions.has("global"));
    const s = provider.sessions.get("global")!;
    await until(() => s.permissions.length === 1);
    expect(s.permissions[0]).toMatchObject({ d: { behavior: "deny" }, idx: 2 });
    s.emit({ type: "turn_end", turnId: s.turnId(), reason: "interrupted" });
    await until(() => s.sent.length === 2);
    expect(s.sent[1]!.text).toContain("denied the permission request");
    await until(() => platform.sent.some((m) => m.text === "ok, other way"));
  });

  test("agent_ask: peer answers the asker; nothing reaches a platform", async () => {
    const { mgr, platform } = setup((input, s) => {
      const text = input.text.includes("Agent message from session") ? "42" : "?";
      s.emit({ type: "text", segmentId: "a", final: text }, { type: "turn_end", turnId: s.turnId(), reason: "done" });
    });
    const r = await mgr.ask("global", "tg:-5", "what is the answer?", true);
    expect(r.result).toEqual({ ok: true, text: "42" });
    expect(platform.sent).toHaveLength(0);
    expect(store.getTask(r.taskId)!.state).toBe("completed");
  });

  test("agent_trigger: peer answers on its own chat, result echoed to the caller", async () => {
    const { mgr, platform } = setup(reply("announcement"));
    store.upsertSession({ channelKey: "global", profile: "main", provider: "fake", providerSessionId: null, multiparty: false, createdAt: 0, lastActivityAt: 0, lastTarget: null, adapterState: null });
    await mgr.trigger("global", "tg:-5", "announce it");
    await until(() => platform.sent.length === 1);
    expect(platform.sent[0]!.target).toEqual({ platform: "tg", chatId: "-5" });
    await until(() => store.countPending("global") === 1);
  });

  test("delegation hop limit stops ask chains", async () => {
    const errors: string[] = [];
    const ctx: { mgr?: ChannelManager; provider?: FakeProvider } = {};
    const { mgr, provider } = setup(async (_i, s) => {
      // Every peer turn tries to delegate one step further.
      const me = [...ctx.provider!.sessions].find(([, v]) => v === s)![0];
      const next = me === "a" ? "b" : me === "b" ? "c" : "d";
      try { await ctx.mgr!.ask(me, next, "deeper", false); } catch (e) { errors.push(String(e)); }
      s.emit({ type: "turn_end", turnId: s.turnId(), reason: "done" });
    }, { settings: { bus: { maxHops: 2 } } });
    ctx.mgr = mgr; ctx.provider = provider;
    for (const k of ["a", "b", "c", "d"]) store.upsertSession({ channelKey: k, profile: "main", provider: "fake", providerSessionId: null, multiparty: false, createdAt: 0, lastActivityAt: 0, lastTarget: null, adapterState: null });
    await mgr.ask("global", "a", "start", false); // hop 1 → a asks b (hop 2) → b asks c (hop 3: rejected)
    await until(() => errors.length >= 1);
    expect(errors[0]).toContain("delegation chain too deep");
    // a → b (hop 2) is allowed, b → c (hop 3) is not; the async results flowing back
    // (a gets b's result at hop 2 and asks again → hop 3) must not open a loop either.
    await Bun.sleep(200);
    expect(provider.sessions.has("c")).toBe(false);
    const asks = store.db.query("SELECT COUNT(*) AS n FROM tasks").get() as { n: number };
    expect(asks.n).toBeLessThanOrEqual(3);
  });

  test("notify posts and echoes into the owning session's pending input", async () => {
    const { mgr, platform } = setup(reply("x"));
    await mgr.notify("tg:-5", "tg:100", "build done");
    expect(platform.sent[0]).toEqual({ target: { platform: "tg", chatId: "100" }, text: "build done" });
    expect(store.countPending("global")).toBe(1);
  });

  test("background output (no origin) goes to the last target", async () => {
    const { mgr, provider, platform } = setup(reply("first"));
    await mgr.handleInbound(inbound("hi", "100"));
    await until(() => platform.sent.length === 1);
    const s = provider.sessions.get("global")!;
    s.emit({ type: "unsolicited_turn" }, { type: "text", segmentId: "bg", final: "wakeup result" }, { type: "turn_end", turnId: "bg", reason: "done" });
    await until(() => platform.sent.length === 2);
    expect(platform.sent[1]).toEqual({ target: { platform: "tg", chatId: "100" }, text: "wakeup result" });
  });

  test("slash commands are passed through clean", async () => {
    const { mgr, provider } = setup((_i, s) => s.emit({ type: "turn_end", turnId: s.turnId(), reason: "done" }));
    await mgr.handleInbound(inbound("/compact"));
    await until(() => provider.sessions.get("global")?.sent.length === 1);
    expect(provider.sessions.get("global")!.sent[0]).toEqual({ text: "/compact", attachments: [], slashCommand: true });
  });

  test("pending notes are prepended to the next prompt", async () => {
    const { mgr, provider } = setup(reply("ok"));
    store.pushPending("global", "notify-echo", { label: "sent on your behalf by cli", text: "deploy finished" });
    await mgr.handleInbound(inbound("status?"));
    await until(() => provider.sessions.get("global")?.sent.length === 1);
    const t = provider.sessions.get("global")!.sent[0]!.text;
    expect(t).toContain("[Activity on this channel since your last turn");
    expect(t).toContain("sent on your behalf by cli: deploy finished");
    expect(store.countPending("global")).toBe(0);
  });
});

describe("cleanDialogText", () => {
  test("strips TUI rules, tips and the question", async () => {
    const { cleanDialogText } = await import("../src/runtime.ts");
    const raw = "Bash command\n Tip: auto mode handles these prompts for you\n Create empty file x\n╌╌╌╌╌╌╌╌╌╌\n touch x\n╌╌╌╌╌╌╌╌\n Do you want to proceed?";
    expect(cleanDialogText(raw)).toBe("Bash command\nCreate empty file x\ntouch x");
  });
});
