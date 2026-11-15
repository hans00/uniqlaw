// Session health (docs §11.4): what every session's provider process looks like (alive / dead / blocked on a
// prompt or dialog), whether its MCP client is connected to the gateway, and the repairs that are safe to do on
// their own:
//  - MCP recovery: a session the gateway has not heard from since it started (a daemon restart is an outage Claude
//    Code does not recover from by itself), or whose event-stream went away and stayed away, is reconnected through
//    the provider (claude-tmux: /mcp → Reconnect), only while it is idle and nobody holds it, then verified by the
//    gateway seeing an `initialize`. If that fails: one respawn with resume (rate limited).
//  - Before a reattached session's first turn, the same check runs first, so the turn has its tools.
//  - Pane watchdog: a live session whose process died is respawned (rate limited); a folder-trust prompt is answered
//    only for a directory inside workers.roots / the project; a leftover MCP dialog is closed once it has sat there for
//    two checks; anything else (unknown prompt or modal, a dead process of a closed session) is only reported:
//    status shows it and the owner chat is told once per condition (persisted, so a restart does not repeat it).
//    Permission and question dialogs belong to the approval path and are never touched.
import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { ChannelManager } from "./manager.ts";
import type { PaneInspection } from "./provider.ts";
import type { Logger } from "./plugin.ts";
import { mcpLinkState, type McpLink, type McpLinkState } from "./gateway.ts";

export interface McpRecovery { at: number; outcome: string; detail: string }

export interface SessionHealth {
  name: string;
  process: PaneInspection["process"] | "unknown";
  exitStatus?: number;
  /** "startup:folder-trust", "permission", "mcp-dialog", "modal:<title>". */
  blocked?: string;
  mcp?: { state: McpLinkState | "recovering"; streams: number; lastRequestAt?: number; lastInitializeAt?: number; lastRecovery?: McpRecovery };
  /** A provider process that belongs to no known session. */
  orphan?: boolean;
  /** Plain-language problems, empty when healthy. */
  issues: string[];
  checkedAt: number;
}

export interface HealthOptions {
  /** How often the MCP policy runs (cheap: gateway state only). */
  tickMs: number;
  /** How often every session's process is inspected. */
  inspectEveryMs: number;
  /** A reattached session gets this long (from gateway start / session open) to reconnect by itself. */
  mcpGraceMs: number;
  /** An event-stream gone this long with no request since: lost. */
  streamLossMs: number;
  /** At most one reconnect attempt per session this often (skipped attempts don't count). */
  reconnectEveryMs: number;
  /** At most one automatic respawn per session this often. */
  respawnEveryMs: number;
  /** Wait for a respawned process to connect to the gateway. */
  respawnVerifyMs: number;
}

export const HEALTH_DEFAULTS: HealthOptions = {
  tickMs: 10_000, inspectEveryMs: 60_000, mcpGraceMs: 15_000, streamLossMs: 60_000,
  reconnectEveryMs: 10 * 60_000, respawnEveryMs: 30 * 60_000, respawnVerifyMs: 45_000,
};

export interface GatewayView {
  link(channelKey: string): McpLink | undefined;
  /** When the gateway started listening. */
  startedAt: number;
}

const NOTIFIED = "health-notified:";
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class HealthMonitor {
  private o: HealthOptions;
  private timer?: ReturnType<typeof setInterval>;
  private health = new Map<string, SessionHealth>();
  private orphans: SessionHealth[] = [];
  private lastInspectAt = 0;
  private inspecting?: Promise<void>;
  private recovering = new Map<string, Promise<void>>();
  private lastReconnect = new Map<string, number>();
  private lastRespawn = new Map<string, number>();
  private lastRecovery = new Map<string, McpRecovery>();
  /** Blocker seen on the previous inspection, per session (repairs wait for it to persist). */
  private prevBlocker = new Map<string, string>();
  /** Sessions whose MCP was checked (or found fine) in this daemon run. */
  private mcpOk = new Set<string>();
  private stopped = false;
  /** Aborts recoveries in progress when the daemon stops (the driver goes back to an empty prompt). */
  private abort = new AbortController();

  constructor(private manager: ChannelManager, private gateway: GatewayView, private log: Logger, opts: Partial<HealthOptions> = {}) {
    this.o = { ...HEALTH_DEFAULTS, ...opts };
  }

  start() {
    this.timer = setInterval(() => void this.tick(), this.o.tickMs);
  }

  /** Stop, and let recoveries in progress back out of the pane (bounded: shutdown must not hang on it). */
  async stop(maxWaitMs = 8000) {
    this.stopped = true;
    clearInterval(this.timer);
    this.abort.abort();
    const running = [...this.recovering.values()];
    if (running.length) await Promise.race([Promise.allSettled(running), sleep(maxWaitMs)]);
  }

  /** No repairs while stopping or draining for a restart. */
  private get paused(): boolean { return this.stopped || this.manager.isDraining; }

  /** One pass: MCP policy for every open session; process inspection when due. */
  async tick(now = Date.now()) {
    if (this.paused) return;
    for (const [key, rt] of this.manager.runtimes) {
      if (rt.state === "closed" || rt.state === "opening") continue;
      if (this.mcpDue(key, now)) void this.recoverMcp(key, "periodic");
    }
    if (now - this.lastInspectAt >= this.o.inspectEveryMs && !this.inspecting) {
      this.lastInspectAt = now;
      this.inspecting = this.inspectAll().catch((e) => this.log.warn("health inspection failed", { e: String(e) })).finally(() => { this.inspecting = undefined; });
      await this.inspecting;
    }
  }

  // ── MCP ──────────────────────────────────────────────────────────────────

  /** The session's MCP client looks disconnected and a reconnect may be tried now. */
  private mcpDue(key: string, now: number): boolean {
    const rt = this.manager.runtimes.get(key);
    if (!rt || !rt.repairs.reconnectMcp || !this.manager.hasMcp(key)) return false;
    if (this.recovering.has(key)) return false;
    if (now - (this.lastReconnect.get(key) ?? 0) < this.o.reconnectEveryMs) return false;
    const link = this.gateway.link(key);
    const since = Math.max(this.gateway.startedAt, rt.openedAt);
    if (mcpLinkState(link) === "unknown") return now - since >= this.o.mcpGraceMs;
    // Its event-stream went away and nothing came from it since.
    return !!link && link.streams === 0 && !!link.streamClosedAt && (link.lastRequestAt ?? 0) <= link.streamClosedAt
      && now - link.streamClosedAt >= this.o.streamLossMs;
  }

  /**
   * Before a session's first turn in this daemon run: if its MCP client hasn't been heard from, give it the rest of
   * the grace period, then reconnect it (the session is idle: the turn waits for this). Never throws.
   */
  async beforeFirstTurn(key: string): Promise<void> {
    if (this.mcpOk.has(key)) return;
    const rt = this.manager.runtimes.get(key);
    // A process spawned by this daemon connects at startup; only one that lived through the restart may have lost it.
    if (!rt?.repairs.reconnectMcp || !this.manager.hasMcp(key) || !rt.reattached) { this.mcpOk.add(key); return; }
    const deadline = Math.max(this.gateway.startedAt, rt.openedAt) + this.o.mcpGraceMs;
    while (mcpLinkState(this.gateway.link(key)) === "unknown" && Date.now() < deadline && !this.stopped) await sleep(250);
    if (mcpLinkState(this.gateway.link(key)) !== "unknown") { this.mcpOk.add(key); return; }
    await this.recoverMcp(key, "before first turn", { pendingInput: true });
    this.mcpOk.add(key); // one try; the periodic policy keeps watching
  }

  /** Reconnect (and if that fails, respawn) one session's MCP client. Single-flight per session. */
  recoverMcp(key: string, why: string, o: { pendingInput?: boolean } = {}): Promise<void> {
    const running = this.recovering.get(key);
    if (running) return running;
    const p = this.doRecoverMcp(key, why, o).catch((e) => this.log.warn("mcp recovery failed", { key, e: String(e) }))
      .finally(() => this.recovering.delete(key));
    this.recovering.set(key, p);
    return p;
  }

  private async doRecoverMcp(key: string, why: string, o: { pendingInput?: boolean }) {
    const rt = this.manager.runtimes.get(key);
    if (!rt || this.manager.heldBy(key) || this.paused) return;
    const verify = (since: number) => (this.gateway.link(key)?.lastInitializeAt ?? 0) >= since;
    const run = o.pendingInput ? rt.maintainWithInput.bind(rt) : rt.maintain.bind(rt);
    const r = await run((s) => s.reconnectMcp!(verify, this.abort.signal));
    if (!r || r.outcome === "skipped") return; // not idle right now: try again on a later tick
    const now = Date.now();
    this.lastReconnect.set(key, now);
    this.record(key, { at: now, outcome: r.outcome, detail: r.detail });
    this.log[r.ok ? "info" : "warn"]("mcp reconnect", { key, why, outcome: r.outcome, detail: r.detail });
    if (r.ok) { this.mcpOk.add(key); return; }
    if (r.outcome === "aborted") { this.lastReconnect.set(key, now - this.o.reconnectEveryMs + 60_000); return; } // a turn started: retry in a minute
    if (this.paused) return;
    // Reconnect failed: respawn with resume (a fresh claude connects at startup), rate limited.
    if (!rt.repairs.respawn || now - (this.lastRespawn.get(key) ?? 0) < this.o.respawnEveryMs) {
      await this.notifyOnce(key, "mcp", `⚠️ ${key}: its UniQlaw tools are disconnected and reconnecting failed (${r.detail}). Restarting the session or sending /mcp in its terminal fixes it.`);
      return;
    }
    this.lastRespawn.set(key, now);
    const t0 = Date.now();
    const respawned = await run((s) => s.respawn!());
    let connected = false;
    if (respawned) {
      const until = Date.now() + this.o.respawnVerifyMs;
      while (!(connected = verify(t0)) && Date.now() < until && !this.stopped) await sleep(250);
    }
    this.record(key, { at: Date.now(), outcome: connected ? "respawned" : "respawn-failed", detail: respawned ? (connected ? "respawned with resume; MCP connected" : "respawned, but MCP did not connect") : "respawn not possible now" });
    this.log[connected ? "info" : "warn"]("mcp recovery by respawn", { key, respawned, connected });
    if (connected) { this.mcpOk.add(key); await this.clearNotified(key, "mcp"); }
    else await this.notifyOnce(key, "mcp", `⚠️ ${key}: its UniQlaw tools are disconnected; reconnecting and restarting it both failed.`);
  }

  private record(key: string, r: McpRecovery) {
    this.lastRecovery.set(key, r);
  }

  // ── pane watchdog ────────────────────────────────────────────────────────

  private async inspectAll() {
    const now = Date.now();
    const keys = this.manager.knownSessionKeys();
    const seen = new Map<string, SessionHealth>();
    for (const key of keys) {
      if (this.stopped) return;
      const h = await this.inspectOne(key, now).catch((e) => ({ name: key, process: "unknown" as const, issues: [`inspection failed: ${String(e)}`], checkedAt: now }));
      seen.set(key, h);
    }
    this.health = seen;
    this.orphans = await this.findOrphans(keys, now);
  }

  private async inspectOne(key: string, now: number): Promise<SessionHealth> {
    const rt = this.manager.runtimes.get(key);
    const open = !!rt && rt.state !== "closed" && rt.state !== "opening";
    const insp = (open ? await rt!.inspect() : undefined) ?? await this.manager.inspectClosed(key);
    const h: SessionHealth = { name: key, process: insp?.process ?? "unknown", issues: [], checkedAt: now,
      ...(insp?.exitStatus !== undefined ? { exitStatus: insp.exitStatus } : {}) };
    const blocked = insp?.blocker ? (insp.blocker.label ? `${insp.blocker.kind}:${insp.blocker.label}` : insp.blocker.kind) : undefined;
    if (blocked) h.blocked = blocked;
    const prev = this.prevBlocker.get(key);
    if (blocked) this.prevBlocker.set(key, blocked); else this.prevBlocker.delete(key);
    const held = this.manager.heldBy(key) ?? (this.paused ? "shutdown" : undefined); // no repairs while stopping / draining

    // ── dead process ──
    if (insp?.process === "dead") {
      const died = rt?.died;
      if (died && rt!.state === "closed" && now - (this.lastRespawn.get(key) ?? 0) >= this.o.respawnEveryMs && !held) {
        // It was running in this daemon and died: start it again once (resume keeps the conversation).
        this.lastRespawn.set(key, now);
        this.log.warn("session process died; respawning", { key, reason: died.reason });
        await rt!.ensureOpen();
        if (rt!.state !== "closed") { h.process = "alive"; h.issues.push(`process died (${died.reason}); respawned`); await this.clearNotified(key, "dead"); return h; }
        h.issues.push(`process died (${died.reason}); respawn failed`);
      } else {
        h.issues.push(`process is dead${insp.exitStatus !== undefined ? ` (exit status ${insp.exitStatus})` : ""}; the next message to it starts it again`);
      }
      await this.notifyOnce(key, "dead", `⚠️ ${key}: its agent process is dead${insp.exitStatus !== undefined ? ` (exit status ${insp.exitStatus})` : ""}. It is not restarted on its own; the next message to it starts it again.`);
    } else if (insp?.process === "alive") {
      await this.clearNotified(key, "dead");
    }

    // ── blocked ──
    if (insp?.process === "alive" && insp.blocker && !held) {
      const b = insp.blocker;
      if (b.kind === "startup" && b.label === "folder-trust") {
        const cwd = insp.cwd ?? this.manager.cwdOf(key);
        if (open && cwd && this.manager.trustedDir(cwd)) {
          const done = await rt!.repairBlocked("answer-startup-prompt");
          h.issues.push(done ? `answered the folder-trust prompt (${cwd})` : "sits on the folder-trust prompt");
          if (done) { delete h.blocked; this.prevBlocker.delete(key); }
        } else {
          h.issues.push(`sits on the folder-trust prompt for ${cwd ?? "an unknown directory"} (outside the allowed directories: not answered)`);
          await this.notifyOnce(key, `blocked:${blocked}`, `⚠️ ${key} is stuck at Claude Code's folder-trust prompt for ${cwd ?? "an unknown directory"}, outside the allowed worker directories. It was not answered automatically.`);
        }
      } else if (b.kind === "mcp-dialog") {
        // A settings viewer left open (e.g. a manual /mcp): close it once it has sat there for two checks.
        if (prev === blocked && open) {
          const done = await rt!.repairBlocked("close-dialog");
          h.issues.push(done ? "closed a leftover /mcp dialog" : "a /mcp dialog is open");
          if (done) { delete h.blocked; this.prevBlocker.delete(key); }
        } else h.issues.push("a /mcp dialog is open");
      } else if (b.kind === "permission") {
        h.issues.push("waiting on a permission dialog");
      } else if (prev === blocked) {
        h.issues.push(`blocked: ${b.kind === "startup" ? `startup prompt "${b.label}"` : `dialog "${b.label ?? "?"}"`} (not answered automatically)`);
        await this.notifyOnce(key, `blocked:${blocked}`, `⚠️ ${key} is stuck on ${b.kind === "startup" ? `Claude Code's "${b.label}" prompt` : `a dialog ("${b.label ?? "?"}")`}. It was not answered automatically; attach to it to look (uniqlaw attach ${key}).`);
      }
    } else if (insp?.process === "alive" && !insp.blocker) {
      await this.clearNotified(key, "blocked:");
    }

    // ── MCP ──
    if (open && this.manager.hasMcp(key)) {
      const link = this.gateway.link(key);
      const state = this.recovering.has(key) ? "recovering" : mcpLinkState(link);
      const last = this.lastRecovery.get(key);
      h.mcp = { state, streams: link?.streams ?? 0, ...(link?.lastRequestAt ? { lastRequestAt: link.lastRequestAt } : {}),
        ...(link?.lastInitializeAt ? { lastInitializeAt: link.lastInitializeAt } : {}), ...(last ? { lastRecovery: last } : {}) };
      if (state === "unknown" && rt!.repairs.reconnectMcp) h.issues.push("MCP: not heard from since the gateway started");
      if (last && !/^(reconnected|respawned)$/.test(last.outcome)) h.issues.push(`MCP recovery: ${last.outcome} (${last.detail})`);
    }
    return h;
  }

  private async findOrphans(keys: string[], now: number): Promise<SessionHealth[]> {
    const out: SessionHealth[] = [];
    for (const { id, inspection } of await this.manager.orphanProcesses(keys)) {
      out.push({ name: id, orphan: true, process: inspection.process, ...(inspection.exitStatus !== undefined ? { exitStatus: inspection.exitStatus } : {}),
        issues: [`provider process of no known session${inspection.process === "dead" ? `, dead${inspection.exitStatus !== undefined ? ` (exit status ${inspection.exitStatus})` : ""}` : ""}`], checkedAt: now });
    }
    return out;
  }

  // ── notify once ──────────────────────────────────────────────────────────

  private async notifyOnce(key: string, condition: string, text: string) {
    const k = `${NOTIFIED}${key}:${condition}`;
    if (this.manager.store.get(k)) return;
    this.manager.store.set(k, String(Date.now()));
    await this.manager.notifyOwnerOf(key, text).catch((e) => this.log.warn("health notice failed", { key, e: String(e) }));
  }

  /** The condition is gone: a new occurrence is reported again. `condition` ending in ":" clears all of that kind. */
  private async clearNotified(key: string, condition: string) {
    const base = `${NOTIFIED}${key}:${condition}`;
    for (const [k] of this.manager.store.entries(base)) this.manager.store.del(k);
  }

  // ── views ────────────────────────────────────────────────────────────────

  /** Last inspection of a session (merged with live MCP state). */
  of(key: string): SessionHealth | undefined {
    const h = this.health.get(key);
    if (!h) return undefined;
    if (!h.mcp) return h;
    const link = this.gateway.link(key);
    return { ...h, mcp: { ...h.mcp, state: this.recovering.has(key) ? "recovering" : mcpLinkState(link), streams: link?.streams ?? 0 } };
  }

  sessions(): SessionHealth[] { return [...this.health.keys()].map((k) => this.of(k)!).concat(this.orphans); }

  /** Inspect now (API / tests). */
  async refresh() {
    if (this.inspecting) await this.inspecting;
    this.lastInspectAt = Date.now();
    this.inspecting = this.inspectAll().finally(() => { this.inspecting = undefined; });
    await this.inspecting;
  }
}

/** `dir` is inside one of `roots` (all resolved through symlinks). */
export function insideRoots(dir: string, roots: string[]): boolean {
  let real: string;
  try { real = realpathSync(resolve(dir)); } catch { return false; }
  return roots.some((r) => {
    let root: string;
    try { root = realpathSync(resolve(r)); } catch { return false; }
    return real === root || real.startsWith(root.endsWith(sep) ? root : root + sep);
  });
}
