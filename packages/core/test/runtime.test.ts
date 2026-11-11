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

function setup(script: Script, opts: { settings?: Record<string, unknown>; caps?: ProviderCapabilities; approval?: Profile["permissions"]["approval"]["mode"]; timeoutSec?: number } = {}) {
  const settings = parseSettings({ timezone: "UTC+8", profiles: { main: { provider: "fake" } }, output: { toolStatus: false }, queue: { debounceMs: 0 }, ...opts.settings });
  const provider = new FakeProvider(script, opts.caps);
  const platform = new FakePlatform();
  const profile: Profile = { name: "main", provider: "fake", permissions: { ...settings.profiles.main!.permissions, approval: { mode: opts.approval ?? "ask-operator", timeoutSec: opts.timeoutSec ?? 5 } }, options: {} };
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

  test("approval.timeoutSec 0 = no deadline: accepted by the schema and passed to askChoice as 0", async () => {
    const s = parseSettings({ profiles: { main: { provider: "x", permissions: { approval: { timeoutSec: 0 } } } } });
    expect(s.profiles.main!.permissions.approval.timeoutSec).toBe(0);
    expect(parseSettings({}).profiles.main!.permissions.approval.timeoutSec).toBe(300);
    expect(() => parseSettings({ profiles: { main: { provider: "x", permissions: { approval: { timeoutSec: -1 } } } } })).toThrow();
    const { mgr, provider, platform } = setup((_i, sess) => sess.emit({ type: "permission_request", id: "p1", tool: "Bash", input: { command: "ls" }, title: "Run?" }),
      { timeoutSec: 0 });
    await mgr.handleInbound(inbound("go"));
    await until(() => provider.sessions.get("global")?.permissions.length === 1);
    expect(platform.choices[0]!.timeoutMs).toBe(0);
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
    }, { settings: { bus: { maxHops: 2, maxRounds: 2 } } });
    ctx.mgr = mgr; ctx.provider = provider;
    for (const k of ["a", "b", "c", "d"]) store.upsertSession({ channelKey: k, profile: "main", provider: "fake", providerSessionId: null, multiparty: false, createdAt: 0, lastActivityAt: 0, lastTarget: null, adapterState: null });
    await mgr.ask("global", "a", "start", false); // hop 1 → a asks b (hop 2) → b asks c (hop 3: rejected)
    await until(() => errors.length >= 1);
    expect(errors[0]).toContain("delegation chain too deep");
    // a → b (hop 2) is allowed, b → c (hop 3) is not. b's results flow back to a at a's own hop (1), and a asks
    // again on each one: that ping-pong is bounded by maxRounds instead.
    await until(() => errors.some((e) => e.includes("rounds")));
    await Bun.sleep(100);
    expect(provider.sessions.has("c")).toBe(false);
    const asks = store.db.query("SELECT COUNT(*) AS n FROM tasks").get() as { n: number };
    expect(asks.n).toBe(3); // start, a → b, a → b after the first result
  });

  test("async results back at the asking chat keep its hop; a human message resets the round count", async () => {
    const errors: string[] = [];
    let asks = 0;
    const ctx: { mgr?: ChannelManager; provider?: FakeProvider } = {};
    const { mgr, provider } = setup(async (_i, s) => {
      const me = [...ctx.provider!.sessions].find(([, v]) => v === s)![0];
      if (me === "global") {
        // The chat works with its worker: every turn (human message or a worker result) asks it for the next step.
        try { await ctx.mgr!.ask("global", "w", "next step", false); asks++; } catch (e) { errors.push(String(e)); }
      }
      s.emit({ type: "text", segmentId: "a", final: "ok" }, { type: "turn_end", turnId: s.turnId(), reason: "done" });
    }, { settings: { bus: { maxHops: 2, maxRounds: 3 } } });
    ctx.mgr = mgr; ctx.provider = provider;
    store.upsertSession({ channelKey: "w", profile: "main", provider: "fake", providerSessionId: null, multiparty: false, createdAt: 0, lastActivityAt: 0, lastTarget: null, adapterState: null });
    await mgr.handleInbound(inbound("work with your worker"));
    await until(() => errors.length === 1);
    // Three rounds with maxHops 2: before the fix the second result (hop 2) already failed with "too deep".
    expect(asks).toBe(3);
    expect(errors[0]).toContain("too many agent_ask rounds without a human message (4 > 3)");
    await mgr.handleInbound(inbound("keep going"));
    await until(() => errors.length === 2);
    expect(asks).toBe(6);
    expect(errors.some((e) => e.includes("too deep"))).toBe(false);
  });

  test("fan-out on every result is bounded by the chain budget; a human message starts a new chain", async () => {
    const errors: string[] = [];
    const ctx: { mgr?: ChannelManager; provider?: FakeProvider } = {};
    const { mgr, provider } = setup(async (_i, s) => {
      const me = [...ctx.provider!.sessions].find(([, v]) => v === s)![0];
      if (me === "global") {
        // A runaway agent: every turn (human message or result) fans out to two workers.
        for (const w of ["w1", "w2"]) {
          try { await ctx.mgr!.ask("global", w, "more", false); } catch (e) { errors.push(String(e)); }
        }
      }
      s.emit({ type: "text", segmentId: "a", final: "ok" }, { type: "turn_end", turnId: s.turnId(), reason: "done" });
    }, { settings: { bus: { maxChainTasks: 10 } } });
    ctx.mgr = mgr; ctx.provider = provider;
    for (const k of ["w1", "w2"]) store.upsertSession({ channelKey: k, profile: "main", provider: "fake", providerSessionId: null, multiparty: false, createdAt: 0, lastActivityAt: 0, lastTarget: null, adapterState: null });
    const tasks = () => (store.db.query("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n;
    await mgr.handleInbound(inbound("go"));
    await until(() => errors.some((e) => e.includes("delegation budget used up")));
    await Bun.sleep(150);
    expect(tasks()).toBe(10); // 2^rounds without the budget (maxRounds alone allows 2^20)
    expect(errors.every((e) => e.includes("delegation budget used up"))).toBe(true);
    await mgr.handleInbound(inbound("go again", "100", "global", { ref: { platform: "tg", chatId: "100", messageId: "m2" } }));
    await until(() => tasks() === 20);
    await Bun.sleep(150);
    expect(tasks()).toBe(20);
  });

  test("bus.maxPending caps outstanding async asks per session", async () => {
    const gate: { release: (() => void)[] } = { release: [] };
    const { mgr } = setup(async (_i, s) => {
      await new Promise<void>((r) => gate.release.push(r));
      s.emit({ type: "text", segmentId: "a", final: "done" }, { type: "turn_end", turnId: s.turnId(), reason: "done" });
    }, { settings: { bus: { maxPending: 2 } } });
    store.upsertSession({ channelKey: "w", profile: "main", provider: "fake", providerSessionId: null, multiparty: false, createdAt: 0, lastActivityAt: 0, lastTarget: null, adapterState: null });
    const a = await mgr.ask("cli", "w", "one", false);
    await mgr.ask("cli", "w", "two", false);
    await expect(mgr.ask("cli", "w", "three", false)).rejects.toThrow("too many outstanding async tasks (2, max 2)");
    await expect(mgr.trigger("cli", "w", "four", { platform: "tg", chatId: "1" })).rejects.toThrow("too many outstanding");
    await until(() => gate.release.length === 1);
    gate.release.shift()!();
    await until(() => mgr.taskStatus(a.taskId)?.state === "completed");
    await mgr.ask("cli", "w", "three again", false); // a slot is free again
  });

  test("real ask loops stay bounded by the hop: a asks b asks a …", async () => {
    const errors: string[] = [];
    const ctx: { mgr?: ChannelManager; provider?: FakeProvider } = {};
    const { mgr, provider } = setup(async (i, s) => {
      const me = [...ctx.provider!.sessions].find(([, v]) => v === s)![0];
      if (i.text.includes("[Agent message from session")) {
        try { await ctx.mgr!.ask(me, me === "a" ? "b" : "a", "ping", false); } catch (e) { errors.push(String(e)); }
      }
      s.emit({ type: "text", segmentId: "a", final: "pong" }, { type: "turn_end", turnId: s.turnId(), reason: "done" });
    }, { settings: { bus: { maxHops: 4 } } });
    ctx.mgr = mgr; ctx.provider = provider;
    for (const k of ["a", "b"]) store.upsertSession({ channelKey: k, profile: "main", provider: "fake", providerSessionId: null, multiparty: false, createdAt: 0, lastActivityAt: 0, lastTarget: null, adapterState: null });
    await mgr.ask("global", "a", "ping", false); // hop 1: a → b (2) → a (3) → b (4) → a (5: rejected)
    await until(() => errors.length >= 1);
    await Bun.sleep(150);
    expect(errors).toEqual([expect.stringContaining("delegation chain too deep (hop 5 > 4)")]);
    const n = store.db.query("SELECT COUNT(*) AS n FROM tasks").get() as { n: number };
    expect(n.n).toBe(4);
  });

  test("notify posts and echoes into the owning session's pending input", async () => {
    const { mgr, platform } = setup(reply("x"));
    await mgr.notify("tg:-5", "tg:100", "build done");
    expect(platform.sent[0]).toEqual({ target: { platform: "tg", chatId: "100" }, text: "build done" });
    expect(store.countPending("tg:100")).toBe(1);
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
