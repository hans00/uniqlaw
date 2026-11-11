// Graceful restart / reload: drain → persist → come back (docs §11.4).
//  1. request: returns at once (the requesting agent's own turn must be able to finish), optionally scheduled.
//  2. drain: no new turns; new input goes to deferred_input; running turns get restart.drainTimeoutSec.
//  3. persist: a restart record in state.db kv (who, why, interrupted turns, replayed input, open tasks).
//  4. come back: open tasks re-armed or failed, deferred input replayed, notices to the requester and to every
//     session whose turn was cut off — delivered as a new turn (a reattached claude-tmux session gets it too).
import { z } from "zod";
import type { ChannelManager, FailedTask, InflightTurn } from "./manager.ts";
import type { GatewayTool, Logger } from "./plugin.ts";
import type { Target } from "./platform.ts";
import type { StateStore } from "./state.ts";
import type { Settings } from "./config.ts";
import { originLabel, type Origin } from "./origin.ts";
import { formatTimestamp } from "./format.ts";

export type RestartKind = "restart" | "reload";

export interface RestartRequest {
  kind: RestartKind;
  /** Session key, or "cli" / "api" / "SIGHUP" … */
  requestedBy: string;
  reason?: string;
  /** Don't wait for running turns (they are recorded as interrupted right away). */
  now?: boolean;
  /** Fire at this time (ms epoch) instead of right away. */
  at?: number;
  /** Override restart.drainTimeoutSec. */
  drainTimeoutSec?: number;
}

/** A scheduled or draining request; several requests merge into one. */
interface Pending {
  id: string;
  kind: RestartKind;
  requestedBy: string[];
  reasons: string[];
  requestedAt: number;
  fireAt: number;
  now: boolean;
  drainTimeoutSec: number;
  /** Where each requesting session's notice reply goes (its root chat when it asked). */
  targets: Record<string, Target | null>;
}

export interface InterruptedTurn {
  channelKey: string;
  /** Who the turn was answering (origin labels). */
  answering: string[];
  /** The provider process survived (claude-tmux): the turn may have finished on its own after the restart. */
  detachable: boolean;
  /** Cut off (not detachable): its human message was queued again for after the restart. */
  resent?: boolean;
  target: Target | null;
}

/** Written just before the daemon stops; read (and deleted) by the next start. */
export interface RestartRecord {
  id: string;
  kind: RestartKind | "stop";
  requestedBy: string[];
  reasons: string[];
  requestedAt: number;
  stoppedAt: number;
  targets: Record<string, Target | null>;
  interrupted: InterruptedTurn[];
  /** Inputs deferred during the drain / still queued at stop (replayed after the start). */
  deferred: number;
  /** Tasks nobody had answered yet when the daemon stopped. */
  openTasks: { taskId: string; from: string; to: string; mode: string }[];
}

export interface RestartStatus {
  pending: boolean;
  /** While draining: a restart also scheduled for later. */
  scheduled?: { kind: RestartKind; fireAt: number; requestedBy: string[] };
  phase?: "scheduled" | "draining";
  kind?: RestartKind;
  fireAt?: number;
  requestedBy?: string[];
  reasons?: string[];
  inflight?: string[];
  deferred?: number;
}

const PENDING_KEY = "restart-pending";
/** Delay between accepting a request due now and starting the drain (lets the request's own reply go out). */
const START_DELAY_MS = 50;
export const RECORD_KEY = "restart-record";
/** kv: why the last restart could not start the new process and the old code was started again instead. */
export const RESTART_FALLBACK_KEY = "restart-fallback";
/** Job name of the notice turn (a scheduler origin, so its reply goes to the chat it names). */
export const RESTART_NOTICE_JOB = "uniqlaw-restart";

export interface RestartDeps {
  manager: ChannelManager;
  store: StateStore;
  log: Logger;
  settings: Settings;
  /** Throws if the on-disk settings are invalid (a restart with them would not come back up). */
  validate?: () => void;
  /** Stop this daemon and start the next one (in-process reload or a new process). Resolve false when nothing
   *  was stopped (e.g. the reload refused the settings): the drain ends and the daemon carries on. */
  execute(kind: RestartKind): void | boolean | Promise<void | boolean>;
  pollMs?: number;
}

export class RestartCoordinator {
  /** A restart asked for later (--in / --at): persisted, re-armed by the next daemon if it reloads meanwhile. */
  private scheduled?: Pending & { timer?: ReturnType<typeof setTimeout> };
  /** The restart being carried out now (draining). */
  private active?: Pending;
  /** Collected by prepare() (before sessions reopen), used by resume(). */
  private carried?: { record?: RestartRecord; failedTasks: FailedTask[] };
  private stopped = false;
  /** The previous process's record, as read by prepare() (kept after resume() deletes it). */
  private previous?: { kind: RestartRecord["kind"]; stoppedAt: number };

  constructor(private readonly d: RestartDeps) {}

  /** What the previous process recorded when it stopped (undefined: no record, e.g. a crash or a first start). */
  lastRestart() { return this.previous; }

  // ── request ──────────────────────────────────────────────────────────────

  /**
   * Ask for a restart. Returns at once. Due now → merged into the drain in progress (restart wins over reload) or
   * a new one. Due later → merged into the scheduled one (restart wins, earliest time wins). The two are separate:
   * `uniqlaw reload` before a 03:00 restart reloads now and keeps the 03:00 restart.
   */
  request(r: RestartRequest): RestartStatus {
    if (this.stopped) throw new Error("the daemon is already stopping");
    this.d.validate?.();
    const now = Date.now();
    const fireAt = Math.max(r.at ?? now, now);
    const target = this.requesterTarget(r.requestedBy);
    const timeout = r.drainTimeoutSec ?? this.d.settings.restart.drainTimeoutSec;
    const fresh = (): Pending => ({ id: crypto.randomUUID(), kind: r.kind, requestedBy: [], reasons: [], requestedAt: now, fireAt, now: false,
      drainTimeoutSec: timeout, targets: {} });
    const merge = (p: Pending) => {
      if (r.kind === "restart") p.kind = "restart";
      if (!p.requestedBy.includes(r.requestedBy)) p.requestedBy.push(r.requestedBy);
      if (r.reason) p.reasons.push(r.reason);
      p.now ||= !!r.now;
      p.drainTimeoutSec = Math.min(p.drainTimeoutSec, timeout);
      if (target !== undefined) p.targets[r.requestedBy] = target;
      return p;
    };
    if (fireAt > now) {
      const s = merge(this.scheduled ?? fresh());
      s.fireAt = Math.min(s.fireAt, fireAt);
      this.scheduled = s;
      this.arm();
      this.saveScheduled();
    } else if (this.active) {
      merge(this.active);
    } else {
      this.active = merge(fresh());
      // Not synchronously: the caller (an HTTP request, a tool call) must get its answer before the daemon stops.
      setTimeout(() => void this.run(), START_DELAY_MS);
    }
    this.d.log.info("restart requested", { kind: r.kind, by: r.requestedBy, reason: r.reason, at: new Date(fireAt).toISOString(), now: !!r.now });
    return this.status();
  }

  /** Cancel the drain in progress (held input is replayed right away) and any scheduled restart. */
  async cancel(): Promise<{ canceled: boolean; replayed: number }> {
    const had = !!(this.active || this.scheduled);
    clearTimeout(this.scheduled?.timer);
    this.scheduled = undefined;
    this.d.store.del(PENDING_KEY);
    this.active = undefined;
    const replayed = await this.d.manager.endDrain();
    if (had) this.d.log.info("restart canceled", { replayed });
    return { canceled: had, replayed };
  }

  status(): RestartStatus {
    const a = this.active;
    const s = this.scheduled;
    const sched = s ? { scheduled: { kind: s.kind, fireAt: s.fireAt, requestedBy: [...s.requestedBy] } } : {};
    if (a) {
      return { pending: true, phase: "draining", kind: a.kind, fireAt: a.fireAt, requestedBy: [...a.requestedBy], reasons: [...a.reasons],
        inflight: this.d.manager.inflightTurns().map((t) => t.channelKey), deferred: this.d.store.countDeferred(), ...sched };
    }
    if (s) return { pending: true, phase: "scheduled", kind: s.kind, fireAt: s.fireAt, requestedBy: [...s.requestedBy], reasons: [...s.reasons] };
    return { pending: false };
  }

  /** Re-arm a restart scheduled before the last reload. One whose time passed meanwhile is dropped: the daemon
   *  has restarted since it was asked for. */
  start() {
    const raw = this.d.store.get(PENDING_KEY);
    if (!raw) return;
    try {
      const p = JSON.parse(raw) as Pending;
      if (p.fireAt <= Date.now()) {
        this.d.store.del(PENDING_KEY);
        this.d.log.info("dropping a scheduled restart whose time passed while the daemon was down", { fireAt: new Date(p.fireAt).toISOString() });
        return;
      }
      this.scheduled = p;
      this.arm();
      this.d.log.info("scheduled restart re-armed", { kind: p.kind, at: new Date(p.fireAt).toISOString() });
    } catch { this.d.store.del(PENDING_KEY); }
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.scheduled?.timer);
  }

  private arm() {
    const s = this.scheduled!;
    clearTimeout(s.timer);
    s.timer = setTimeout(() => this.fireScheduled(s.id), Math.max(0, s.fireAt - Date.now()));
  }

  /** The scheduled time came: it becomes (or joins) the drain. */
  private fireScheduled(id: string) {
    const s = this.scheduled;
    if (!s || s.id !== id || this.stopped) return;
    this.scheduled = undefined;
    this.d.store.del(PENDING_KEY);
    const { timer: _t, ...p } = s;
    if (this.active) {
      const a = this.active;
      if (p.kind === "restart") a.kind = "restart";
      for (const w of p.requestedBy) if (!a.requestedBy.includes(w)) a.requestedBy.push(w);
      a.reasons.push(...p.reasons);
      Object.assign(a.targets, p.targets);
      return;
    }
    this.active = p;
    void this.run();
  }

  private saveScheduled() {
    const { timer: _t, ...p } = this.scheduled!;
    this.d.store.set(PENDING_KEY, JSON.stringify(p));
  }

  /** Where a requesting session's notice reply goes: its chat; undefined = not a session (cli, api, signal);
   *  null = a session without a chat of its own (worker, cron, …: background routing). */
  private requesterTarget(who: string): Target | null | undefined {
    const m = this.d.manager;
    if (!this.d.store.getSession(who) && !m.runtimes.has(who)) return undefined;
    if (m.kindOf(who) !== "chat") return null;
    return m.runtimes.get(who)?.rootTarget() ?? m.runtimes.get(who)?.lastTarget() ?? null;
  }

  // ── drain → persist → execute ─────────────────────────────────────────────

  private async run() {
    const p = this.active;
    if (!p || this.stopped) return;
    const m = this.d.manager;
    m.beginDrain();
    const started = Date.now();
    this.d.log.info("restart: draining", { kind: p.kind, inflight: m.inflightTurns().map((t) => t.channelKey), timeoutSec: p.now ? 0 : p.drainTimeoutSec });
    // p.now / drainTimeoutSec may change while we wait (a merged request): re-read them every poll.
    while (m.inflightTurns().length && !p.now && Date.now() < started + p.drainTimeoutSec * 1000) {
      await Bun.sleep(this.d.pollMs ?? 200);
      if (this.active !== p) return; // canceled
    }
    if (this.active !== p || this.stopped) return;
    try { this.d.validate?.(); } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.d.log.error("restart aborted: settings are invalid", { msg });
      this.tellRequesters(p, `settings.json is invalid, the daemon keeps running: ${msg}`);
      this.active = undefined;
      await m.endDrain();
      return;
    }
    this.persist(p);
    this.active = undefined;
    this.stopped = true;
    this.d.log.info("restart: executing", { kind: p.kind });
    let done: boolean | void = undefined;
    try { done = await this.d.execute(p.kind); }
    catch (e) { this.d.log.error("restart failed", { e: String(e) }); done = false; }
    if (done === false) {
      // Nothing was stopped (e.g. the reload refused the settings): take the record back and resume normal work.
      this.d.store.del(RECORD_KEY);
      this.stopped = false;
      this.tellRequesters(p, "the daemon could not restart and keeps running (see the daemon log)");
      await m.endDrain();
    }
  }

  private tellRequesters(p: Pending, text: string) {
    for (const who of p.requestedBy) {
      if (this.d.store.getSession(who)) this.d.store.pushPending(who, "peer-result", { label: `uniqlaw: your ${p.kind} was aborted`, text });
    }
  }

  /** Stop without a drain (SIGTERM / `uniqlaw stop`): record what was running so the next start tells them. */
  recordStop(by: string) {
    if (this.d.store.get(RECORD_KEY)) return; // a restart already wrote its record
    this.d.manager.beginDrain();
    this.persist({ id: crypto.randomUUID(), kind: "stop", requestedBy: [by], reasons: [], requestedAt: Date.now(), targets: {} });
  }

  private persist(p: Pick<Pending, "id" | "requestedBy" | "reasons" | "requestedAt" | "targets"> & { kind: RestartRecord["kind"] }) {
    const m = this.d.manager;
    const interrupted = m.inflightTurns().map((t) => ({ ...this.interruptedOf(t), ...(m.requeueCutOff(t) ? { resent: true } : {}) }));
    const flushed = m.flushQueuesForRestart();
    const rec: RestartRecord = {
      id: p.id, kind: p.kind, requestedBy: p.requestedBy, reasons: p.reasons, requestedAt: p.requestedAt, stoppedAt: Date.now(), targets: p.targets,
      interrupted, deferred: this.d.store.countDeferred(),
      openTasks: this.d.store.openTasks().map((t) => ({ taskId: t.taskId, from: t.fromSession, to: t.toSession, mode: t.mode })),
    };
    this.d.store.set(RECORD_KEY, JSON.stringify(rec));
    this.d.log.info("restart record written", { kind: p.kind, interrupted: interrupted.map((i) => i.channelKey), deferred: rec.deferred, flushed, openTasks: rec.openTasks.length });
  }

  private interruptedOf(t: InflightTurn): InterruptedTurn {
    const m = this.d.manager;
    // Only a chat's notice reply goes to a chat; workers / internal sessions follow their background routing.
    const target = m.kindOf(t.channelKey) === "chat" ? rootOf(t.origins) ?? m.runtimes.get(t.channelKey)?.lastTarget() ?? null : null;
    return { channelKey: t.channelKey, answering: t.origins.map(originLabel), detachable: t.detachable, target };
  }

  // ── come back ────────────────────────────────────────────────────────────

  /** First half of the comeback, before sessions are restored (reopening one consumes its inflight-turn key):
   *  re-arm or fail the previous process's open tasks. Nothing is sent yet. */
  prepare() {
    this.d.store.unclaimDeferred(); // claims of a previous process: its queues are gone, replay those rows again
    const raw = this.d.store.get(RECORD_KEY);
    let record: RestartRecord | undefined;
    if (raw) { try { record = JSON.parse(raw) as RestartRecord; } catch { this.d.log.warn("unreadable restart record; ignored"); } }
    if (record) this.previous = { kind: record.kind, stoppedAt: record.stoppedAt };
    const failedTasks = this.d.manager.resumeTasks(record ? new Set(record.openTasks.map((t) => t.taskId)) : undefined);
    this.carried = { ...(record ? { record } : {}), failedTasks };
  }

  /** Second half, once platforms are up: replay deferred input, tell askers about failed tasks, send the notices.
   *  Replayed input is at-least-once (see replayDeferred). The record is deleted before any notice is sent, so a
   *  crash in here never notifies twice: notices are at-most-once. */
  async resume(): Promise<{ record?: RestartRecord; replayed: number; notified: string[] }> {
    if (!this.carried) this.prepare();
    const { record, failedTasks } = this.carried!;
    this.carried = undefined;
    this.d.store.del(RECORD_KEY);
    const fallback = this.d.store.get(RESTART_FALLBACK_KEY);
    this.d.store.del(RESTART_FALLBACK_KEY);
    const m = this.d.manager;
    const replayed = await m.replayDeferred();
    m.reportFailedTasks(failedTasks);
    if (!record) return { replayed, notified: [] };
    const tz = this.d.settings.timezone;
    const verb = fallback ? `restart FAILED (${fallback}); the previous code was started again` : record.kind === "reload" ? "reloaded" : record.kind === "stop" ? "was stopped and started again" : "restarted";
    const why = record.reasons.length ? record.reasons.join("; ") : "none given";
    const interrupted = record.interrupted.length
      ? record.interrupted.map((i) => `${i.channelKey} (answering ${i.answering.join(", ") || "background"}${i.detachable ? "; its process survived, the turn may have finished on its own" : "; cut off"})`).join(", ")
      : "none";
    const failed = failedTasks.length ? ` Tasks that failed: ${failedTasks.map((t) => `${t.taskId} (${t.from} → ${t.to})`).join(", ")}.` : "";
    const head = `[uniqlaw] daemon ${verb} at ${formatTimestamp(new Date(), tz)} (stopped ${formatTimestamp(new Date(record.stoppedAt), tz)}; reason: ${why}; requested by ${record.requestedBy.join(", ")}).`
      + ` Interrupted: ${interrupted}. Queued messages replayed: ${replayed}.${failed}`;
    const notices = new Map<string, { text: string[]; target: Target | null }>();
    const add = (key: string, text: string, target: Target | null) => {
      const n = notices.get(key) ?? { text: [head], target };
      n.text.push(text);
      n.target ??= target;
      notices.set(key, n);
    };
    for (const who of record.requestedBy) {
      if (!(who in record.targets)) continue; // not a session
      add(who, "You asked for this. Confirm to your human that it is back, then carry on.", record.targets[who] ?? null);
    }
    for (const i of record.interrupted) {
      add(i.channelKey, i.detachable
        ? `Your turn (answering ${i.answering.join(", ") || "background work"}) was still running when the daemon stopped. Your session survived: if it finished meanwhile, its reply was delivered when the session was reattached, so nothing to do; otherwise resume it.`
        : i.resent
          ? `Your turn (answering ${i.answering.join(", ") || "background work"}) was cut off when the daemon stopped and its reply was not delivered. The message it was answering is re-sent with this notice: answer it now (anything that turn already did, such as file edits, may be half done — check first).`
          : `Your turn (answering ${i.answering.join(", ") || "background work"}) was cut off when the daemon stopped and its reply was not delivered. Resume it or tell them what happened.`, i.target);
    }
    for (const [key, n] of notices) {
      try {
        await m.deliverSystemTurn(key, "uniqlaw: daemon restart notice", {
          origin: { kind: "scheduler", job: RESTART_NOTICE_JOB, ...(n.target ? { deliverTo: n.target } : {}) },
          item: { text: n.text.join("\n"), receivedAt: Date.now(), sourceLine: "[UniQlaw system notice]", raw: true },
          attachments: [],
        });
      } catch (e) { this.d.log.warn("restart notice failed", { key, e: String(e) }); }
    }
    this.d.log.info("back from restart", { kind: record.kind, replayed, notified: [...notices.keys()] });
    return { record, replayed, notified: [...notices.keys()] };
  }

  // ── agent tool ───────────────────────────────────────────────────────────

  /** daemon_restart: operators' own chat sessions only, in a turn the operator started (until per-channel tool policy
   *  gates it with "config"). */
  tools(): GatewayTool[] {
    return [{
      name: "daemon_restart",
      description: "Restart (new process: new code + settings) or reload (settings only) the UniQlaw daemon, gracefully. Returns at once: "
        + "your current turn finishes and its reply is delivered first; new messages wait and are replayed afterwards. When it is back you get a "
        + "[uniqlaw] notice as a new turn. Only the operator's own chat may call it.",
      inputSchema: {
        kind: z.enum(["restart", "reload"]).optional().describe("default restart"),
        reason: z.string().optional(),
        in: z.string().optional().describe("delay, e.g. \"90s\", \"10m\", \"1h30m\""),
        at: z.string().optional().describe("time: ISO 8601, or HH:MM (next occurrence, daemon timezone)"),
        now: z.boolean().optional().describe("don't wait for running turns (they are recorded as interrupted)"),
        cancel: z.boolean().optional().describe("cancel a pending restart"),
      },
      handler: async (a, caller) => {
        if (!this.d.manager.isOperatorChat(caller)) throw new Error("daemon_restart is only available in an operator's own chat session");
        // Not on behalf of someone else: agent_ask / agent_trigger / cron turns reaching the operator's session are refused.
        if (!this.d.manager.turnFromOperator(caller)) throw new Error("daemon_restart needs a message from the operator in this turn (not a peer, cron or async-result turn)");
        if (a.cancel) return this.cancel();
        const at = parseWhen({ in: a.in as string | undefined, at: a.at as string | undefined }, this.d.settings.timezone);
        return this.request({ kind: (a.kind as RestartKind | undefined) ?? "restart", requestedBy: caller, reason: a.reason as string | undefined,
          now: !!a.now, ...(at ? { at } : {}) });
      },
    }];
  }
}

function rootOf(origins: Origin[]): Target | undefined {
  for (const o of [...origins].reverse()) {
    if (o.kind === "human") return o.replyTarget;
    if (o.kind === "peer" && (o.deliverTo || o.rootTarget)) return o.mode === "trigger" ? o.deliverTo : o.rootTarget;
    if (o.kind === "scheduler" && o.deliverTo) return o.deliverTo;
  }
  return undefined;
}

/** "90", "90s", "10m", "1h30m", "2d" → milliseconds. */
export function parseDuration(s: string): number {
  const t = s.trim();
  if (/^\d+$/.test(t)) return Number(t) * 1000;
  const re = /(\d+)\s*(ms|s|m|h|d)/gy;
  const unit: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  let total = 0;
  let m: RegExpExecArray | null;
  let end = 0;
  while ((m = re.exec(t))) { total += Number(m[1]) * unit[m[2]!]!; end = re.lastIndex; }
  if (!end || end !== t.length) throw new Error(`invalid duration "${s}" (e.g. 90s, 10m, 1h30m)`);
  return total;
}

/** --in / --at → fire time (ms epoch), undefined = now. HH:MM is the next such wall time in `tz`. */
export function parseWhen(o: { in?: string; at?: string }, tz: string, now = Date.now()): number | undefined {
  if (o.in && o.at) throw new Error("give either in or at, not both");
  if (o.in) return now + parseDuration(o.in);
  if (!o.at) return undefined;
  const hm = o.at.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (hm) {
    const [h, m] = [Number(hm[1]), Number(hm[2])];
    if (h > 23 || m > 59) throw new Error(`invalid time "${o.at}"`);
    // Wall time in tz: start from "now" in tz and step to the next matching minute.
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "numeric", second: "numeric", hourCycle: "h23" })
      .formatToParts(new Date(now)).reduce<Record<string, number>>((acc, p) => (p.type !== "literal" ? { ...acc, [p.type]: Number(p.value) } : acc), {});
    const nowMin = parts.hour! * 60 + parts.minute!;
    let delta = h * 60 + m - nowMin;
    if (delta <= 0) delta += 24 * 60;
    return now - (parts.second! * 1000 + (now % 1000)) + delta * 60_000;
  }
  const t = Date.parse(o.at);
  if (Number.isNaN(t)) throw new Error(`invalid time "${o.at}" (ISO 8601 or HH:MM)`);
  return t;
}
