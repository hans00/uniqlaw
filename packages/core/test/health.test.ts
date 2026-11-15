// Session health (docs §11.4): MCP recovery for reattached sessions (before the first turn and periodically),
// respawn fallback, pane watchdog repairs and what it only reports, notify-once, the worker limit.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ChannelManager, HealthMonitor, StateStore, parseSettings, silentLogger,
  type McpLink, type PaneInspection, type Profile, type SessionRepair, type TurnInput,
} from "../src/index.ts";
import { CAPS, FakePlatform, FakeProvider, FakeSession, type Script } from "./fakes.ts";

let dir: string;
let store: StateStore;
const cleanups: (() => unknown)[] = [];
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "uq-health-")));
  mkdirSync(join(dir, "repo"));
  store = new StateStore(join(dir, "state.db"));
});
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

class FakeGw {
  links = new Map<string, McpLink>();
  startedAt = Date.now();
  link(k: string) { const l = this.links.get(k); return l ? { ...l } : undefined; }
  init(k: string) { this.links.set(k, { streams: 1, lastRequestAt: Date.now(), lastInitializeAt: Date.now() }); }
}

class HealthSession extends FakeSession {
  reattached = true;
  inspection: PaneInspection = { process: "alive", idle: true };
  reconnects = 0;
  respawns = 0;
  repairs: SessionRepair[] = [];
  /** What reconnectMcp does (default: the gateway sees an initialize). */
  onReconnect: (verify: (since: number) => boolean) => Promise<{ ok: boolean; outcome: string; detail: string }> = async () => ({ ok: true, outcome: "reconnected", detail: "ok" });
  onRespawn: () => Promise<boolean> = async () => true;
  async inspect() { return this.inspection; }
  async reconnectMcp(verify: (since: number) => boolean) { this.reconnects++; return this.onReconnect(verify); }
  async respawn() { this.respawns++; return this.onRespawn(); }
  async repair(a: SessionRepair) { this.repairs.push(a); return a === "close-dialog" ? "mcp-dialog" : "folder-trust"; }
}

class HealthProvider extends FakeProvider {
  closedInspect = new Map<string, PaneInspection>();
  orphanList: { id: string; inspection: PaneInspection }[] = [];
  configure?: (s: HealthSession, key: string) => void;
  override async open(spec: { sessionId: string }) {
    this.specs.push(spec);
    const s = new HealthSession(this.caps, this.script);
    this.configure?.(s, spec.sessionId);
    this.sessions.set(spec.sessionId, s);
    s.emit({ type: "session", providerSessionId: `p-${spec.sessionId}` });
    return s;
  }
  async inspect(o: { sessionId: string }) { return this.closedInspect.get(o.sessionId) ?? { process: "absent" as const }; }
  async orphans() { return this.orphanList; }
}

const echo: Script = (input: TurnInput, s) => { s.emit({ type: "text", segmentId: "a", final: `you said: ${input.text.slice(-10)}` }, { type: "turn_end", turnId: s.turnId(), reason: "done" }); };

function setup(o: { settings?: Record<string, unknown>; health?: Partial<ConstructorParameters<typeof HealthMonitor>[3]> } = {}) {
  const s = parseSettings({ profiles: { main: { provider: "fake" } }, output: { toolStatus: false }, queue: { debounceMs: 0 }, ...o.settings });
  const provider = new HealthProvider(echo, CAPS);
  const platform = new FakePlatform();
  const prof: Profile = { name: "main", provider: "fake", permissions: s.profiles.main!.permissions, options: {} };
  const gw = new FakeGw();
  const mgr = new ChannelManager({ log: silentLogger, settings: s, store, projectDir: dir, instanceId: "t",
    providers: new Map([["fake", provider]]), platforms: new Map([["tg", platform]]), profiles: new Map([["main", prof]]),
    gatewayFor: (k) => ({ url: `http://127.0.0.1:1/mcp/${k}`, token: "x", toolNames: [] }), providerEnv: async () => ({}), systemPrompt: async () => ({ fragments: [] }) });
  const health = new HealthMonitor(mgr, gw, silentLogger, { mcpGraceMs: 40, reconnectEveryMs: 0, respawnEveryMs: 60_000, respawnVerifyMs: 200, ...o.health });
  mgr.setHealth(health);
  cleanups.push(() => mgr.stop(), () => health.stop());
  return { mgr, provider, platform, gw, health };
}
const until = async (c: () => boolean, ms = 3000) => { const e = Date.now() + ms; while (!c()) { if (Date.now() > e) throw new Error("timeout"); await Bun.sleep(5); } };
const dm = (chatId: string, text: string) => ({ platform: "tg", channelKey: `tg:${chatId}`, replyTarget: { platform: "tg", chatId }, ref: { platform: "tg", chatId, messageId: "m" },
  sender: { id: chatId, name: "u" }, trusted: true, multiparty: false, text, attachments: [], receivedAt: Date.now() });
const sess = (p: HealthProvider, k: string) => p.sessions.get(k) as HealthSession;

test("a reattached session's first turn waits for its MCP client: no contact within the grace → reconnect, then the turn", async () => {
  const { mgr, provider, platform, gw } = setup();
  const order: string[] = [];
  provider.configure = (s, k) => {
    s.onReconnect = async (verify) => { order.push("reconnect"); gw.init(k); return { ok: verify(0), outcome: "reconnected", detail: "ok" }; };
    const send = s.send.bind(s);
    s.send = async (i) => { order.push("send"); return send(i); };
  };
  await mgr.handleInbound(dm("100", "hello"));
  await until(() => platform.sent.length > 0);
  expect(order).toEqual(["reconnect", "send"]);
  expect(platform.sent[0]!.text).toContain("hello");
});

test("first turn: a session that reconnected by itself, or was spawned by this daemon, is not touched", async () => {
  const { mgr, provider, platform, gw } = setup({ health: { mcpGraceMs: 2000 } });
  provider.configure = (s, k) => { if (k === "tg:1") setTimeout(() => gw.init(k), 30); else s.reattached = false; };
  await mgr.handleInbound(dm("1", "a"));
  await mgr.handleInbound(dm("2", "b"));
  await until(() => platform.sent.length === 2, 1500);
  expect(sess(provider, "tg:1").reconnects).toBe(0);
  expect(sess(provider, "tg:2").reconnects).toBe(0);
});

test("periodic: an idle open session silent since the gateway started is reconnected; not while a human holds it", async () => {
  const { mgr, provider, health } = setup();
  provider.configure = (s) => { s.reattached = false; }; // skip the first-turn path: only the periodic one
  await mgr.runtime("tg:5").ensureOpen();
  await mgr.runtime("worker:w").ensureOpen();
  store.set("chat-attach:tg:9", "worker:w"); // a human drives worker:w from tg:9
  expect(mgr.heldBy("worker:w")).toBe("tg:9");
  await health.tick(); // within the grace: nothing yet
  expect(sess(provider, "tg:5").reconnects).toBe(0);
  await Bun.sleep(60);
  await health.tick();
  await until(() => sess(provider, "tg:5").reconnects === 1);
  await Bun.sleep(30);
  expect(sess(provider, "worker:w").reconnects).toBe(0);
});

test("reconnect fails → one respawn with resume, verified by the gateway; reported once if that fails too", async () => {
  const { mgr, provider, platform, gw, health } = setup();
  let respawnWorks = true;
  provider.configure = (s, k) => {
    s.reattached = false;
    s.onReconnect = async () => ({ ok: false, outcome: "failed", detail: "Claude Code reports: failed to reconnect" });
    s.onRespawn = async () => { if (respawnWorks) setTimeout(() => gw.init(k), 20); return respawnWorks; };
  };
  await mgr.runtime("tg:7").ensureOpen();
  await Bun.sleep(60);
  await health.recoverMcp("tg:7", "test");
  expect(sess(provider, "tg:7").respawns).toBe(1);
  await health.refresh();
  expect(health.of("tg:7")!.mcp!.lastRecovery!.outcome).toBe("respawned");
  expect(platform.sent).toEqual([]);

  // Next time: reconnect fails and respawn is rate limited → the owner chat hears about it once.
  gw.links.delete("tg:7");
  respawnWorks = false;
  await health.recoverMcp("tg:7", "test");
  await health.recoverMcp("tg:7", "test");
  expect(sess(provider, "tg:7").respawns).toBe(1);
  expect(platform.sent.filter((m) => m.text.includes("UniQlaw tools are disconnected"))).toHaveLength(1);
  expect(platform.sent[0]!.target.chatId).toBe("7");
});

test("watchdog: a dead process of a closed session is reported to the worker's owner once, not resurrected; restarts don't repeat it", async () => {
  const { mgr, provider, platform, health } = setup();
  store.set("worker-meta:worker:bricks", JSON.stringify({ cwd: join(dir, "repo"), profile: "main", owner: "tg:100", createdAt: 1 }));
  provider.closedInspect.set("worker:bricks", { process: "dead", exitStatus: 1 });
  provider.orphanList = [{ id: "uq-t-worker-gone", inspection: { process: "dead", exitStatus: 1 } }];
  await health.refresh();
  const h = health.of("worker:bricks")!;
  expect(h.process).toBe("dead");
  expect(h.issues[0]).toContain("exit status 1");
  expect(provider.specs).toEqual([]); // not opened / respawned
  expect(platform.sent).toHaveLength(1);
  expect(platform.sent[0]!.target.chatId).toBe("100");
  expect(mgr.listAgents().find((a) => a.name === "worker:bricks")!.health).toMatchObject({ process: "dead" });
  expect(health.sessions().find((s) => s.orphan)!.name).toBe("uq-t-worker-gone");
  await health.refresh();
  // A new daemon (new monitor, same store): still told only once.
  const again = new HealthMonitor(mgr, { link: () => undefined, startedAt: Date.now() }, silentLogger);
  await again.refresh();
  expect(platform.sent).toHaveLength(1);
});

test("watchdog: a session that died while running is respawned once (rate limited)", async () => {
  const { mgr, provider, health } = setup();
  provider.configure = (s) => { s.reattached = false; };
  const rt = mgr.runtime("tg:3");
  await rt.ensureOpen();
  sess(provider, "tg:3").emit({ type: "error", error: "claude process exited", fatal: true });
  await until(() => rt.state === "closed");
  provider.closedInspect.set("tg:3", { process: "dead", exitStatus: 1 });
  await health.refresh();
  expect(provider.specs).toHaveLength(2);
  expect(rt.state).toBe("idle");
  // Dies again right away: no second respawn within respawnEveryMs.
  sess(provider, "tg:3").emit({ type: "error", error: "claude process exited", fatal: true });
  await until(() => rt.state === "closed");
  await health.refresh();
  expect(provider.specs).toHaveLength(2);
});

test("watchdog: folder trust is answered only inside the allowed directories; elsewhere it is reported, never answered", async () => {
  const { mgr, provider, platform, health } = setup();
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "uq-outside-")));
  cleanups.push(() => rmSync(outside, { recursive: true, force: true }));
  provider.configure = (s, k) => {
    s.reattached = false;
    s.inspection = { process: "alive", blocker: { kind: "startup", label: "folder-trust" }, cwd: k === "tg:1" ? join(dir, "repo") : outside };
  };
  await mgr.runtime("tg:1").ensureOpen();
  await mgr.runtime("tg:2").ensureOpen();
  await health.refresh();
  expect(sess(provider, "tg:1").repairs).toEqual(["answer-startup-prompt"]);
  expect(sess(provider, "tg:2").repairs).toEqual([]);
  expect(health.of("tg:2")!.issues[0]).toContain("not answered");
  expect(platform.sent.map((m) => m.target.chatId)).toEqual(["2"]);
});

test("watchdog: a leftover /mcp dialog is closed on the second check; permission dialogs and unknown modals are never touched", async () => {
  const { mgr, provider, platform, health } = setup();
  provider.configure = (s, k) => {
    s.reattached = false;
    s.inspection = { process: "alive", blocker: k === "tg:1" ? { kind: "mcp-dialog" } : k === "tg:2" ? { kind: "permission" } : { kind: "modal", label: "Select model" } };
  };
  for (const k of ["tg:1", "tg:2", "tg:3"]) await mgr.runtime(k).ensureOpen();
  await health.refresh();
  expect(sess(provider, "tg:1").repairs).toEqual([]);
  await health.refresh();
  expect(sess(provider, "tg:1").repairs).toEqual(["close-dialog"]);
  expect(sess(provider, "tg:2").repairs).toEqual([]);
  expect(sess(provider, "tg:3").repairs).toEqual([]);
  expect(health.of("tg:2")!.issues).toContain("waiting on a permission dialog");
  expect(platform.sent.map((m) => m.target.chatId)).toEqual(["3"]); // the modal, once
  await health.refresh();
  expect(platform.sent).toHaveLength(1);
});

test("worker limit counts only workers with an open session", async () => {
  const { mgr } = setup({ settings: { workers: { max: 1 } } });
  store.set("worker-meta:worker:old", JSON.stringify({ cwd: dir, profile: "main", owner: "tg:1", createdAt: 1 }));
  // The closed "old" worker doesn't count: a new one may start…
  await mgr.startWorker("tg:1", { name: "fresh", profile: "main", cwd: join(dir, "repo") });
  // …but now one is running.
  await expect(mgr.startWorker("tg:1", { name: "third", profile: "main", cwd: join(dir, "repo") })).rejects.toThrow(/worker limit reached \(1 running: worker:fresh\)/);
});
