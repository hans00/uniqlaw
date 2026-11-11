// Graceful restart / reload: drain → persist → come back (docs §11.4).
//  1. request: returns at once (the requesting agent's own turn must be able to finish), optionally scheduled.
//  2. drain: no new turns; new input goes to deferred_input; running turns get restart.drainTimeoutSec.
//  3. persist: a restart record in state.db kv (who, why, interrupted turns, replayed input, open tasks).
//  4. come back: open tasks re-armed or failed, deferred input replayed, notices to the requester and to every
//     session whose turn was cut off — delivered as a new turn (a reattached claude-tmux session gets it too).
import { z } from "zod";
import type { ChannelManager, InflightTurn } from "./manager.ts";
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

/** A pending (scheduled or draining) request; several requests merge into one. */
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
  phase?: "scheduled" | "draining";
  kind?: RestartKind;
  fireAt?: number;
  requestedBy?: string[];
  reasons?: string[];
  inflight?: string[];
  deferred?: number;
}

const PENDING_KEY = "restart-pending";
export const RECORD_KEY = "restart-record";
/** Job name of the notice turn (a scheduler origin, so its reply goes to the chat it names). */
export const RESTART_NOTICE_JOB = "uniqlaw-restart";

export interface RestartDeps {
  manager: ChannelManager;
  store: StateStore;
  log: Logger;
  settings: Settings;
  /** Throws if the on-disk settings are invalid (a restart with them would not come back up). */
  validate?: () => void;
  /** Stop this daemon and start the next one (in-process reload or a new process). */
  execute(kind: RestartKind): void | Promise<void>;
  pollMs?: number;
}

export class RestartCoordinator {
  private pending?: Pending & { phase: "scheduled" | "draining"; timer?: ReturnType<typeof setTimeout> };
  /** Collected by prepare() (before sessions reopen), used by resume(). */
  private carried?: { record?: RestartRecord; failedTasks: { taskId: string; from: string; to: string }[] };
  private stopped = false;

  constructor(private readonly d: RestartDeps) {}

  // ── request ──────────────────────────────────────────────────────────────

  request(r: RestartRequest): RestartStatus {
    if (this.stopped) throw new Error("the daemon is already stopping");
    this.d.validate?.();
    const now = Date.now();
    const fireAt = Math.max(r.at ?? now, now);
    const target = this.requesterTarget(r.requestedBy);
    const timeout = r.drainTimeoutSec ?? this.d.settings.restart.drainTimeoutSec;
    const p = this.pending;
    if (p) {
      // Merge: restart wins over reload, the earliest time wins, "now" sticks.
      if (r.kind === "restart") p.kind = "restart";
      if (!p.requestedBy.includes(r.requestedBy)) p.requestedBy.push(r.requestedBy);
      if (r.reason) p.reasons.push(r.reason);
      p.now ||= !!r.now;
      p.drainTimeoutSec = Math.min(p.drainTimeoutSec, timeout);
      if (target !== undefined) p.targets[r.requestedBy] = target;
      if (p.phase === "scheduled" && fireAt < p.fireAt) { p.fireAt = fireAt; this.arm(); }
    } else {
      this.pending = { id: crypto.randomUUID(), kind: r.kind, requestedBy: [r.requestedBy], reasons: r.reason ? [r.reason] : [], requestedAt: now,
        fireAt, now: !!r.now, drainTimeoutSec: timeout, targets: target !== undefined ? { [r.requestedBy]: target } : {}, phase: "scheduled" };
      this.arm();
    }
    this.savePending();
    this.d.log.info("restart requested", { kind: r.kind, by: r.requestedBy, reason: r.reason, at: new Date(fireAt).toISOString(), now: !!r.now });
    return this.status();
  }

  /** Cancel a scheduled or draining restart; input deferred so far is replayed right away. */
  async cancel(): Promise<{ canceled: boolean; replayed: number }> {
    const p = this.pending;
    if (!p) return { canceled: false, replayed: 0 };
    clearTimeout(p.timer);
    this.pending = undefined;
    this.d.store.del(PENDING_KEY);
    const replayed = await this.d.manager.endDrain();
    this.d.log.info("restart canceled", { replayed });
    return { canceled: true, replayed };
  }

  status(): RestartStatus {
    const p = this.pending;
    if (!p) return { pending: false };
    return { pending: true, phase: p.phase, kind: p.kind, fireAt: p.fireAt, requestedBy: [...p.requestedBy], reasons: [...p.reasons],
      ...(p.phase === "draining" ? { inflight: this.d.manager.inflightTurns().map((t) => t.channelKey), deferred: this.d.store.countDeferred() } : {}) };
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
      this.pending = { ...p, phase: "scheduled" };
      this.arm();
      this.d.log.info("scheduled restart re-armed", { kind: p.kind, at: new Date(p.fireAt).toISOString() });
    } catch { this.d.store.del(PENDING_KEY); }
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.pending?.timer);
  }

  private arm() {
    const p = this.pending!;
    clearTimeout(p.timer);
    p.timer = setTimeout(() => void this.run(p.id), Math.max(0, p.fireAt - Date.now()));
  }

  private savePending() {
    const { timer: _t, phase: _p, ...p } = this.pending!;
    this.d.store.set(PENDING_KEY, JSON.stringify(p));
  }

  private requesterTarget(who: string): Target | null | undefined {
    const m = this.d.manager;
    if (!this.d.store.getSession(who) && !m.runtimes.has(who)) return undefined; // not a session (cli, api, signal)
    return m.runtimes.get(who)?.rootTarget() ?? m.runtimes.get(who)?.lastTarget() ?? null;
  }

  // ── drain → persist → execute ─────────────────────────────────────────────

  private async run(id: string) {
    const p = this.pending;
    if (!p || p.id !== id || this.stopped) return;
    p.phase = "draining";
    const m = this.d.manager;
    m.beginDrain();
    const deadline = Date.now() + (p.now ? 0 : p.drainTimeoutSec * 1000);
    this.d.log.info("restart: draining", { kind: p.kind, inflight: m.inflightTurns().map((t) => t.channelKey), timeoutSec: p.now ? 0 : p.drainTimeoutSec });
    while (m.inflightTurns().length && Date.now() < deadline) {
      await Bun.sleep(this.d.pollMs ?? 200);
      if (this.pending?.id !== id) return; // canceled
    }
    if (this.pending?.id !== id || this.stopped) return;
    try { this.d.validate?.(); } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.d.log.error("restart aborted: settings are invalid", { msg });
      for (const who of p.requestedBy) {
        if (this.d.store.getSession(who)) this.d.store.pushPending(who, "peer-result", { label: "uniqlaw: your restart was aborted", text: `settings.json is invalid, the daemon keeps running: ${msg}` });
      }
      await this.cancel();
      return;
    }
    this.persist({ ...p, kind: p.kind });
    this.d.store.del(PENDING_KEY);
    this.pending = undefined;
    this.stopped = true;
    this.d.log.info("restart: executing", { kind: p.kind });
    try { await this.d.execute(p.kind); }
    catch (e) { this.d.log.error("restart failed", { e: String(e) }); }
  }

  /** Stop without a drain (SIGTERM / `uniqlaw stop`): record what was running so the next start tells them. */
  recordStop(by: string) {
    if (this.d.store.get(RECORD_KEY)) return; // a restart already wrote its record
    this.d.manager.beginDrain();
    const p = this.pending;
    this.persist({ id: crypto.randomUUID(), kind: "stop", requestedBy: [by], reasons: p?.reasons ?? [], requestedAt: Date.now(), targets: {} });
  }

  private persist(p: Pick<Pending, "id" | "requestedBy" | "reasons" | "requestedAt" | "targets"> & { kind: RestartRecord["kind"] }) {
    const m = this.d.manager;
    const interrupted = m.inflightTurns().map((t) => this.interruptedOf(t));
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
    const rt = this.d.manager.runtimes.get(t.channelKey);
    return { channelKey: t.channelKey, answering: t.origins.map(originLabel), detachable: t.detachable,
      target: rootOf(t.origins) ?? rt?.lastTarget() ?? null };
  }

  // ── come back ────────────────────────────────────────────────────────────

  /** First half of the comeback, before sessions are restored (reopening one consumes its inflight-turn key):
   *  re-arm or fail the previous process's open tasks. */
  prepare() {
    const raw = this.d.store.get(RECORD_KEY);
    let record: RestartRecord | undefined;
    if (raw) { try { record = JSON.parse(raw) as RestartRecord; } catch { this.d.log.warn("unreadable restart record; ignored"); } }
    const failedTasks = this.d.manager.resumeTasks();
    this.carried = { ...(record ? { record } : {}), failedTasks };
  }

  /** Second half, once platforms are up: replay deferred input and send the notices. The record is deleted
   *  before anything is sent, so a crash in here never notifies twice (at-most-once, like the replay). */
  async resume(): Promise<{ record?: RestartRecord; replayed: number; notified: string[] }> {
    if (!this.carried) this.prepare();
    const { record, failedTasks } = this.carried!;
    this.carried = undefined;
    this.d.store.del(RECORD_KEY);
    const replayed = await this.d.manager.replayDeferred();
    if (!record) return { replayed, notified: [] };
    const tz = this.d.settings.timezone;
    const verb = record.kind === "reload" ? "reloaded" : record.kind === "stop" ? "was stopped and started again" : "restarted";
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
        ? `Your turn (answering ${i.answering.join(", ") || "background work"}) was still running when the daemon stopped. Your session survived, so it may have finished on its own: if its reply already went out, nothing to do; otherwise resume it.`
        : `Your turn (answering ${i.answering.join(", ") || "background work"}) was cut off when the daemon stopped and its reply was not delivered. Resume it or tell them what happened.`, i.target);
    }
    for (const [key, n] of notices) {
      try {
        await this.d.manager.runtime(key).enqueue({
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

  /** daemon_restart: operators' own chat sessions only (until per-channel tool policy gates it with "config"). */
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
