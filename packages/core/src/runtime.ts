// Per-channel runtime: owns one AgentSession, the input queue, the turn state
// machine, output routing (by Origin) and approvals. Provider-agnostic.
import type { AgentEvent, AgentProvider, AgentSession, Attachment, PermissionDecision, Profile, SystemPromptParts, TurnInput } from "./provider.ts";
import type { MsgRef, PlatformAdapter, Target } from "./platform.ts";
import type { Origin } from "./origin.ts";
import type { Logger } from "./plugin.ts";
import type { Settings } from "./config.ts";
import type { StateStore } from "./state.ts";
import type { RuntimeEvent, TranscriptKind, TranscriptStore } from "./transcript.ts";
import { ModelRouter, agenticSchema } from "./model-router.ts";
import { restrictsNativeTools, type ToolPolicy } from "./channel-policy.ts";
import {
  extractReactions, formatPendingForPrompt, formatToolStatus, isPassthroughSlashCommand, isSilentReplyText,
  mergeQueued, stripSilentToken, type PendingNote, type PromptItem,
} from "./format.ts";

export type RuntimeState = "closed" | "opening" | "idle" | "running" | "interrupting";

export interface QueuedInput {
  origin: Origin;
  item: PromptItem;
  attachments: Attachment[];
}

/** What the system prompt builder knows about the session. */
export interface SessionContext {
  channelKey: string;
  internal: boolean;
  cwd?: string;
  worker?: { owner?: string };
}

/** Services the runtime needs from the daemon (kept narrow for testability). */
export interface RuntimeHost {
  log: Logger;
  settings: Settings;
  store: StateStore;
  projectDir: string;
  instanceId: string;
  platform(name: string): PlatformAdapter | undefined;
  /** All operator targets across platforms (fallback for approvals/background). */
  operatorTargets(): Target[];
  /** Build the system prompt for a session. */
  systemPrompt(profile: Profile, multiparty: boolean, mcpToolNames: string[], session?: SessionContext): Promise<SystemPromptParts>;
  /** True for sessions with no chat of their own (heartbeat, cron jobs, "global"…). Default: false. */
  isInternal?(channelKey: string): boolean;
  /** Working directory of a session (workers run elsewhere). Default: projectDir. */
  cwdFor?(channelKey: string): string | undefined;
  /** Worker sessions: who started it. */
  workerOf?(channelKey: string): { owner?: string } | undefined;
  /** Override where background output goes: a target, null = nowhere, undefined = backgroundNotify policy. */
  backgroundTarget?(channelKey: string): Target | null | undefined;
  /** Channel capabilities (settings.channels) for this session; undefined = unrestricted. */
  toolPolicyFor?(channelKey: string): ToolPolicy | undefined;
  /** Issue an MCP Gateway token for this channel. */
  gatewayFor(channelKey: string): { url: string; token: string; toolNames: string[] } | undefined;
  /** Minimal isolated env for provider child processes. */
  providerEnv(profile: Profile): Promise<Record<string, string>>;
  /** A turn hit the provider's usage limit. Return true when the host took over telling the human
   *  (e.g. asked the owner to switch profile); false = the runtime posts its usual error. */
  onUsageLimit?(channelKey: string, failed: { origins: Origin[]; input?: TurnInput }): Promise<boolean>;
  /** Called when a peer ask/trigger turn finishes. */
  onTaskResult(taskId: string, ok: boolean, text: string): void;
  /** Optional: bounded transcript for UIs. */
  transcript?: TranscriptStore;
  /** Optional: live runtime events (dashboard SSE). */
  emit?(ev: RuntimeEvent): void;
}

interface TurnState {
  origins: Origin[];
  /** Input that started the turn (for rate-limit retries). */
  input?: TurnInput;
  /** Content arrived through a channel outside UniQlaw (native peer socket): operators only. */
  external?: boolean;
  retries?: number;
  /** The stall watchdog fired: however the turn ends now, report it as a stall. */
  stalled?: boolean;
  startedAt: number;
  texts: string[];
  toolBubble?: MsgRef;
  /** Every tool-status message posted this turn: deleted once the turn ends with a delivered reply. */
  toolBubbles?: MsgRef[];
  /** A reply (not just tool status) reached the chat this turn. */
  delivered?: boolean;
  toolLines: string[];
  denied: boolean;
  unsolicited: boolean;
}

const TYPING_PULSE_MS = 4000;
const STEER_RACE_MS = 3000;
/** Streaming: wait before the first live message, then throttle edits (platform rate limits). */
const STREAM_FIRST_MS = 800;
const STREAM_EDIT_MS = 1500;
const STREAM_MIN_CHARS = 24;
const MAX_RATE_LIMIT_RETRIES = 3;
/** How long after reopening a turn may still claim the origins of the turn that was in flight at detach. */
const RESUME_ORIGINS_MS = 120_000;
/** First retry delay; doubles each attempt. Overridable for tests via UNIQLAW_RATE_LIMIT_BACKOFF_MS. */
const rateLimitBackoffMs = () => Number(process.env.UNIQLAW_RATE_LIMIT_BACKOFF_MS ?? 30_000);
const INTERRUPT_SETTLE_MS = 8000;

export class ChannelRuntime {
  private _state: RuntimeState = "closed";
  get state(): RuntimeState { return this._state; }
  set state(v: RuntimeState) {
    if (v === this._state) return;
    this._state = v;
    this.host.emit?.({ type: "state", channelKey: this.channelKey, state: v, at: Date.now() });
  }
  private session?: AgentSession;
  private queue: QueuedInput[] = [];
  private dropped: string[] = [];
  private lastEnqueuedAt = 0;
  private turn?: TurnState;
  private typingTimer?: ReturnType<typeof setInterval>;
  private interruptTimer?: ReturnType<typeof setTimeout>;
  private drainTimer?: ReturnType<typeof setTimeout>;
  private opening?: Promise<void>;
  private awaitingInput?: { id: string; target: Target };
  /** Origins steered shortly before a turn ended: if the adapter fell back to a new turn
   *  (steer raced with turn end), that turn belongs to these origins, not to "background". */
  private steerLog: { origin: Origin; at: number }[] = [];
  private steerCarry?: { origins: Origin[]; until: number };
  /** Who a turn answered when the daemon detached mid-turn (see detach); used by the first turn after reopening. */
  private resumeOrigins?: { origins: Origin[]; until: number };
  private retryTimer?: ReturnType<typeof setTimeout>;
  private stallTimer?: ReturnType<typeof setTimeout>;
  /** A permission/input request is waiting for a human: the stall watchdog is paused. */
  private waitingForHuman = false;
  private readonly log: Logger;
  private router?: ModelRouter;
  /** Model the session is on, as far as we know (profile → /model → router → provider "model" events). */
  private activeModel?: string;
  /** Set while a scheduled turn's model override is in effect: the model to switch back to. */
  private modelRestore?: { model?: string };

  constructor(
    readonly channelKey: string,
    readonly profile: Profile,
    private readonly provider: AgentProvider,
    private readonly host: RuntimeHost,
    readonly multiparty: boolean,
  ) {
    this.log = host.log.child(channelKey);
    const agentic = agenticSchema.safeParse(profile.options.agentic ?? {});
    this.activeModel = profile.model;
    if (agentic.success && agentic.data.enabled) this.router = new ModelRouter(agentic.data, profile.model);
    else if (!agentic.success) this.log.warn("invalid profile.options.agentic; model routing disabled");
  }

  get capabilities() { return this.provider.capabilities(this.profile); }
  get queueLength() { return this.queue.length; }
  get currentOrigins(): Origin[] { return this.turn?.origins ?? []; }

  /** Max peer hop in the current turn (for delegation hop counting). A human message in the turn starts a new
   *  chain at hop 0: only a person can add one, so it can't feed an agent loop. */
  currentHop(): number {
    if (this.currentOrigins.some((o) => o.kind === "human")) return 0;
    let h = 0;
    for (const o of this.currentOrigins) if (o.kind === "peer" || o.kind === "a2a") h = Math.max(h, o.hop);
    return h;
  }

  /** Delegation chain the current turn works for (bus.maxChainTasks budget): the latest human message in the turn
   *  starts its own; otherwise the chain a peer input carried; otherwise one for this turn. */
  currentChain(): string {
    const os = this.currentOrigins;
    for (const o of [...os].reverse()) if (o.kind === "human") return `human:${this.channelKey}:${o.ref.messageId}:${o.ref.chatId}`;
    for (const o of os) if (o.kind === "peer" && o.chain) return o.chain;
    return `turn:${this.channelKey}:${this.turn?.startedAt ?? Date.now()}`;
  }

  /** Async results in a row that drove this session since the last human message (0 with a human in the turn). */
  currentRounds(): number {
    if (this.currentOrigins.some((o) => o.kind === "human")) return 0;
    let r = 0;
    for (const o of this.currentOrigins) if (o.kind === "peer" && o.mode === "result") r = Math.max(r, o.rounds ?? 0);
    return r;
  }

  /** Human target at the root of whatever the current turn is serving. */
  rootTarget(): Target | undefined {
    for (const o of [...this.currentOrigins].reverse()) {
      if (o.kind === "human") return o.replyTarget;
      if (o.kind === "peer" && o.rootTarget) return o.rootTarget;
      if (o.kind === "peer" && o.deliverTo) return o.deliverTo;
      if (o.kind === "scheduler" && o.deliverTo) return o.deliverTo;
    }
    return this.lastTarget();
  }

  lastTarget(): Target | undefined {
    const row = this.host.store.getSession(this.channelKey);
    return row?.lastTarget ? (JSON.parse(row.lastTarget) as Target) : undefined;
  }

  // ── input ────────────────────────────────────────────────────────────────

  /** Login-code style replies: returns true if the message was consumed. */
  tryConsumeAwaitedInput(text: string): boolean {
    if (!this.awaitingInput || !this.session?.respondInput) return false;
    const { id } = this.awaitingInput;
    this.awaitingInput = undefined;
    void this.session.respondInput(id, text.trim()).catch((e) => this.log.error("respondInput failed", { e }));
    return true;
  }

  async enqueue(input: QueuedInput): Promise<void> {
    if (input.origin.kind === "human") this.rememberTarget(input.origin.replyTarget);
    this.touch();
    const slash = isPassthroughSlashCommand(input.item.text) && input.origin.kind === "human";
    if (this.state === "closed" || this.state === "opening") {
      this.push(input);
      await this.ensureOpen();
      return;
    }
    if (this.state === "idle") {
      this.push(input);
      this.scheduleDrain(0);
      return;
    }
    // running / interrupting
    const mode = this.host.settings.queue.mode;
    if (this.state === "running" && mode === "steer" && !slash && this.session?.steer && this.capabilities.steer) {
      const prompt = mergeQueued([input.item], this.host.settings.timezone);
      this.turn?.origins.push(input.origin);
      this.steerLog.push({ origin: input.origin, at: Date.now() });
      try {
        await this.session.steer({ text: prompt, attachments: input.attachments });
        return;
      } catch (e) {
        this.log.warn("steer failed; queueing", { e: String(e) });
      }
    }
    this.push(input);
    if (this.state === "running" && mode === "interrupt" && this.capabilities.interrupt) await this.beginInterrupt(true);
  }

  private push(input: QueuedInput) {
    const { cap, dropPolicy } = this.host.settings.queue;
    this.lastEnqueuedAt = Date.now();
    if (this.queue.length >= cap) {
      if (dropPolicy === "new") return;
      const removed = this.queue.splice(0, this.queue.length - cap + 1);
      if (dropPolicy === "summarize") for (const d of removed) this.dropped.push(d.item.text.replace(/\s+/g, " ").slice(0, 160));
    }
    this.queue.push(input);
  }

  /** /stop: interrupt and clear the queue. */
  async stop(): Promise<boolean> {
    this.queue = [];
    this.dropped = [];
    if (this.state !== "running") return false;
    if (!this.capabilities.interrupt) return false;
    await this.beginInterrupt(false);
    return true;
  }

  async setModel(model: string): Promise<boolean> {
    if (!this.session?.setModel || this.capabilities.modelSwitch !== "live") return false;
    await this.session.setModel(model);
    this.activeModel = model;
    this.modelRestore = undefined; // a manual switch wins over a pending scheduled-turn restore
    this.router?.adopt(model);
    return true;
  }

  /** /new: drop the provider session so the next message starts fresh. */
  async reset(): Promise<void> {
    await this.close();
    this.host.store.patchSession(this.channelKey, { providerSessionId: null, adapterState: null });
  }

  /** Daemon shutdown: keep the provider process alive for reattach when supported. */
  async detach(): Promise<void> {
    if (this.session?.detach) {
      // A turn still running in the provider (e.g. claude-tmux keeps working through a reload): remember who it
      // answers, so the reattached session delivers the reply to them instead of treating it as background output.
      const keep = (this.turn?.origins ?? []).filter((o) => o.kind === "human" || (o.kind === "scheduler" && !o.taskId));
      if (this.state === "running" && keep.length) this.host.store.set(`inflight-turn:${this.channelKey}`, JSON.stringify(keep));
      const s = this.session;
      this.session = undefined;
      this.stopTyping();
      clearTimeout(this.interruptTimer);
      clearTimeout(this.drainTimer);
      clearTimeout(this.stallTimer);
      this.state = "closed";
      this.turn = undefined;
      s.detach!();
      return;
    }
    return this.close();
  }

  async close(): Promise<void> {
    clearTimeout(this.retryTimer);
    clearTimeout(this.stallTimer);
    this.stopTyping();
    clearTimeout(this.interruptTimer);
    clearTimeout(this.drainTimer);
    const s = this.session;
    this.session = undefined;
    this.state = "closed";
    this.turn = undefined;
    if (s) await s.close().catch((e) => this.log.warn("close failed", { e: String(e) }));
  }

  // ── session lifecycle ───────────────────────────────────────────────────

  async ensureOpen(): Promise<void> {
    if (this.session) return;
    if (this.opening) return this.opening;
    this.state = "opening";
    this.opening = this.open().finally(() => { this.opening = undefined; });
    return this.opening;
  }

  private async open(): Promise<void> {
    const row = this.host.store.getSession(this.channelKey);
    const now = Date.now();
    if (!row || row.provider !== this.profile.provider || row.profile !== this.profile.name) {
      this.host.store.upsertSession({
        channelKey: this.channelKey, profile: this.profile.name, provider: this.profile.provider,
        // A provider change invalidates the old provider session id.
        providerSessionId: row && row.provider === this.profile.provider ? row.providerSessionId : null,
        multiparty: this.multiparty, createdAt: row?.createdAt ?? now, lastActivityAt: now,
        lastTarget: row?.lastTarget ?? null, adapterState: row && row.provider === this.profile.provider ? row.adapterState : null,
      });
    }
    const cur = this.host.store.getSession(this.channelKey)!;
    const toolPolicy = this.host.toolPolicyFor?.(this.channelKey);
    const gw = this.host.gatewayFor(this.channelKey);
    const cwd = this.host.cwdFor?.(this.channelKey) ?? this.host.projectDir;
    const worker = this.host.workerOf?.(this.channelKey);
    try {
      if (restrictsNativeTools(toolPolicy) && !this.capabilities.toolPolicy) {
        throw new Error(`settings.channels limits this chat's tools, but provider "${this.profile.provider}" can't restrict its own tools; `
          + "bind this chat to a profile whose provider can (claude-tmux, claude-sdk), or allow every native tool group here");
      }
      const session = await this.provider.open({
        sessionId: this.channelKey,
        providerSessionId: cur.providerSessionId ?? undefined,
        cwd,
        profile: this.profile,
        systemPrompt: await this.host.systemPrompt(this.profile, this.multiparty, gw?.toolNames ?? [], {
          channelKey: this.channelKey, internal: this.host.isInternal?.(this.channelKey) ?? false, cwd,
          ...(worker ? { worker } : {}),
        }),
        ...(toolPolicy ? { toolPolicy } : {}),
        mcp: gw,
        env: await this.host.providerEnv(this.profile),
        instanceId: this.host.instanceId,
        nativeMemory: !this.host.settings.memory.enabled || this.host.settings.memory.nativeMemory,
      });
      const inflight = this.host.store.get(`inflight-turn:${this.channelKey}`);
      if (inflight) {
        this.host.store.del(`inflight-turn:${this.channelKey}`);
        try { this.resumeOrigins = { origins: JSON.parse(inflight) as Origin[], until: Date.now() + RESUME_ORIGINS_MS }; } catch {}
      }
      this.session = session;
      this.state = "idle";
      void this.consume(session);
      this.log.info("session open", { provider: this.profile.provider, resumed: !!cur.providerSessionId });
      this.scheduleDrain(0);
    } catch (e) {
      this.state = "closed";
      const msg = e instanceof Error ? e.message : String(e);
      this.log.error("open failed", { msg });
      const failed = this.queue.splice(0);
      for (const q of failed) await this.notifyFailure(q.origin, `⚠️ Agent session failed to start: ${msg}`);
    }
  }

  // ── turns ───────────────────────────────────────────────────────────────

  private scheduleDrain(delayMs: number) {
    clearTimeout(this.drainTimer);
    this.drainTimer = setTimeout(() => void this.drain(), delayMs);
  }

  private async drain(): Promise<void> {
    if (this.state !== "idle" || !this.session || this.queue.length === 0) return;
    const debounce = this.host.settings.queue.debounceMs;
    const wait = debounce - (Date.now() - this.lastEnqueuedAt);
    // Only debounce when several messages are piling up (first message goes out immediately).
    if (this.queue.length > 1 && wait > 0) return this.scheduleDrain(wait);

    // Slash commands must reach the provider clean and alone.
    const first = this.queue[0]!;
    if (isPassthroughSlashCommand(first.item.text) && first.origin.kind === "human") {
      this.queue.shift();
      return this.startTurn([first.origin], { text: first.item.text.trim(), attachments: [], slashCommand: true });
    }
    const batch: QueuedInput[] = [];
    while (this.queue.length && !(isPassthroughSlashCommand(this.queue[0]!.item.text) && this.queue[0]!.origin.kind === "human")) batch.push(this.queue.shift()!);
    const tz = this.host.settings.timezone;
    const notes = this.drainPendingNotes();
    const handoff = notes.filter((n) => n.raw).map((n) => n.text);
    const pending = notes.filter((n) => !n.raw);
    await this.scheduledModel(batch);
    await this.routeModel(batch);
    const body = mergeQueued(batch.map((b) => b.item), tz, this.dropped.splice(0));
    const text = [...handoff, formatPendingForPrompt(pending, tz), body].filter(Boolean).join("\n\n");
    await this.startTurn(batch.map((b) => b.origin), { text, attachments: batch.flatMap((b) => b.attachments) });
  }

  /** Scheduled turns may run on their own model (job/heartbeat `model`); the next turn without
   *  one switches back. Needs live model switching; otherwise use a profile for the job. */
  private async scheduledModel(batch: QueuedInput[]) {
    const human = batch.some((b) => b.origin.kind === "human");
    const want = human ? undefined : [...batch].reverse().map((b) => b.origin).map((o) => (o.kind === "scheduler" ? o.model : undefined)).find(Boolean);
    const live = this.capabilities.modelSwitch === "live" && !!this.session?.setModel;
    if (want) {
      if (want === this.activeModel) return;
      if (!live) { this.log.warn("scheduled job asks for a model but this provider can't switch live; set a profile on the job instead", { model: want }); return; }
      const restore = this.modelRestore ?? { model: this.activeModel };
      try { await this.session!.setModel!(want); this.activeModel = want; this.modelRestore = restore; this.log.info("scheduled model", { model: want }); }
      catch (e) { this.log.warn("setModel failed", { e: String(e) }); }
      return;
    }
    if (!this.modelRestore || !live) return;
    const back = this.modelRestore.model ?? this.profile.model;
    this.modelRestore = undefined;
    if (!back) { this.log.warn("can't switch back after a scheduled model: the base model is the provider default (set profile.model)"); return; }
    if (back === this.activeModel) return;
    try { await this.session!.setModel!(back); this.activeModel = back; } catch (e) { this.log.warn("setModel failed", { e: String(e) }); }
  }

  /** Per-turn model routing for human turns (scheduled/peer turns keep the current model). */
  private async routeModel(batch: QueuedInput[]) {
    if (!this.router?.enabled) return;
    const human = [...batch].reverse().find((b) => b.origin.kind === "human");
    if (!human) return;
    if (this.capabilities.modelSwitch !== "live" || !this.session?.setModel) return;
    const d = this.router.decide(human.item.text);
    if (!d) return;
    if ("skip" in d) { this.log.debug("model switch suppressed", { why: d.skip }); return; }
    this.log.info("model routing", { model: d.model, why: d.reasoning });
    await this.session.setModel(d.model).then(() => { this.activeModel = d.model; }, (e) => this.log.warn("setModel failed", { e: String(e) }));
  }

  /** Queued inputs not yet sent (moved to the new runtime when the chat switches profile). */
  takeQueue(): QueuedInput[] { return this.queue.splice(0); }

  private drainPendingNotes(): (PendingNote & { raw?: boolean })[] {
    return this.host.store.drainPending(this.channelKey).map((p) => {
      if (p.kind === "handoff") return { at: p.createdAt, label: "handoff", text: (JSON.parse(p.payload) as { text: string }).text, raw: true };
      const d = JSON.parse(p.payload) as { label?: string; text?: string; source?: string; ts?: string; kind?: string; from?: string; note?: string };
      if (d.source === "v2-inbox") {
        // Migrated v2 inbox entry: same labels as v2's formatInboxForPrompt.
        const from = d.from ? ` from ${d.from}` : "";
        const note = d.note ? ` (${d.note})` : "";
        const label = d.kind === "send" ? `you sent${note}${from}` : d.kind === "trigger-result" ? `trigger response${from}${note}` : `system${note}`;
        const at = d.ts ? Date.parse(d.ts) || p.createdAt : p.createdAt;
        return { at, label, text: d.text ?? "" };
      }
      return { at: p.createdAt, label: d.label ?? p.kind, text: d.text ?? p.payload };
    });
  }

  private async startTurn(origins: Origin[], input: TurnInput, retries = 0): Promise<void> {
    if (!this.session) return;
    this.steerLog = [];
    this.steerCarry = undefined;
    this.turn = { origins, input, retries, startedAt: Date.now(), texts: [], toolLines: [], denied: false, unsolicited: false };
    this.armStall();
    this.state = "running";
    this.record("prompt", input.text, { origins: origins.map((o) => o.kind), retry: retries || undefined });
    this.host.emit?.({ type: "turn_start", channelKey: this.channelKey, at: Date.now() });
    this.startTyping();
    try {
      await this.session.send(input);
    } catch (e) {
      this.log.error("send failed", { e: String(e) });
      await this.finishTurn("error", String(e));
    }
  }

  private async beginInterrupt(keepQueue: boolean) {
    if (!this.session?.interrupt) return;
    this.state = "interrupting";
    await this.session.interrupt().catch((e) => this.log.warn("interrupt failed", { e: String(e) }));
    clearTimeout(this.interruptTimer);
    this.interruptTimer = setTimeout(() => {
      if (this.state !== "interrupting") return;
      this.log.warn("interrupt did not settle; forcing idle");
      void this.finishTurn("interrupted");
      if (!keepQueue) this.queue = [];
    }, INTERRUPT_SETTLE_MS);
  }

  private async consume(session: AgentSession) {
    try {
      for await (const ev of session.events) {
        if (this.session !== session) break;
        await this.onEvent(ev).catch((e) => this.log.error("event handler failed", { type: ev.type, e: String(e) }));
      }
    } catch (e) {
      this.log.error("event stream crashed", { e: String(e) });
    }
    if (this.session === session) {
      this.log.warn("event stream ended; session closed");
      if (this.turn) await this.finishTurn("error", "agent session ended");
      this.session = undefined;
      this.state = "closed";
      if (this.queue.length) void this.ensureOpen();
    }
  }

  private async onEvent(ev: AgentEvent): Promise<void> {
    if (ev.type !== "session" && ev.type !== "turn_end") this.armStall();
    switch (ev.type) {
      case "session":
        this.host.store.patchSession(this.channelKey, { providerSessionId: ev.providerSessionId });
        return;
      case "turn_start":
        if (!this.turn) {
          const carry = this.steerCarry && Date.now() < this.steerCarry.until ? this.steerCarry.origins : undefined;
          this.steerCarry = undefined;
          const resumed = carry ? undefined : this.takeResumeOrigins();
          this.turn = { origins: carry ?? resumed ?? [], startedAt: Date.now(), texts: [], toolLines: [], denied: false, unsolicited: !carry && !resumed };
          this.state = "running";
          this.startTyping();
        }
        return;
      case "unsolicited_turn":
        if (ev.source === "external") {
          this.log.warn("turn carries input from outside UniQlaw (native peer messaging); routing to operators only");
          if (this.turn) { this.turn.external = true; return; }
          this.turn = { origins: [{ kind: "system", reason: "external" }], external: true, startedAt: Date.now(), texts: [], toolLines: [], denied: false, unsolicited: true };
          this.state = "running";
          return;
        }
        if (this.turn && this.turn.origins.length) return; // core already owns this turn
        this.turn = { origins: this.takeResumeOrigins() ?? [{ kind: "system", reason: "background" }], startedAt: Date.now(), texts: [], toolLines: [], denied: false, unsolicited: true };
        this.state = "running";
        return;
      case "text":
        if (ev.delta !== undefined && ev.final === undefined) { this.onDelta(ev.segmentId, ev.delta); return; }
        if (ev.final !== undefined) await this.onFinalText(ev.final, ev.segmentId);
        return;
      case "thinking":
        if (this.host.settings.output.thinking && ev.text.trim()) await this.postVisible(`_${ev.text.trim()}_`);
        return;
      case "tool_start":
        this.record("tool", formatToolStatus(ev.name, ev.input));
        if (this.host.settings.output.toolStatus) await this.postToolStatus(formatToolStatus(ev.name, ev.input));
        return;
      case "tool_end":
        return;
      case "permission_request":
        await this.onPermission(ev);
        return;
      case "input_request":
        await this.onInputRequest(ev);
        return;
      case "turn_end":
        await this.finishTurn(ev.reason, ev.error);
        return;
      case "model":
        this.log.info("model", { model: ev.model });
        if (ev.model) this.activeModel = ev.model;
        return;
      case "error":
        this.log.error("agent error", { error: ev.error, fatal: ev.fatal });
        if (ev.fatal) {
          await this.notifyFailure(this.turn?.origins.at(-1), `⚠️ Agent error: ${ev.error}`);
          await this.close();
        }
        return;
    }
  }

  // ── live streaming (output.stream = "replace") ──────────────────────────
  // Token deltas are shown by editing one message in place. Nothing is shown until enough
  // text arrived to rule out a whole-message sentinel (NO_REPLY / HEARTBEAT_OK).

  private live = new Map<string, { buf: string; ref?: MsgRef; target?: Target; lastEdit: number; timer?: ReturnType<typeof setTimeout>; busy?: Promise<unknown> }>();

  private streamTarget(): { target: Target; platform: PlatformAdapter } | undefined {
    if (this.host.settings.output.stream !== "replace" || this.turn?.external) return undefined;
    const target = this.visibleTarget();
    const platform = target && this.host.platform(target.platform);
    if (!target || !platform?.edit || !platform.capabilities.edit) return undefined;
    return { target, platform };
  }

  private onDelta(segmentId: string, delta: string) {
    if (!this.turn) return;
    const st = this.streamTarget();
    if (!st) return;
    let seg = this.live.get(segmentId);
    if (!seg) { seg = { buf: "", lastEdit: 0 }; this.live.set(segmentId, seg); }
    seg.buf += delta;
    if (!seg.timer) seg.timer = setTimeout(() => { seg!.timer = undefined; void this.flushLive(segmentId); }, seg.ref ? STREAM_EDIT_MS : STREAM_FIRST_MS);
  }

  private liveView(buf: string): string | undefined {
    const t = buf.trimStart();
    if (t.length < STREAM_MIN_CHARS) return undefined;
    // Could still become a silent sentinel → keep hidden.
    if (/^[`"'*_~\s]*(N(O(_(R(E(P(L(Y)?)?)?)?)?)?)?|H(E(A(R(T(B(E(A(T(_(O(K)?)?)?)?)?)?)?)?)?)?)?)[`"'*_~.\s]*$/.test(t)) return undefined;
    return extractReactions(stripSilentToken(t)).cleanText.replace(/\[react:[^\]]*$/, "").trim() || undefined;
  }

  private async flushLive(segmentId: string) {
    const seg = this.live.get(segmentId);
    const st = this.streamTarget();
    if (!seg || !st) return;
    const view = this.liveView(seg.buf);
    if (!view) return;
    const text = view + " ▍";
    const run = async () => {
      if (!seg.ref) {
        seg.target = st.target;
        seg.ref = await st.platform.send(st.target, text).catch(() => undefined);
        if (this.turn) this.turn.toolBubble = undefined;
      } else {
        await st.platform.edit!(seg.ref, text).catch(() => false);
      }
      seg.lastEdit = Date.now();
    };
    seg.busy = (seg.busy ?? Promise.resolve()).then(run);
    await seg.busy;
  }

  /** Final text for a streamed segment: replace the live message (or remove it if silent). */
  private async finishLive(segmentId: string | undefined, finalView: string | undefined): Promise<boolean> {
    if (!segmentId) return false;
    const seg = this.live.get(segmentId);
    this.live.delete(segmentId);
    if (!seg) return false;
    clearTimeout(seg.timer);
    await seg.busy;
    if (!seg.ref) return false;
    const p = this.host.platform(seg.ref.platform);
    if (!finalView) { if (p?.delete) await p.delete(seg.ref).catch(() => false); return true; }
    const ok = await p?.edit?.(seg.ref, finalView).catch(() => false);
    if (!ok && seg.target) await p?.send(seg.target, finalView).catch(() => {});
    if (this.turn) this.turn.delivered = true;
    return true;
  }

  private async onFinalText(raw: string, segmentId?: string) {
    if (!this.turn) this.turn = { origins: [{ kind: "system", reason: "background" }], startedAt: Date.now(), texts: [], toolLines: [], denied: false, unsolicited: true };
    if (!raw.trim()) return;
    this.turn.texts.push(raw);
    this.record("assistant", raw);
    if (isSilentReplyText(raw)) { await this.finishLive(segmentId, undefined); return; }
    const { cleanText, reactions } = extractReactions(stripSilentToken(raw));
    const human = this.lastHumanOrigin();
    if (reactions.length && human) {
      const p = this.host.platform(human.platform);
      if (p?.react) await p.react(human.ref, reactions).catch((e) => this.log.warn("react failed", { e: String(e) }));
    }
    if (await this.finishLive(segmentId, cleanText.trim() || undefined)) return;
    if (cleanText.trim()) await this.postVisible(cleanText);
  }

  private lastHumanOrigin() {
    const h = [...(this.turn?.origins ?? [])].reverse().find((o) => o.kind === "human");
    return h?.kind === "human" ? h : undefined;
  }

  /** Where visible output of the current turn goes (docs §8.4), or undefined = nowhere. */
  private visibleTarget(): Target | undefined {
    if (this.turn?.external) return this.host.operatorTargets()[0];
    const origins = this.turn?.origins ?? [];
    const human = this.lastHumanOrigin();
    if (human) return { ...human.replyTarget, replyToMessageId: human.ref.messageId };
    for (const o of [...origins].reverse()) {
      if (o.kind === "peer" && o.mode === "trigger") return o.deliverTo;
      if (o.kind === "scheduler" && o.deliverTo) return o.deliverTo;
    }
    // Only peer-ask / a2a origins → output is a task result, not platform output.
    if (origins.length && origins.every((o) => (o.kind === "peer" && o.mode === "ask") || o.kind === "a2a")) return undefined;
    // Scheduled turns with replyTo "none": the agent delivers with tools itself.
    if (origins.length && origins.every((o) => o.kind === "scheduler" && o.silent)) return undefined;
    // background / peer result / system → backgroundNotify policy (unless the host routes it)
    const override = this.host.backgroundTarget?.(this.channelKey);
    if (override !== undefined) return override ?? undefined;
    const mode = this.host.settings.backgroundNotify.mode;
    if (mode === "off") return undefined;
    if (mode === "last") return this.lastTarget() ?? this.host.operatorTargets()[0];
    return undefined; // "all" handled in postVisible
  }

  private async postVisible(markdown: string) {
    if (this.turn?.external) markdown = `⚠️ **${this.channelKey}** received a message from outside UniQlaw (native Claude peer messaging). Its reply:\n\n${markdown}`;
    const target = this.visibleTarget();
    const targets = target ? [target]
      : this.host.settings.backgroundNotify.mode === "all" && this.isBackgroundTurn() && this.host.backgroundTarget?.(this.channelKey) === undefined
        ? this.host.operatorTargets() : [];
    for (const t of targets) {
      const p = this.host.platform(t.platform);
      if (!p) continue;
      const ref = await p.send(t, markdown).catch((e) => { this.log.error("send failed", { e: String(e) }); return undefined; });
      if (ref && this.turn) this.turn.delivered = true;
    }
    if (this.turn) this.turn.toolBubble = undefined; // next tool status starts a new bubble
  }

  private isBackgroundTurn() {
    const o = this.turn?.origins ?? [];
    return o.length === 0 || o.every((x) => x.kind === "system" || (x.kind === "peer" && x.mode === "result") || (x.kind === "scheduler" && !x.deliverTo && !x.silent));
  }

  private async postToolStatus(line: string) {
    const target = this.visibleTarget();
    // Hold on to this turn: it may end (or the daemon may detach) while we await the platform.
    const turn = this.turn;
    if (!target || !turn) return;
    const p = this.host.platform(target.platform);
    if (!p) return;
    turn.toolLines.push(line);
    const stream = this.host.settings.output.stream;
    if (turn.toolBubble && p.edit && stream !== "off") {
      const lines = turn.toolLines.slice(-8);
      const ok = await p.edit(turn.toolBubble, lines.join("\n")).catch(() => false);
      if (ok) return;
    }
    const { replyToMessageId: _r, ...plain } = target;
    const bubble = await p.send(plain, line).catch(() => undefined);
    turn.toolBubble = stream === "replace" ? bubble : undefined;
    if (bubble) (turn.toolBubbles ??= []).push(bubble);
    turn.toolLines = [line];
  }

  /** (Re)start the stall watchdog while a turn is running. */
  /** Origins of a turn that was in flight when the daemon detached (once, shortly after reopening). */
  private takeResumeOrigins(): Origin[] | undefined {
    const r = this.resumeOrigins;
    this.resumeOrigins = undefined;
    return r && Date.now() < r.until ? r.origins : undefined;
  }

  private armStall() {
    clearTimeout(this.stallTimer);
    const sec = this.host.settings.turn.stallTimeoutSec;
    if (!sec || !this.turn) return;
    this.stallTimer = setTimeout(() => void this.onStall(), sec * 1000);
  }

  private async onStall() {
    if (!this.turn || this.state !== "running") return;
    if (this.waitingForHuman || this.awaitingInput) return this.armStall();
    this.log.warn("turn stalled; abandoning", { afterSec: this.host.settings.turn.stallTimeoutSec });
    const turn = this.turn;
    turn.stalled = true;
    if (this.session?.interrupt && this.capabilities.interrupt) {
      // The interrupt's own turn_end (if the provider still responds) finishes the turn as a stall;
      // otherwise force it after the settle window — but only if it's still the same turn.
      setTimeout(() => { if (this.turn === turn) void this.finishTurn("error", "stall"); }, INTERRUPT_SETTLE_MS);
      await this.session.interrupt().catch(() => {});
    } else {
      await this.finishTurn("error", "stall");
    }
  }

  private async finishTurn(reason: "done" | "interrupted" | "error", error?: string) {
    clearTimeout(this.stallTimer);
    // Segments that streamed but never got a final (interrupt / error): freeze what was shown.
    for (const [id, seg] of [...this.live]) await this.finishLive(id, this.liveView(seg.buf));
    if (this.turn?.stalled) { reason = "error"; error = "stall"; }
    clearTimeout(this.interruptTimer);
    this.stopTyping();
    const turn = this.turn;
    this.turn = undefined;
    // Tool status is progress, not content: once the reply is in the chat, remove it (like OpenClaw).
    // Kept when the turn failed or produced no visible reply, so the human can see what it was doing.
    if (turn?.toolBubbles?.length && reason === "done" && turn.delivered) {
      for (const ref of turn.toolBubbles) {
        const p = this.host.platform(ref.platform);
        if (p?.delete && p.capabilities.delete) void p.delete(ref).catch(() => false); // don't hold up the next turn
      }
    }
    if (turn) {
      this.record("turn_end", reason + (error ? `: ${error}` : ""), { reason, error });
      this.host.emit?.({ type: "turn_end", channelKey: this.channelKey, reason, error, at: Date.now() });
    }
    if (this.session) this.state = "idle"; else this.state = "closed";
    // Steers that landed in the last moments may have raced the turn end; carry their origins.
    const recent = this.steerLog.filter((s) => Date.now() - s.at < STEER_RACE_MS).map((s) => s.origin);
    this.steerLog = [];
    this.steerCarry = recent.length ? { origins: recent, until: Date.now() + STEER_RACE_MS * 3 } : undefined;
    if (turn && reason === "error" && error === "rate_limit" && turn.input && (turn.retries ?? 0) < MAX_RATE_LIMIT_RETRIES && this.session) {
      const n = (turn.retries ?? 0) + 1;
      const delay = rateLimitBackoffMs() * 2 ** (n - 1);
      this.log.warn("rate limited; retrying", { attempt: n, delayMs: delay });
      if (n === 1) await this.postTo(turn, `⏳ Rate limited by the model provider — retrying automatically (up to ${MAX_RATE_LIMIT_RETRIES}×).`);
      this.state = "running"; // hold the queue until the retry has been sent
      clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => {
        this.state = this.session ? "idle" : "closed";
        void this.startTurn(turn.origins, turn.input!, n);
      }, delay);
      return;
    }
    if (turn && reason === "error" && error === "usage_limit") {
      const handled = await this.host.onUsageLimit?.(this.channelKey, { origins: turn.origins, ...(turn.input ? { input: turn.input } : {}) })
        .catch((e) => { this.log.warn("usage-limit handler failed", { e: String(e) }); return false; }) ?? false;
      if (!handled) await this.postTo(turn, `⛔ The usage limit of profile "${this.profile.name}" is reached. Try again later, or ask the owner to switch this chat with /profile.`);
      for (const o of turn.origins) {
        if (o.kind === "peer" && (o.mode === "ask" || o.mode === "trigger")) this.host.onTaskResult(o.taskId, false, "usage limit reached");
        else if (o.kind === "scheduler" && o.taskId) this.host.onTaskResult(o.taskId, false, "usage limit reached");
      }
      this.touch();
      if (this.queue.length) this.scheduleDrain(0);
      return;
    }
    if (turn) {
      const answer = turn.texts.filter((t) => !isSilentReplyText(t)).map((t) => extractReactions(stripSilentToken(t)).cleanText).join("\n\n").trim();
      for (const o of turn.origins) {
        if ((o.kind === "peer" && (o.mode === "ask" || o.mode === "trigger")) || o.kind === "a2a" || (o.kind === "scheduler" && o.taskId)) {
          this.host.onTaskResult(o.taskId!, reason === "done", reason === "done" ? answer : `(${reason}${error ? `: ${error}` : ""}) ${answer}`.trim());
        }
      }
      if (reason === "error" && error) await this.notifyFailure(turn.origins.at(-1), `⚠️ ${error === "rate_limit" ? "Still rate limited after retries — please try again later." : error === "stall" ? "The agent stopped responding; the turn was abandoned." : error}`);
      if (turn.denied && this.capabilities.denyEndsTurn && reason !== "done") {
        // Provider ended the whole turn on deny; continue so the agent can adapt.
        this.queue.unshift({
          origin: { kind: "system", reason: "deny-recovery" },
          item: { text: "The operator denied the permission request for your last action. Continue without it: choose another approach or explain what you need.", receivedAt: Date.now(), sourceLine: "[UniQlaw system]", raw: true },
          attachments: [],
        });
        // Keep the original origins so the continuation reaches the same human.
        const keep = turn.origins.filter((o) => o.kind === "human");
        if (keep.length) this.queue[0]!.origin = keep.at(-1)!;
      }
    }
    this.touch();
    if (this.queue.length) this.scheduleDrain(0);
  }

  // ── approvals / input requests ───────────────────────────────────────────

  private async onPermission(ev: Extract<AgentEvent, { type: "permission_request" }>) {
    this.waitingForHuman = true;
    try { await this.onPermissionInner(ev); } finally { this.waitingForHuman = false; this.armStall(); }
  }

  private async onPermissionInner(ev: Extract<AgentEvent, { type: "permission_request" }>) {
    const s = this.session;
    if (!s?.respondPermission) return;
    const mode = this.profile.permissions.approval.mode;
    if (mode === "auto-allow") return s.respondPermission(ev.id, { behavior: "allow" }, 1);
    if (mode === "auto-deny") return this.deny(s, ev, "auto-deny policy");
    const target = this.approvalTarget();
    const platform = target && this.host.platform(target.platform);
    if (!target || !platform?.askChoice) {
      this.log.warn("no approval route; denying", { tool: ev.tool });
      return this.deny(s, ev, "no approver available");
    }
    const options = ev.options?.length ? ev.options : ["Allow", "Deny"];
    // TUI providers hand over raw dialog text (docs: permission_request.input is unstructured);
    // strip rule lines / tips and show it once.
    const detail = cleanDialogText(typeof ev.input === "string" ? ev.input : JSON.stringify(ev.input, null, 2));
    const title = cleanDialogText(ev.title || "Permission request").split("\n")[0]!.slice(0, 120);
    const body = [`**${this.channelKey}** wants to run **${ev.tool}**`, "```", truncate(detail, 1200), "```"].join("\n");
    const choice = await platform.askChoice({ platform: target.platform, chatId: target.chatId, threadId: target.threadId }, {
      title, body, options, approverIds: [],
      timeoutMs: this.profile.permissions.approval.timeoutSec * 1000,
    }).catch(() => null);
    if (choice === null) return this.deny(s, ev, "approval timed out");
    if (ev.options?.length) {
      // Provider-native option list: deny iff the chosen label reads like a refusal.
      const label = options[choice] ?? "";
      const isDeny = /^(no|deny|cancel|reject)/i.test(label.trim());
      if (isDeny && this.turn) this.turn.denied = true;
      this.record("permission", `${ev.tool}: ${label}`, { decision: isDeny ? "deny" : "allow" });
      return s.respondPermission(ev.id, isDeny ? { behavior: "deny" } : { behavior: "allow" }, choice + 1);
    }
    this.record("permission", `${ev.tool}: ${choice === 0 ? "allow" : "deny"}`, { decision: choice === 0 ? "allow" : "deny" });
    return choice === 0 ? s.respondPermission(ev.id, { behavior: "allow" }, 1) : this.deny(s, ev, "denied by operator");
  }

  private async deny(s: AgentSession, ev: { id: string; options?: string[] }, message: string) {
    if (this.turn) this.turn.denied = true;
    const idx = ev.options?.findIndex((o) => /^(no|deny|cancel|reject)/i.test(o.trim())) ?? -1;
    const d: PermissionDecision = { behavior: "deny", message };
    await s.respondPermission!(ev.id, d, idx >= 0 ? idx + 1 : undefined);
  }

  /** Human on the triggering chain if trusted, else operators. */
  private approvalTarget(): Target | undefined {
    const human = this.lastHumanOrigin();
    if (human?.trusted) return human.replyTarget;
    const root = this.rootTarget();
    if (root) return root;
    return this.host.operatorTargets()[0];
  }

  private async onInputRequest(ev: Extract<AgentEvent, { type: "input_request" }>) {
    const target = this.host.operatorTargets()[0] ?? this.approvalTarget();
    if (!target) return this.log.error("input requested but no operator target", { title: ev.title });
    const p = this.host.platform(target.platform);
    if (!p) return;
    this.awaitingInput = { id: ev.id, target };
    const lines = [`🔑 **${this.channelKey}**: ${ev.title}`];
    if (ev.url) lines.push("", ev.url);
    lines.push("", "Reply to this message with the code / value.");
    await p.send(target, lines.join("\n"));
  }

  // ── misc ─────────────────────────────────────────────────────────────────

  private record(kind: TranscriptKind, text: string, meta?: Record<string, unknown>) {
    if (!this.host.transcript && !this.host.emit) return;
    try {
      this.host.transcript?.append(this.channelKey, kind, text, meta);
      this.host.emit?.({ type: "transcript", channelKey: this.channelKey, entry: { channelKey: this.channelKey, at: Date.now(), kind, text, meta } });
    } catch (e) { this.log.warn("transcript append failed", { e: String(e) }); }
  }

  /** Post a status line to wherever the given turn's output goes. */
  private async postTo(turn: TurnState, text: string) {
    const saved = this.turn;
    this.turn = turn;
    try { await this.postVisible(text); } finally { this.turn = saved; }
  }

  private async notifyFailure(origin: Origin | undefined, text: string) {
    let target: Target | undefined;
    if (origin?.kind === "a2a") { this.host.onTaskResult(origin.taskId, false, text); return; }
    // A plugin is waiting for this turn's answer (ChannelManager.complete): it reports the failure itself.
    if (origin?.kind === "scheduler" && origin.taskId) { this.host.onTaskResult(origin.taskId, false, text); return; }
    if (origin?.kind === "human") target = origin.replyTarget;
    else if (origin?.kind === "peer" && (origin.mode === "ask" || origin.mode === "trigger")) {
      this.host.onTaskResult(origin.taskId, false, text);
      target = origin.mode === "trigger" ? origin.deliverTo : undefined;
    } else target = this.host.operatorTargets()[0];
    if (!target) return;
    await this.host.platform(target.platform)?.send(target, text).catch(() => {});
  }

  private rememberTarget(t: Target) {
    const { replyToMessageId: _r, ...plain } = t;
    this.ensureRow();
    this.host.store.patchSession(this.channelKey, { lastTarget: JSON.stringify(plain) });
  }

  private touch() {
    this.ensureRow();
    this.host.store.patchSession(this.channelKey, { lastActivityAt: Date.now() });
  }

  /** The session row exists from the first input on (open() fills in the provider session). */
  private ensureRow() {
    if (this.host.store.getSession(this.channelKey)) return;
    const now = Date.now();
    this.host.store.upsertSession({ channelKey: this.channelKey, profile: this.profile.name, provider: this.profile.provider,
      providerSessionId: null, multiparty: this.multiparty, createdAt: now, lastActivityAt: now, lastTarget: null, adapterState: null });
  }

  private startTyping() {
    this.stopTyping();
    const pulse = () => {
      const t = this.visibleTarget();
      const p = t && this.host.platform(t.platform);
      if (t && p?.typing) void p.typing(t).catch(() => {});
    };
    pulse();
    this.typingTimer = setInterval(pulse, TYPING_PULSE_MS);
  }
  private stopTyping() { clearInterval(this.typingTimer); this.typingTimer = undefined; }

  idleSince(): number {
    return this.host.store.getSession(this.channelKey)?.lastActivityAt ?? 0;
  }
}

function truncate(s: string, n: number) { return s.length > n ? s.slice(0, n - 1) + "…" : s; }

/** Drop box-drawing rule lines, TUI tips and the trailing question from dialog text. */
export function cleanDialogText(s: string): string {
  return s.split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^[─━╌┄┈═\-_]{3,}$/.test(l) && !/^tip:/i.test(l) && !/^do you want to (proceed|make this edit|create)/i.test(l))
    .join("\n");
}
