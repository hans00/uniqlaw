// Channel supervisor (docs §11.4): chat platforms start in the background, each with a deadline and retry with
// backoff, so the daemon (gateway, API, sessions) never waits on a platform being reachable. A channel that keeps
// failing is "degraded", one whose credentials are rejected is "failed"; neither fails the daemon.
import type { InboundSink, PlatformAdapter, PlatformHealth } from "./platform.ts";
import type { Logger } from "./plugin.ts";

export type ChannelState = "starting" | "connected" | "degraded" | "failed" | "stopped";

export interface ChannelHealth {
  name: string;
  state: ChannelState;
  /** Start attempts so far (1 = the first). */
  attempts: number;
  connectedAt?: number;
  lastPollAt?: number;
  lastSendAt?: number;
  lastError?: string;
  lastErrorAt?: number;
  consecutiveFailures: number;
  /** When the next start attempt runs (while not connected). */
  nextRetryAt?: number;
}

export interface SupervisorOptions {
  /** Deadline of one start() call. */
  startTimeoutMs?: number;
  /** Backoff between failed starts: min doubling up to max. */
  retryMinMs?: number;
  retryMaxMs?: number;
  /** Failed API calls in a row (adapter health) after which a connected channel shows as degraded. */
  degradedAfter?: number;
  /** Deadline of one stop() call. */
  stopTimeoutMs?: number;
}

export const SUPERVISOR_DEFAULTS: Required<SupervisorOptions> = {
  startTimeoutMs: 20_000, retryMinMs: 5_000, retryMaxMs: 300_000, degradedAfter: 3, stopTimeoutMs: 10_000,
};

/** Resolves with fn's value, or rejects after ms (the abort signal tells fn to give up). */
export async function withDeadline<T>(ms: number, label: string, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    // Reject first: the abort makes fn reject too, and the timeout must be the reason reported.
    timer = setTimeout(() => { reject(new Error(`${label} timed out after ${(ms / 1000).toFixed(ms < 1000 ? 1 : 0)}s`)); ac.abort(); }, ms);
  });
  try { return await Promise.race([fn(ac.signal), timeout]); }
  finally { clearTimeout(timer); }
}

interface Entry {
  name: string;
  adapter: PlatformAdapter;
  state: ChannelState;
  attempts: number;
  connectedAt?: number;
  lastError?: string;
  lastErrorAt?: number;
  failures: number;
  nextRetryAt?: number;
  timer?: ReturnType<typeof setTimeout>;
  /** The attempt in progress (stop() waits for it, bounded). */
  attempt?: Promise<void>;
}

export class ChannelSupervisor {
  private entries = new Map<string, Entry>();
  private o: Required<SupervisorOptions>;
  private stopping = false;

  constructor(platforms: Map<string, PlatformAdapter>, private sinkFor: (name: string) => InboundSink, private log: Logger,
    opts: SupervisorOptions = {}, private onConnected?: (name: string, adapter: PlatformAdapter) => void | Promise<void>) {
    this.o = { ...SUPERVISOR_DEFAULTS, ...opts };
    for (const [name, adapter] of platforms) this.entries.set(name, { name, adapter, state: "starting", attempts: 0, failures: 0 });
  }

  /** Start every channel in the background; returns at once. */
  start() {
    for (const e of this.entries.values()) this.schedule(e, 0);
  }

  private schedule(e: Entry, delayMs: number) {
    if (this.stopping) return;
    clearTimeout(e.timer);
    e.nextRetryAt = Date.now() + delayMs;
    e.timer = setTimeout(() => { e.attempt = this.attemptStart(e).finally(() => { e.attempt = undefined; }); }, delayMs);
  }

  private async attemptStart(e: Entry) {
    if (this.stopping) return;
    e.attempts++;
    e.nextRetryAt = undefined;
    try {
      await withDeadline(this.o.startTimeoutMs, `${e.name} start`, (signal) => e.adapter.start(this.sinkFor(e.name), signal));
      if (this.stopping) return;
      e.state = "connected";
      e.connectedAt = Date.now();
      e.failures = 0;
      this.log.info("channel connected", { channel: e.name, attempts: e.attempts });
      await Promise.resolve(this.onConnected?.(e.name, e.adapter)).catch((err) => this.log.warn("channel post-connect step failed", { channel: e.name, e: String(err) }));
    } catch (err) {
      if (this.stopping) return;
      e.failures++;
      e.lastError = err instanceof Error ? err.message : String(err);
      e.lastErrorAt = Date.now();
      // A start that timed out may still be running inside the adapter: stop it before trying again.
      await withDeadline(this.o.stopTimeoutMs, `${e.name} stop`, () => e.adapter.stop()).catch(() => {});
      if ((err as { permanent?: unknown })?.permanent === true) {
        e.state = "failed";
        this.log.error("channel failed (not retrying)", { channel: e.name, error: e.lastError });
        return;
      }
      e.state = "degraded";
      const delay = Math.min(this.o.retryMinMs * 2 ** (e.failures - 1), this.o.retryMaxMs);
      this.log.warn("channel start failed; retrying", { channel: e.name, error: e.lastError, attempt: e.attempts, retryInMs: delay });
      this.schedule(e, delay);
    }
  }

  /** Retry a channel now (e.g. operator request), whatever its state. */
  retry(name: string): boolean {
    const e = this.entries.get(name);
    if (!e || e.state === "connected" || e.attempt) return false;
    e.state = "starting";
    this.schedule(e, 0);
    return true;
  }

  health(): ChannelHealth[] {
    return [...this.entries.values()].map((e) => {
      const h: PlatformHealth | undefined = safe(() => e.adapter.health?.());
      let state = e.state;
      // Connected, but its API calls keep failing (Telegram servers misbehaving): degraded.
      if (state === "connected" && h && h.consecutiveFailures >= this.o.degradedAfter) state = "degraded";
      const lastError = h?.lastErrorAt && (!e.lastErrorAt || h.lastErrorAt > e.lastErrorAt) ? { lastError: h.lastError, lastErrorAt: h.lastErrorAt }
        : e.lastError ? { lastError: e.lastError, lastErrorAt: e.lastErrorAt } : {};
      return {
        name: e.name, state, attempts: e.attempts,
        ...(e.connectedAt ? { connectedAt: e.connectedAt } : {}),
        ...(h?.lastPollAt ? { lastPollAt: h.lastPollAt } : {}),
        ...(h?.lastSendAt ? { lastSendAt: h.lastSendAt } : {}),
        ...lastError,
        consecutiveFailures: e.state === "connected" ? (h?.consecutiveFailures ?? 0) : e.failures,
        ...(e.nextRetryAt && e.state !== "connected" ? { nextRetryAt: e.nextRetryAt } : {}),
      };
    });
  }

  isConnected(name: string): boolean { return this.entries.get(name)?.state === "connected"; }

  /** Stop every channel, each bounded by stopTimeoutMs; never throws. */
  async stop() {
    this.stopping = true;
    await Promise.all([...this.entries.values()].map(async (e) => {
      clearTimeout(e.timer);
      if (e.attempt) await withDeadline(this.o.stopTimeoutMs, `${e.name} start`, () => e.attempt!).catch(() => {});
      await withDeadline(this.o.stopTimeoutMs, `${e.name} stop`, () => e.adapter.stop())
        .catch((err) => this.log.warn("channel stop failed", { channel: e.name, e: String(err) }));
      e.state = "stopped";
    }));
  }
}

function safe<T>(fn: () => T): T | undefined { try { return fn(); } catch { return undefined; } }
