// Graceful restart: drain → persist → come back. Each test runs two (or three) "daemon generations" on one
// state.db: generation 1 drains and writes the record, the next one replays and sends the notices.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ChannelManager, RECORD_KEY, RestartCoordinator, StateStore, parseDuration, parseSettings, parseWhen, silentLogger,
  type InboundMessage, type Profile, type RestartRecord, type TurnInput,
} from "../src/index.ts";
import { CAPS, FakePlatform, FakeProvider, FakeSession } from "./fakes.ts";

let dir: string;
let store: StateStore;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "uq-restart-")); store = new StateStore(join(dir, "state.db")); });
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
const until = async (cond: () => boolean, ms = 3000) => { const end = Date.now() + ms; while (!cond()) { if (Date.now() > end) throw new Error("timeout"); await Bun.sleep(5); } };

const settings = parseSettings({ profiles: { main: { provider: "fake" } }, queue: { debounceMs: 0 }, backgroundNotify: { mode: "off" } });
const prof: Profile = { name: "main", provider: "fake", permissions: settings.profiles.main!.permissions, options: {} };

/** Sessions whose turns run until the test ends them (finish), optionally surviving detach (like claude-tmux). */
class GatedSession extends FakeSession {
  detached = false;
  detach?: () => void;
  constructor(detachable: boolean) {
    super(CAPS, () => {});
    if (detachable) this.detach = () => { this.detached = true; };
  }
  finish(text: string) { this.emit({ type: "text", segmentId: `s${this.sent.length}`, final: text }, { type: "turn_end", turnId: this.turnId(), reason: "done" }); }
  get texts() { return this.sent.map((i: TurnInput) => i.text).join("\n---\n"); }
}
class GatedProvider extends FakeProvider {
  constructor(detachable = false, onOpen?: (s: GatedSession) => void) {
    super(() => {});
    this.open = async (spec: { sessionId: string }) => {
      const s = new GatedSession(detachable);
      this.sessions.set(spec.sessionId, s);
      s.emit({ type: "session", providerSessionId: `p-${spec.sessionId}` });
      onOpen?.(s);
      return s;
    };
  }
  s(key: string) { return this.sessions.get(key) as GatedSession; }
}

function generation(provider: FakeProvider, platform: FakePlatform, execute: () => void | boolean | Promise<void | boolean> = () => {}) {
  const m = new ChannelManager({
    log: silentLogger, settings, store, projectDir: dir, instanceId: "test",
    providers: new Map([["fake", provider]]), platforms: new Map([["tg", platform]]), profiles: new Map([["main", prof]]),
    gatewayFor: () => undefined, providerEnv: async () => ({}), systemPrompt: async () => ({ fragments: [] }),
  });
  const c = new RestartCoordinator({ manager: m, store, log: silentLogger, settings, execute, pollMs: 5 });
  return { m, c };
}
/** Daemon start order: prepare (before restore) → restore → resume (after platforms). */
async function comeBack(g: ReturnType<typeof generation>) { g.c.prepare(); await g.m.restore(); return g.c.resume(); }

const msg = (chat: string, text: string, id = "42"): InboundMessage => ({ platform: "tg", channelKey: `tg:${chat}`, replyTarget: { platform: "tg", chatId: chat },
  ref: { platform: "tg", chatId: chat, messageId: id }, sender: { id: chat, name: "u" }, trusted: true, multiparty: false, text, attachments: [], receivedAt: Date.now() });
const record = () => JSON.parse(store.get(RECORD_KEY)!) as RestartRecord;

test("graceful restart waits for the in-flight turn; its reply is delivered before the restart; drain-time input is replayed after it", async () => {
  const platform = new FakePlatform();
  const p1 = new GatedProvider();
  let sentAtExecute = -1;
  const g1 = generation(p1, platform, () => { sentAtExecute = platform.sent.length; });
  await g1.m.handleInbound(msg("7", "deploy it, then restart"));
  await until(() => p1.s("tg:7")?.sent.length === 1);

  // The agent asks for the restart from inside its own turn: the request returns at once.
  const st = g1.c.request({ kind: "restart", requestedBy: "tg:7", reason: "new build" });
  expect(st).toMatchObject({ pending: true, kind: "restart", requestedBy: ["tg:7"] });
  await until(() => g1.c.status().phase === "draining");
  await Bun.sleep(50);
  expect(sentAtExecute).toBe(-1); // still waiting for the turn

  // A message arriving during the drain: persisted, acknowledged once, no turn started.
  await g1.m.handleInbound(msg("7", "are you back?", "43"));
  await g1.m.handleInbound(msg("7", "hello?", "44"));
  expect(store.countDeferred()).toBe(2);
  expect(platform.sent.filter((s) => s.text.includes("UniQlaw is restarting"))).toHaveLength(1);
  expect(p1.s("tg:7").sent).toHaveLength(1);
  expect(p1.s("tg:7").steered).toHaveLength(0);

  p1.s("tg:7").finish("deployed — restarting now");
  await until(() => sentAtExecute >= 0);
  const replyIdx = platform.sent.findIndex((s) => s.text === "deployed — restarting now");
  expect(replyIdx).toBeGreaterThanOrEqual(0);
  expect(replyIdx).toBeLessThan(sentAtExecute);
  expect(record()).toMatchObject({ kind: "restart", requestedBy: ["tg:7"], reasons: ["new build"], interrupted: [], deferred: 2 });
  await g1.m.stop();

  // Generation 2: the drain-time messages are replayed and the requester gets its notice.
  const p2 = new GatedProvider();
  const g2 = generation(p2, platform);
  const back = await comeBack(g2);
  expect(back.replayed).toBe(2);
  expect(back.notified).toEqual(["tg:7"]);
  await until(() => p2.s("tg:7")?.texts.includes("[uniqlaw] daemon restarted") && p2.s("tg:7").texts.includes("hello?"));
  const t = p2.s("tg:7").texts;
  expect(t).toContain("are you back?");
  expect(t).toContain("reason: new build; requested by tg:7");
  expect(t).toContain("Queued messages replayed: 2");
  expect(store.get(RECORD_KEY)).toBeUndefined();
  expect(store.countDeferred()).toBe(0);
  await g2.m.stop();
});

test("the requester's notice reaches its chat (even with backgroundNotify off)", async () => {
  const platform = new FakePlatform();
  const p1 = new GatedProvider();
  const g1 = generation(p1, platform);
  await g1.m.handleInbound(msg("5", "restart please"));
  await until(() => p1.s("tg:5")?.sent.length === 1);
  g1.c.request({ kind: "reload", requestedBy: "tg:5" });
  p1.s("tg:5").finish("ok, reloading");
  await until(() => !!store.get(RECORD_KEY));
  await g1.m.stop();

  const p2 = new GatedProvider();
  const g2 = generation(p2, platform);
  expect((await comeBack(g2)).notified).toEqual(["tg:5"]);
  await until(() => (p2.s("tg:5")?.sent.length ?? 0) === 1);
  expect(p2.s("tg:5").texts).toContain("[uniqlaw] daemon reloaded");
  expect(p2.s("tg:5").texts).toContain("You asked for this");
  p2.s("tg:5").finish("I'm back.");
  await until(() => platform.sent.some((s) => s.text === "I'm back."));
  expect(platform.sent.find((s) => s.text === "I'm back.")!.target.chatId).toBe("5");
  await g2.m.stop();
});

test("drain timeout: a turn still running is recorded as interrupted and that session gets a notice", async () => {
  const platform = new FakePlatform();
  const p1 = new GatedProvider();
  let executed = false;
  const g1 = generation(p1, platform, () => { executed = true; });
  await g1.m.handleInbound(msg("8", "a very long job"));
  await until(() => p1.s("tg:8")?.sent.length === 1);
  g1.c.request({ kind: "restart", requestedBy: "cli", reason: "upgrade", drainTimeoutSec: 0.05 });
  await until(() => executed);
  expect(record().interrupted).toEqual([{ channelKey: "tg:8", answering: ["tg:u"], detachable: false, target: { platform: "tg", chatId: "8" } }]);
  await g1.m.stop(); // not detachable: the turn dies with the daemon

  const p2 = new GatedProvider();
  const g2 = generation(p2, platform);
  expect((await comeBack(g2)).notified).toEqual(["tg:8"]); // "cli" is not a session: no requester notice
  await until(() => (p2.s("tg:8")?.sent.length ?? 0) === 1);
  const t = p2.s("tg:8").texts;
  expect(t).toContain("Interrupted: tg:8 (answering tg:u; cut off)");
  expect(t).toContain("its reply was not delivered");
  p2.s("tg:8").finish("Sorry, the restart cut me off — picking it up again.");
  await until(() => platform.sent.some((s) => s.text.startsWith("Sorry, the restart")));
  expect(platform.sent.find((s) => s.text.startsWith("Sorry, the restart"))!.target.chatId).toBe("8");
  await g2.m.stop();
});

test("async ask results are not lost: a killed answer fails loudly, a surviving one is still delivered", async () => {
  const platform = new FakePlatform();
  for (const detachable of [false, true]) {
    const p1 = new GatedProvider(detachable);
    let executed = false;
    const g1 = generation(p1, platform, () => { executed = true; });
    // A (tg:1) is in a turn and asks B (tg:2) asynchronously; B is still working at the drain timeout.
    await g1.m.handleInbound(msg("1", "ask tg:2 for me"));
    await until(() => p1.s("tg:1")?.sent.length === 1);
    const { taskId } = await g1.m.ask("tg:1", "tg:2", "what is 6*7?", false);
    await until(() => p1.s("tg:2")?.sent.length === 1);
    p1.s("tg:1").finish("asked; I'll tell you");
    g1.c.request({ kind: "restart", requestedBy: "cli", drainTimeoutSec: 0.05 });
    await until(() => executed);
    expect(record().openTasks.map((t) => t.taskId)).toContain(taskId);
    await g1.m.stop();

    // B's reattached session (claude-tmux) is still in that turn and finishes it after the restart.
    const p2 = new GatedProvider(false, (s) => {
      if (detachable && s === p2.s("tg:2")) s.emit({ type: "unsolicited_turn" }, { type: "text", segmentId: "a", final: "42" }, { type: "turn_end", turnId: "x", reason: "done" });
    });
    const g2 = generation(p2, platform);
    await comeBack(g2);
    await until(() => (p2.s("tg:1")?.texts ?? "").includes(`agent_ask ${taskId}`));
    const a = p2.s("tg:1").texts;
    if (detachable) {
      expect(a).toContain(`[Result of your agent_ask ${taskId} to tg:2]`);
      expect(a).toContain("42");
      expect(store.getTask(taskId)).toMatchObject({ state: "completed", result: "42" });
    } else {
      expect(a).toContain(`[Result of your agent_ask ${taskId} to tg:2 (failed)]`);
      expect(a).toContain("the UniQlaw daemon restarted before it finished");
      expect(store.getTask(taskId)!.state).toBe("failed");
    }
    await g2.m.stop();
    store.db.run("DELETE FROM sessions; DELETE FROM kv; DELETE FROM tasks; DELETE FROM pending_input;");
  }
});

test("while draining: blocking calls fail fast, an ask from a running turn still runs, cancel releases held input", async () => {
  const platform = new FakePlatform();
  const p1 = new GatedProvider();
  const g1 = generation(p1, platform);
  await g1.m.handleInbound(msg("1", "work"));
  await until(() => p1.s("tg:1")?.sent.length === 1);
  g1.c.request({ kind: "restart", requestedBy: "cli" });
  await until(() => g1.m.isDraining);
  expect(String(await g1.m.ask("api", "tg:2", "x", true).catch((e: unknown) => e))).toMatch(/restarting/);
  expect(await g1.m.runInbound({ profile: "main", remote: "r", contextId: "c", taskId: "t1", text: "x", hop: 1 })).toMatchObject({ ok: false });
  // tg:1's running turn blocks on an answer from tg:2: that ask is not held back.
  const pending = g1.m.ask("tg:1", "tg:2", "quick question", true);
  await until(() => p1.s("tg:2")?.sent.length === 1);
  p1.s("tg:2").finish("answer");
  expect((await pending).result).toEqual({ ok: true, text: "answer" });
  // A fire-and-forget input is held; cancel replays it right away.
  await g1.m.handleInbound(msg("3", "held"));
  expect(store.countDeferred()).toBe(1);
  expect(await g1.c.cancel()).toEqual({ canceled: true, replayed: 1 });
  expect(g1.m.isDraining).toBe(false);
  await until(() => p1.s("tg:3")?.texts.includes("held"));
  await g1.m.stop();
});

test("scheduled restart: --in fires later; a reload before it runs now and keeps it; a missed one is dropped", async () => {
  const platform = new FakePlatform();
  const kinds: string[] = [];
  const g1 = generation(new GatedProvider(), platform, () => { kinds.push("g1"); });
  g1.c.request({ kind: "restart", requestedBy: "cli", at: Date.now() + 120 });
  await Bun.sleep(40);
  expect(kinds).toEqual([]);
  expect(g1.c.status()).toMatchObject({ pending: true, phase: "scheduled" });
  await until(() => kinds.length === 1);

  // A restart scheduled for later, then `uniqlaw reload` now: the reload runs right away as a reload, and the
  // scheduled restart is still there for the next generation.
  const got: string[] = [];
  const g2 = generation(new GatedProvider(), platform, () => {});
  (g2.c as unknown as { d: { execute: (k: string) => void } }).d.execute = (k) => { got.push(k); };
  await comeBack(g2);
  g2.c.request({ kind: "restart", requestedBy: "cli", at: Date.now() + 250 });
  g2.c.request({ kind: "reload", requestedBy: "SIGHUP" });
  await until(() => got.length === 1);
  expect(got).toEqual(["reload"]);
  expect(store.get("restart-pending")).toBeDefined();
  g2.c.stop();
  await g2.m.stop();
  const g3 = generation(new GatedProvider(), platform, () => { kinds.push("g3"); });
  await comeBack(g3);
  g3.c.start();
  expect(g3.c.status()).toMatchObject({ pending: true, phase: "scheduled", kind: "restart" });
  await until(() => kinds.length === 2);
  expect(got).toEqual(["reload"]);

  // Scheduled for a time that passed while the daemon was down: dropped, not fired on start.
  store.set("restart-pending", JSON.stringify({ id: "x", kind: "restart", requestedBy: ["cli"], reasons: [], requestedAt: 0, fireAt: Date.now() - 1000, now: false, drainTimeoutSec: 1, targets: {} }));
  const g4 = generation(new GatedProvider(), platform, () => { kinds.push("g4"); });
  g4.c.start();
  expect(g4.c.status().pending).toBe(false);
  await Bun.sleep(50);
  expect(kinds).toHaveLength(2);
});

test("a restart that could not execute (reload refused) ends the drain, keeps no record and tells the requester", async () => {
  const platform = new FakePlatform();
  const p1 = new GatedProvider();
  const g1 = generation(p1, platform, () => false);
  await g1.m.handleInbound(msg("4", "hi"));
  await until(() => p1.s("tg:4")?.sent.length === 1);
  g1.c.request({ kind: "reload", requestedBy: "tg:4" });
  await until(() => g1.m.isDraining);
  await g1.m.handleInbound(msg("4", "during", "60"));
  p1.s("tg:4").finish("ok");
  await until(() => !g1.m.isDraining);
  expect(store.get(RECORD_KEY)).toBeUndefined();
  expect(g1.c.status().pending).toBe(false);
  await until(() => p1.s("tg:4").sent.length === 2);
  expect(p1.s("tg:4").texts).toContain("during");
  expect(p1.s("tg:4").texts).toContain("your reload was aborted");
  await g1.m.stop();
});

test("crash between persist and exit: the next start still replays and notifies, and a second start does neither again", async () => {
  const platform = new FakePlatform();
  const p1 = new GatedProvider();
  let executed = false;
  const g1 = generation(p1, platform, () => { executed = true; /* …and the process dies here: no stop(), no detach */ });
  await g1.m.handleInbound(msg("6", "long"));
  await until(() => p1.s("tg:6")?.sent.length === 1);
  g1.c.request({ kind: "restart", requestedBy: "tg:6", drainTimeoutSec: 0.05 });
  await until(() => g1.m.isDraining);
  await g1.m.handleInbound(msg("6", "queued while draining", "50"));
  await until(() => executed);

  const p2 = new GatedProvider();
  const g2 = generation(p2, platform);
  const back = await comeBack(g2);
  expect(back).toMatchObject({ replayed: 1, notified: ["tg:6"] });
  await until(() => p2.s("tg:6")?.texts.includes("queued while draining") && p2.s("tg:6").texts.includes("[uniqlaw]"));
  await g2.m.stop();

  const p3 = new GatedProvider();
  const g3 = generation(p3, platform);
  expect(await comeBack(g3)).toEqual({ replayed: 0, notified: [] });
  await g3.m.stop();
});

test("a reattached claude-tmux-like session finishes its resumed turn first, then gets the notice", async () => {
  const platform = new FakePlatform();
  const p1 = new GatedProvider(true);
  let executed = false;
  const g1 = generation(p1, platform, async () => { executed = true; });
  await g1.m.handleInbound(msg("9", "refactor everything", "77"));
  await until(() => p1.s("tg:9")?.sent.length === 1);
  g1.c.request({ kind: "restart", requestedBy: "tg:9", drainTimeoutSec: 0.05 });
  await until(() => executed);
  await g1.m.stop();
  expect(p1.s("tg:9").detached).toBe(true);
  expect(record().interrupted[0]).toMatchObject({ channelKey: "tg:9", detachable: true });

  // The pane is still busy: it reports the running turn only after a short while (first poll), then finishes it.
  const p2 = new GatedProvider(false, (s) => {
    setTimeout(() => s.emit({ type: "unsolicited_turn" }), 100);
    setTimeout(() => s.finish("refactor done"), 200);
  });
  const g2 = generation(p2, platform);
  expect((await comeBack(g2)).notified).toEqual(["tg:9"]);
  await until(() => platform.sent.some((s) => s.text === "refactor done"));
  // The resumed reply kept its routing (reply to the original message), not the notice's.
  expect(platform.sent.find((s) => s.text === "refactor done")!.target).toMatchObject({ chatId: "9", replyToMessageId: "77" });
  await until(() => p2.s("tg:9").sent.length === 1);
  expect(p2.s("tg:9").texts).toContain("Your session survived, so it may have finished on its own");
  await g2.m.stop();
});

test("a re-armed task whose turn never comes back (it ended while the daemon was down) is failed, not left waiting", async () => {
  const platform = new FakePlatform();
  const p1 = new GatedProvider(true);
  let executed = false;
  const g1 = generation(p1, platform, () => { executed = true; });
  await g1.m.handleInbound(msg("1", "ask tg:2"));
  await until(() => p1.s("tg:1")?.sent.length === 1);
  const { taskId } = await g1.m.ask("tg:1", "tg:2", "q", false);
  await until(() => p1.s("tg:2")?.sent.length === 1);
  p1.s("tg:1").finish("asked");
  g1.c.request({ kind: "restart", requestedBy: "cli", drainTimeoutSec: 0.05 });
  await until(() => executed);
  await g1.m.stop();
  // Generation 2: tg:2's pane is idle on reattach (no turn events); its restart notice is the next turn.
  const p2 = new GatedProvider();
  const g2 = generation(p2, platform);
  await comeBack(g2);
  expect(store.getTask(taskId)!.state).toBe("working"); // re-armed, waiting for the resumed turn
  await until(() => (p2.s("tg:1")?.texts ?? "").includes(`agent_ask ${taskId}`), 6000);
  expect(p2.s("tg:1").texts).toContain("could not be collected");
  expect(store.getTask(taskId)!.state).toBe("failed");
  await g2.m.stop();
}, 10_000);

test("a worker's notice follows its background routing, not the human chat its task came from", async () => {
  const platform = new FakePlatform();
  const p1 = new GatedProvider();
  let executed = false;
  const g1 = generation(p1, platform, () => { executed = true; });
  await g1.m.handleInbound(msg("1", "start a worker"));
  await until(() => p1.s("tg:1")?.sent.length === 1);
  await g1.m.startWorker("tg:1", { name: "w", profile: "main", task: "long job", wait: false });
  await until(() => p1.s("worker:w")?.sent.length === 1);
  p1.s("tg:1").finish("started");
  g1.c.request({ kind: "restart", requestedBy: "cli", drainTimeoutSec: 0.05 });
  await until(() => executed);
  expect(record().interrupted).toEqual([expect.objectContaining({ channelKey: "worker:w", target: null })]);
  await g1.m.stop();
  const p2 = new GatedProvider();
  const g2 = generation(p2, platform);
  await comeBack(g2);
  await until(() => (p2.s("worker:w")?.texts ?? "").includes("[uniqlaw]"));
  p2.s("worker:w").finish("worker: resuming");
  await Bun.sleep(50);
  expect(platform.sent.some((s) => s.text === "worker: resuming")).toBe(false);
  await g2.m.stop();
});

test("open tasks: listed in the record → the asker is told even if old; no record (crash) → only recent ones", async () => {
  const platform = new FakePlatform();
  const g = generation(new GatedProvider(), platform);
  store.upsertSession({ channelKey: "tg:1", profile: "main", provider: "fake", providerSessionId: null, multiparty: false, createdAt: 0, lastActivityAt: 0, lastTarget: null, adapterState: null });
  for (const id of ["old", "older"]) {
    store.createTask({ taskId: id, fromSession: "tg:1", toSession: "worker:x", mode: "ask", request: "q" });
    store.db.run("UPDATE tasks SET updated_at = ? WHERE task_id = ?", [Date.now() - 2 * 3600_000, id]);
  }
  expect(g.m.resumeTasks(new Set(["old"])).map((t) => t.taskId)).toEqual(["old"]);
  expect(store.getTask("older")!.state).toBe("failed");
  store.createTask({ taskId: "new", fromSession: "tg:1", toSession: "worker:x", mode: "ask", request: "q" });
  expect(g.m.resumeTasks().map((t) => t.taskId)).toEqual(["new"]);
  await g.m.stop();
});

test("--in / --at parsing", () => {
  expect(parseDuration("90")).toBe(90_000);
  expect(parseDuration("1h30m")).toBe(5_400_000);
  expect(parseDuration("10m")).toBe(600_000);
  expect(() => parseDuration("soon")).toThrow();
  const now = Date.parse("2026-11-11T15:00:30Z"); // 23:00:30 in Asia/Taipei
  expect(parseWhen({ in: "5m" }, "UTC", now)).toBe(now + 300_000);
  expect(new Date(parseWhen({ at: "23:30" }, "Asia/Taipei", now)!).toISOString()).toBe("2026-11-11T15:30:00.000Z");
  expect(new Date(parseWhen({ at: "03:00" }, "Asia/Taipei", now)!).toISOString()).toBe("2026-11-11T19:00:00.000Z");
  expect(parseWhen({ at: "2026-11-12T01:00:00Z" }, "UTC", now)).toBe(Date.parse("2026-11-12T01:00:00Z"));
  expect(parseWhen({}, "UTC", now)).toBeUndefined();
});

test("daemon_restart tool: only an operator's own chat may call it; it returns at once", async () => {
  const platform = new FakePlatform(); // operator target: tg:1
  const g = generation(new GatedProvider(), platform);
  const tool = g.c.tools().find((t) => t.name === "daemon_restart")!;
  expect(String(await tool.handler({}, "tg:9").catch((e: unknown) => e))).toContain("only available in an operator's own chat");
  expect(String(await tool.handler({}, "worker:x").catch((e: unknown) => e))).toContain("operator");
  expect(await tool.handler({ reason: "r", in: "10m" }, "tg:1")).toMatchObject({ pending: true, phase: "scheduled", kind: "restart", requestedBy: ["tg:1"] });
  expect(await tool.handler({ cancel: true }, "tg:1")).toEqual({ canceled: true, replayed: 0 });
  g.c.stop();
  await g.m.stop();
});
