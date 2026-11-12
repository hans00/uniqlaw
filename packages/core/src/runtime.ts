// Per-channel runtime: owns one AgentSession, the input queue, the turn state
// machine, output routing (by Origin) and approvals. Provider-agnostic.
import type { AgentEvent, AgentProvider, AgentSession, Attachment, Liveness, PermissionDecision, Profile, SystemPromptParts, TurnInput } from "./provider.ts";
import type { MsgRef, PlatformAdapter, Target } from "./platform.ts";
import type { Origin } from "./origin.ts";
import type { Logger } from "./plugin.ts";
import type { Settings } from "./config.ts";
import type { StateStore } from "./state.ts";
import type { RuntimeEvent, TranscriptKind, TranscriptStore } from "./transcript.ts";
import { ModelRouter, agenticSchema } from "./model-router.ts";
import { restrictsNativeTools, type ToolPolicy } from "./channel-policy.ts";
import { isA2ASession } from "./a2a-policy.ts";
import { describeTargets, SessionLedger, type TargetReport } from "./targets.ts";
import { requestDialect } from "./shell.ts";
import { DEFAULT_LOCAL_TOOLS, compileToolPatterns, detectTaint, writtenPaths, type TaintSource } from "./taint.ts";
import {
  allowBlockers, buildJudgeInput, decideOutcome, hardPolicyDeny, inputFingerprint, inputHash, judgeNote, redactInput, runJudge, strictestKind, writeScope,
  type ObservedAction,
  type ApprovalAuditRecord, type ApprovalDecisionRecord, type ApprovalJudge, type JudgeResult, type SessionKind,
} from "./approval-judge.ts";
import {
  extractReactions, formatPendingForPrompt, formatToolStatus, isPassthroughSlashCommand, isSilentReplyText,
  mergeQueued, stripSilentToken, type PendingNote, type PromptItem,
} from "./format.ts";

export type RuntimeState = "closed" | "opening" | "idle" | "running" | "interrupting";

export interface QueuedInput {
  origin: Origin;
  item: PromptItem;
  attachments: Attachment[];
  /** Replayed after a restart: its deferred_input row, deleted once a turn consumes it (or it is dropped). */
  deferredId?: number;
}

/** What the system prompt builder knows about the session. */
export interface SessionContext {
  channelKey: string;
  internal: boolean;
  cwd?: string;
  worker?: { owner?: string };
  /** Inbound A2A session: the prompt is built from the exposed profile's own `prompt` only (no persona files,
   *  memory or brand prompt), and it names no path. */
  a2a?: { prompt?: string };
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
  /** Inbound A2A sessions: open isolated (SessionSpec.isolated); `unsafeProvider` = the operator allowed a provider
   *  without the `isolation` capability; `prompt` = the exposed profile's own prompt. */
  isolation?(channelKey: string): { unsafeProvider: boolean; prompt?: string } | undefined;
  /** Override where background output goes: a target, null = nowhere, undefined = backgroundNotify policy. */
  backgroundTarget?(channelKey: string): Target | null | undefined;
  /** Tool policy for this session (settings.channels for a chat, A2A_TOOL_POLICY for inbound A2A); undefined = unrestricted. */
  toolPolicyFor?(channelKey: string): ToolPolicy | undefined;
  /** Issue an MCP Gateway token for this channel. */
  gatewayFor(channelKey: string): { url: string; token: string; toolNames: string[]; permissionHookUrl?: string } | undefined;
  /** Minimal isolated env for provider child processes. */
  providerEnv(profile: Profile): Promise<Record<string, string>>;
  /** A turn hit the provider's usage limit. Return true when the host took over telling the human
   *  (e.g. asked the owner to switch profile); false = the runtime posts its usual error. */
  onUsageLimit?(channelKey: string, failed: { origins: Origin[]; input?: TurnInput }): Promise<boolean>;
  /** Called when a peer ask/trigger turn finishes. `mergedInto`: this ask shared its turn with an earlier ask from
   *  the same session, whose result carries the answer; `text` is only a pointer to it (no separate delivery). */
  onTaskResult(taskId: string, ok: boolean, text: string, opts?: { mergedInto?: string }): void;
  /** Graceful restart: return true to take this input away (it is persisted and replayed after the restart)
   *  instead of letting it start a turn now. */
  deferInput?(channelKey: string, input: QueuedInput): boolean;
  /** Replayed inputs left the queue for good (a turn started with them, or they were dropped). */
  releaseDeferred?(ids: number[]): void;
  /** The approval judge of a profile with `permissions.approval.judge` (docs §10.4); undefined = it could not be
   *  built (unknown provider…): requests then go to the operator. */
  approvalJudge?(profile: Profile): ApprovalJudge | undefined;
  /** Approval audit log (`<stateDir>/approvals/YYYY-MM.jsonl`). */
  approvalAudit?: { append(rec: ApprovalAuditRecord | ApprovalDecisionRecord): void };
  /** Optional: bounded transcript for UIs. */
  transcript?: TranscriptStore;
  /** Optional: live runtime events (dashboard SSE). */
  emit?(ev: RuntimeEvent): void;
}

interface TurnState {
  origins: Origin[];
  /** Input that started the turn (for rate-limit retries). */
  input?: TurnInput;
  /** The queued inputs this turn carries, each with its own origin (batch + steered): re-sent one by one if a
   *  restart kills the turn. */
  inputs?: QueuedInput[];
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
  /** For task_status while the turn runs: recent activity (texts, tools) and the text being streamed now. */
  progress?: TurnProgress;
  /** Tool actions observed this turn (for the approval judge's actionTrace), oldest first, bounded. */
  trace?: ObservedAction[];
  /** Untrusted sources found this turn, by the action that brought them in. Kept apart from the bounded trace: a
   *  tainted turn stays tainted however many calls follow. `chain`: detections in observation order. */
  taint?: { found: (TaintSource & { entry: string })[]; chain: Promise<void> };
}

/** What task_status shows about a task its session is still working on. */
export interface TaskProgress {
  /** running: the session's current turn is answering it; queued: it waits for the current turn to end. */
  phase: "running" | "queued";
  /** queued: 1 = next. */
  queuePosition?: number;
  /** running: when this task's work started (ms): the turn's start, or when it joined a running turn (steer). */
  turnStartedAt?: number;
  /** running: the latest assistant text since this task joined the turn (the one being streamed, else the last
   *  finished one), tail-bounded. A steered turn still mixes askers' work after the join: it is one conversation. */
  latestText?: string;
  /** running: the last few activity lines since this task joined ("text: …", "tool: <name>"; no tool inputs), oldest first. */
  recent: string[];
}

/** Activity of a running turn, numbered so each asker sees only what happened after its origin joined the turn. */
interface TurnProgress {
  seq: number;
  lines: { seq: number; line: string }[];
  /** Assistant text being streamed now, and the seq at which it started. */
  partial: string;
  partialSeq: number;
  partialSegment?: string;
  lastText?: { seq: number; text: string };
  /** taskId → seq when its origin joined (steered or merged in mid-turn); absent = there from the start (0). */
  joined: Record<string, number>;
  joinedAt?: Record<string, number>;
}

const PROGRESS_LINES = 10;
const PROGRESS_LINE_CHARS = 200;
const PROGRESS_TEXT_CHARS = 1500;
const oneLine = (s: string, max: number) => { const t = s.replace(/\s+/g, " ").trim(); return t.length > max ? t.slice(0, max - 1) + "…" : t; };
const tailOf = (s: string, max: number) => (s.length > max ? "…" + s.slice(-(max - 1)) : s);

/**
 * Asks from the same session that ended up in one turn (steered into it, or queued and merged at drain) get one
 * result: the earliest of them (in join order) carries the turn's answer and lists the others; each later one is
 * resolved with a pointer to it. One turn's answer delivered N times would flood the asker (a turn's text is all its
 * progress lines plus the final report). Asks from different sessions each still get the whole answer.
 */
export function mergedAsks(origins: Origin[]): { primaryOf: Map<string, string>; mergedFor: Map<string, string[]> } {
  const firstBy = new Map<string, string>();
  const primaryOf = new Map<string, string>();
  const mergedFor = new Map<string, string[]>();
  for (const o of origins) {
    if (o.kind !== "peer" || o.mode !== "ask") continue;
    const first = firstBy.get(o.fromSession);
    if (!first) { firstBy.set(o.fromSession, o.taskId); continue; }
    if (first === o.taskId || primaryOf.has(o.taskId)) continue;
    primaryOf.set(o.taskId, first);
    mergedFor.set(first, [...(mergedFor.get(first) ?? []), o.taskId]);
  }
  return { primaryOf, mergedFor };
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
/** How long a reopened session holds queued input back while its reattached turn may still claim the resumed origins. */
const RESUME_GRACE_MS = 3000;
/** First retry delay; doubles each attempt. Overridable for tests via UNIQLAW_RATE_LIMIT_BACKOFF_MS. */
const rateLimitBackoffMs = () => Number(process.env.UNIQLAW_RATE_LIMIT_BACKOFF_MS ?? 30_000);
const INTERRUPT_SETTLE_MS = 8000;
/** How long a hook-escalated verdict waits for the provider's dialog that follows it. */
const HOOK_ESCALATED_TTL_MS = 60_000;
/** Time budget for computing a request's targets (git and filesystem checks). */
const TARGETS_BUDGET_MS = 3000;
const DEFAULT_HIGH_IMPACT = ["send", "publish", "delete", "install"];
/** Turns that inherit a turn's taint (judge.taint.carryTurns default; sticky = the whole session). */
const DEFAULT_CARRY_TURNS = 3;
const TAINT_FOUND_CAP = 500;

/** Under taint: does the request do something high-impact, or reach external / remote / global / protected targets?
 *  Also: running something, writes outside the scope (`>> ~/.bashrc`), config / secret files (startup files and
 *  hooks run later as code), and making a file executable. Unknown (no targets, unrecognized commands) counts as yes. */
export function highImpact(report: TargetReport | undefined, effects: readonly string[]): boolean {
  if (!report || report.unrecognized.length) return true;
  return report.targets.some((t) => {
    const category = String(t.details?.category ?? "");
    const mode = typeof t.details?.chmod === "string" ? t.details.chmod : undefined;
    return effects.includes(t.effect) || t.effect === "execute" || t.remote || t.details?.hostClass === "external"
      || ["global", "system", "user-global"].includes(String(t.details?.scope)) || t.details?.isProtected === true
      || (t.kind === "path" && t.effect !== "read" && (t.inScope === false || category === "config" || category === "secret"))
      || (t.kind === "path" && category === "secret")
      || (mode !== undefined && (/[+=][rwXst]*x/.test(mode) || (/^[0-7]{3,4}$/.test(mode) && /[1357]/.test(mode.slice(-3)))));
  });
}

type JudgeStageResult = { id: string; outcome: ReturnType<typeof decideOutcome>["outcome"]; pSafe?: number; note?: string; audit: boolean };

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
  /** Last provider event (or turn start / human answer) of the running turn: what both stall limits count from. */
  private lastProgressAt = 0;
  /** Tool calls of the running turn that started but have not ended (a liveness signal for the stall watchdog). */
  private toolsInFlight = new Map<string, string>();
  /** Permission prompts waiting for a human, by provider request id (the stall watchdog is paused meanwhile). */
  private pendingPermissions = new Map<string, AbortController>();
  private permissionChain: Promise<void> = Promise.resolve();
  /** Requests the permission hook judged and escalated: the provider's dialog for each follows and reuses the
   *  verdict when it shows the same request (dialogVerdict). Dropped when the turn ends or is interrupted. */
  private hookEscalated: { at: number; tool: string; input: unknown; fingerprint?: string; judged: JudgeStageResult }[] = [];
  /** The provider's permission hook has reached this session (its dialogs follow a hook verdict). */
  private hookActive = false;
  /** Taint carried from earlier turns (judge.taint.carryTurns / sticky), each with the turns it still applies to. */
  private carriedTaint: (TaintSource & { turnsLeft: number })[] = [];
  /** Files this session wrote while its context was tainted: reading them later brings the taint back. */
  private taintedPaths = new Set<string>();
  /** What this session created (files, dirs, branches, packages, processes, …), for the judge's target provenance. */
  private ledger = new SessionLedger(Date.now(), { processRoot: () => this.session?.processRoot?.() });
  private readonly log: Logger;
  private router?: ModelRouter;
  /** Model the session is on, as far as we know (profile → /model → router → provider "model" events). */
  private activeModel?: string;
  /** Set while a scheduled turn's model override is in effect: the model to switch back to. */
  private modelRestore?: { model?: string };
  /** finishTurn calls still running (they post to platforms after the state went back to idle). */
  private finishing = 0;
  /** A rate-limited turn waiting for its retry (state stays "running", turn is undefined meanwhile). */
  private retrying?: { origins: Origin[]; input?: TurnInput; inputs?: QueuedInput[] };
  /** After reopening on a turn that was in flight at detach: give the reattached turn a moment to claim its
   *  origins before a queued input could start a turn of its own and take them. */
  private resumeGraceUntil = 0;
  private resumeTimer?: ReturnType<typeof setTimeout>;

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

  /** A turn is in flight: running, being interrupted, waiting for a rate-limit retry, or still delivering its end. */
  get busy(): boolean { return this.state === "running" || this.state === "interrupting" || this.finishing > 0; }
  /** Who the in-flight turn answers (also during a rate-limit backoff, when there is no turn object). */
  inflightOrigins(): Origin[] { return this.turn?.origins ?? this.retrying?.origins ?? []; }
  /** The inputs the in-flight turn carries, each with its origin (empty for turns the provider started itself). */
  inflightInputs(): QueuedInput[] { return this.turn?.inputs ?? this.retrying?.inputs ?? []; }
  /** The provider process survives a daemon stop (claude-tmux): an in-flight turn keeps running. */
  get canDetach(): boolean { return !!this.session?.detach; }

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

  /** Progress of a task this session is answering or has queued (task_status), else undefined. */
  progressOf(taskId: string): TaskProgress | undefined {
    const has = (o: Origin) => "taskId" in o && o.taskId === taskId;
    const t = this.turn;
    if (t && this.state !== "idle" && t.origins.some(has)) {
      const p = t.progress;
      const from = p?.joined[taskId] ?? 0;
      const partial = p && p.partialSeq >= from ? p.partial.trim() : "";
      const latest = partial || (p?.lastText && p.lastText.seq >= from ? p.lastText.text.trim() : "");
      return { phase: "running", turnStartedAt: p?.joinedAt?.[taskId] ?? t.startedAt,
        ...(latest ? { latestText: tailOf(latest, PROGRESS_TEXT_CHARS) } : {}),
        recent: (p?.lines ?? []).filter((l) => l.seq >= from).map((l) => l.line) };
    }
    const i = this.queue.findIndex((q) => has(q.origin));
    return i >= 0 ? { phase: "queued", queuePosition: i + 1, recent: [] } : undefined;
  }

  private progressState(t: TurnState): TurnProgress {
    return (t.progress ??= { seq: 0, lines: [], partial: "", partialSeq: 0, joined: {} });
  }

  /** An origin joined the running turn (steer): its task's progress starts here. */
  private noteJoined(origin: Origin) {
    const t = this.turn;
    if (!t || !("taskId" in origin) || !origin.taskId) return;
    const p = this.progressState(t);
    p.joined[origin.taskId] = ++p.seq;
    (p.joinedAt ??= {})[origin.taskId] = Date.now();
  }

  private noteProgress(o: { line?: string; text?: string; delta?: string; segment?: string }) {
    const t = this.turn;
    if (!t) return;
    const p = this.progressState(t);
    // A finished text that was streaming belongs to when its stream began (it may predate a later joiner).
    const seq = o.text !== undefined && p.partial ? p.partialSeq : ++p.seq;
    if (o.line) {
      p.lines.push({ seq, line: oneLine(o.line, PROGRESS_LINE_CHARS) });
      if (p.lines.length > PROGRESS_LINES) p.lines.splice(0, p.lines.length - PROGRESS_LINES);
    }
    if (o.text !== undefined) p.lastText = { seq, text: tailOf(o.text, PROGRESS_TEXT_CHARS) };
    if (o.delta !== undefined) {
      if (o.segment !== p.partialSegment) { p.partial = ""; p.partialSegment = o.segment; }
      if (!p.partial) p.partialSeq = seq;
      p.partial = tailOf(p.partial + o.delta, PROGRESS_TEXT_CHARS);
      return;
    }
    p.partial = "";
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
    // Draining for a restart: no new turn, no steer / interrupt into the running one; replayed after the restart.
    if (this.host.deferInput?.(this.channelKey, input)) return;
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
      this.noteJoined(input.origin);
      this.turn?.inputs?.push(input);
      this.steerLog.push({ origin: input.origin, at: Date.now() });
      try {
        await this.session.steer({ text: prompt, attachments: input.attachments });
        this.release([input]); // a replayed input is consumed now: its deferred row goes
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
      if (dropPolicy === "new") { this.release([input]); return; }
      const removed = this.queue.splice(0, this.queue.length - cap + 1);
      this.release(removed);
      if (dropPolicy === "summarize") for (const d of removed) this.dropped.push(d.item.text.replace(/\s+/g, " ").slice(0, 160));
    }
    this.queue.push(input);
  }

  /** /stop: interrupt and clear the queue. */
  async stop(): Promise<boolean> {
    this.release(this.queue);
    this.queue = [];
    this.dropped = [];
    if (this.state !== "running") return false;
    if (!this.capabilities.interrupt) return false;
    this.hookEscalated = [];
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
    this.ledger = new SessionLedger(Date.now(), { processRoot: () => this.session?.processRoot?.() });
    this.clearTaint();
    this.host.store.patchSession(this.channelKey, { providerSessionId: null, adapterState: null });
  }

  /** Daemon shutdown: keep the provider process alive for reattach when supported. */
  async detach(): Promise<void> {
    if (this.session?.detach) {
      // A turn still running in the provider (e.g. claude-tmux keeps working through a reload): remember who it
      // answers, so the reattached session delivers the reply to them instead of treating it as background output.
      // Peer ask/trigger origins are kept too: the next daemon re-registers their tasks, so the answer still
      // reaches the asking session (ChannelManager.armResumedTasks).
      const keep = this.inflightOrigins().filter((o) => o.kind === "human" || (o.kind === "scheduler" && !o.taskId)
        || (o.kind === "peer" && (o.mode === "ask" || o.mode === "trigger")));
      if (this.busy && keep.length) this.host.store.set(`inflight-turn:${this.channelKey}`, JSON.stringify(keep));
      const s = this.session;
      this.session = undefined;
      this.cancelPermissions(); // the reattached session re-surfaces an open dialog
      this.hookEscalated = [];
      this.stopTyping();
      clearTimeout(this.interruptTimer);
      clearTimeout(this.drainTimer);
      clearTimeout(this.stallTimer);
      clearTimeout(this.resumeTimer);
      this.state = "closed";
      this.turn = undefined;
      s.detach!();
      return;
    }
    return this.close();
  }

  async close(): Promise<void> {
    clearTimeout(this.retryTimer);
    clearTimeout(this.resumeTimer);
    this.retrying = undefined;
    clearTimeout(this.stallTimer);
    this.stopTyping();
    clearTimeout(this.interruptTimer);
    clearTimeout(this.drainTimer);
    const s = this.session;
    this.session = undefined;
    this.cancelPermissions();
    this.hookEscalated = [];
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

  /** Record a tool action for the approval judge (actionTrace) and the session ledger (what this session created). */
  private observeTool(ev: Extract<AgentEvent, { type: "tool_start" | "tool_end" }>) {
    try {
      const cwd = this.host.cwdFor?.(this.channelKey) ?? this.host.projectDir;
      if (ev.type === "tool_start") {
        this.ledger.observe(ev.name, ev.input, cwd);
        if (!this.turn) return;
        const trace = (this.turn.trace ??= []);
        const det = this.taintOf(ev.name, ev.input, cwd);
        trace.push({ id: ev.id, tool: ev.name, input: ev.input, ...det });
        if (trace.length > 60) trace.splice(0, trace.length - 60);
        if (det.taint) this.trackTaint(this.turn, ev.id, ev.name, ev.input, cwd, det.taint);
        return;
      }
      const e = this.turn?.trace?.find((x) => x.id === ev.id);
      if (!e) return;
      e.ok = ev.ok;
      if (ev.summary) { e.output = ev.summary; this.ledger.observe(e.tool, e.input, cwd, ev.summary); }
    } catch (e) { this.log.warn("tool observation failed", { e: String(e) }); }
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
    this.ledger = new SessionLedger(Date.now(), { processRoot: () => this.session?.processRoot?.() });
    this.taintedPaths = new Set();
    const cur = this.host.store.getSession(this.channelKey)!;
    // A resumed provider session still holds what earlier turns read: keep their carried taint; a new one starts clean.
    this.carriedTaint = cur.providerSessionId ? this.loadCarriedTaint() : [];
    const toolPolicy = this.host.toolPolicyFor?.(this.channelKey);
    const gw = this.host.gatewayFor(this.channelKey);
    const cwd = this.host.cwdFor?.(this.channelKey) ?? this.host.projectDir;
    const worker = this.host.workerOf?.(this.channelKey);
    const iso = this.host.isolation?.(this.channelKey);
    try {
      // Fail closed: a remote-driven session on a provider that can't isolate it would run with the operator's
      // settings, MCP servers and files.
      if (iso && !this.capabilities.isolation && !iso.unsafeProvider) {
        throw new Error(`provider "${this.profile.provider}" cannot isolate inbound A2A sessions (set expose.${this.profile.name}.unsafeProvider to allow it anyway)`);
      }
      // Chats only: an inbound A2A session's native tools are covered by the check above (an isolating provider
      // runs it with no built-in tools and enforces the profile's denyTools, which a2aPermissions fills).
      if (!iso && restrictsNativeTools(toolPolicy) && !this.capabilities.toolPolicy) {
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
          ...(iso ? { a2a: { ...(iso.prompt ? { prompt: iso.prompt } : {}) } } : {}),
        }),
        ...(toolPolicy ? { toolPolicy } : {}),
        ...(iso ? { isolated: true } : {}),
        mcp: gw,
        // UNIQLAW_SESSION: lets `uniqlaw restart` / `reload` run from the agent's shell name the session asking.
        env: { ...(await this.host.providerEnv(this.profile)), UNIQLAW_SESSION: this.channelKey },
        instanceId: this.host.instanceId,
        nativeMemory: iso ? false : !this.host.settings.memory.enabled || this.host.settings.memory.nativeMemory,
      });
      const inflight = this.host.store.get(`inflight-turn:${this.channelKey}`);
      if (inflight) {
        this.host.store.del(`inflight-turn:${this.channelKey}`);
        try {
          this.resumeOrigins = { origins: JSON.parse(inflight) as Origin[], until: Date.now() + RESUME_ORIGINS_MS };
          this.resumeGraceUntil = Date.now() + RESUME_GRACE_MS;
          clearTimeout(this.resumeTimer);
          this.resumeTimer = setTimeout(() => this.expireResume(), RESUME_ORIGINS_MS);
        } catch {}
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
      this.release(failed);
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
    if (this.host.deferInput) {
      this.queue = this.queue.filter((q) => !this.host.deferInput!(this.channelKey, q));
      if (!this.queue.length) return;
    }
    // The reattached provider may still be in the turn that was in flight at detach: let it claim its origins first.
    if (this.resumeOrigins && Date.now() < this.resumeGraceUntil) return this.scheduleDrain(250);
    const debounce = this.host.settings.queue.debounceMs;
    const wait = debounce - (Date.now() - this.lastEnqueuedAt);
    // Only debounce when several messages are piling up (first message goes out immediately).
    if (this.queue.length > 1 && wait > 0) return this.scheduleDrain(wait);

    // Slash commands must reach the provider clean and alone.
    const first = this.queue[0]!;
    if (isPassthroughSlashCommand(first.item.text) && first.origin.kind === "human") {
      this.queue.shift();
      this.release([first]);
      // /clear, /compact, /new, /reset: what earlier turns read leaves the context (compaction keeps only a summary).
      if (/^\/(clear|compact|new|reset)\b/i.test(first.item.text.trim())) this.clearTaint();
      return this.startTurn([first.origin], { text: first.item.text.trim(), attachments: [], slashCommand: true }, 0, [first]);
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
    this.release(batch);
    await this.startTurn(batch.map((b) => b.origin), { text, attachments: batch.flatMap((b) => b.attachments) }, 0, batch);
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
  /** These inputs are gone from the queue for good: their deferred_input rows (if replayed) can go. */
  private release(items: QueuedInput[]) {
    const ids = items.map((q) => q.deferredId).filter((x): x is number => x !== undefined);
    if (ids.length) this.host.releaseDeferred?.(ids);
  }

  /** Summaries of inputs dropped because the queue was full (not yet shown to the agent). */
  takeDropped(): string[] { return this.dropped.splice(0); }

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

  private async startTurn(origins: Origin[], input: TurnInput, retries = 0, inputs?: QueuedInput[]): Promise<void> {
    if (!this.session) return;
    this.expireResume(); // another turn comes first: the resumed one is not coming back
    this.steerLog = [];
    this.steerCarry = undefined;
    this.turn = { origins, input, ...(inputs ? { inputs: [...inputs] } : {}), retries, startedAt: Date.now(), texts: [], toolLines: [], denied: false, unsolicited: false };
    this.toolsInFlight.clear();
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
    if (ev.type === "tool_start") this.toolsInFlight.set(ev.id, ev.name);
    else if (ev.type === "tool_end") this.toolsInFlight.delete(ev.id);
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
        if (ev.delta !== undefined && ev.final === undefined) { this.noteProgress({ delta: ev.delta, segment: ev.segmentId }); this.onDelta(ev.segmentId, ev.delta); return; }
        if (ev.final !== undefined) await this.onFinalText(ev.final, ev.segmentId);
        return;
      case "thinking":
        if (this.host.settings.output.thinking && ev.text.trim()) await this.postVisible(`_${ev.text.trim()}_`);
        return;
      case "tool_start":
        this.observeTool(ev);
        this.record("tool", formatToolStatus(ev.name, ev.input));
        this.noteProgress({ line: `tool: ${ev.name}` }); // name only: inputs may belong to another asker's work
        if (this.host.settings.output.toolStatus) await this.postToolStatus(formatToolStatus(ev.name, ev.input));
        return;
      case "tool_end":
        this.observeTool(ev);
        return;
      case "permission_request":
        this.startPermission(ev);
        return;
      case "permission_withdrawn":
        this.cancelPermissions(ev.id);
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
    this.noteProgress({ line: `text: ${raw}`, text: raw });
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

  /** Origins of a turn that was in flight when the daemon detached (once, shortly after reopening). */
  private takeResumeOrigins(): Origin[] | undefined {
    const r = this.resumeOrigins;
    if (!r || Date.now() >= r.until) { this.expireResume(); return undefined; }
    this.resumeOrigins = undefined;
    clearTimeout(this.resumeTimer);
    return r.origins;
  }

  /** The turn in flight at detach never showed up again (it ended while the daemon was down, or another turn came
   *  first): fail the tasks it was answering, so their askers don't wait forever. */
  private expireResume() {
    const r = this.resumeOrigins;
    this.resumeOrigins = undefined;
    clearTimeout(this.resumeTimer);
    for (const o of r?.origins ?? []) {
      if (o.kind === "peer" && (o.mode === "ask" || o.mode === "trigger")) {
        this.host.onTaskResult(o.taskId, false, "the answer was given while UniQlaw was restarting and could not be collected; ask again");
      }
    }
  }

  /** (Re)start the stall watchdog while a turn is running. progress=false: re-check later without counting it as
   *  progress (the hard ceiling keeps counting from the last real event). */
  private armStall(progress = true) {
    clearTimeout(this.stallTimer);
    const { stallTimeoutSec: sec, stallMaxSec: maxSec } = this.host.settings.turn;
    if (!sec || !this.turn) return;
    if (progress) this.lastProgressAt = Date.now();
    let ms = sec * 1000;
    if (maxSec) ms = Math.max(1, Math.min(ms, this.lastProgressAt + maxSec * 1000 - Date.now()));
    this.stallTimer = setTimeout(() => void this.onStall(), ms);
  }

  /** No provider event for turn.stallTimeoutSec. Abandon the turn only if nothing shows it is still alive, or once
   *  turn.stallMaxSec has passed without an event whatever the signals say. */
  private async onStall() {
    if (!this.turn || this.state !== "running") return;
    if (this.pendingPermissions.size || this.awaitingInput) return this.armStall();
    const turn = this.turn;
    const { stallTimeoutSec: sec, stallMaxSec: maxSec } = this.host.settings.turn;
    const now = Date.now();
    const quietMs = now - this.lastProgressAt;
    let live: Liveness | undefined;
    let livenessError: string | undefined;
    if (this.session?.liveness) {
      try { live = await this.session.liveness(); } catch (e) { livenessError = String(e); }
    }
    if (this.turn !== turn || this.state !== "running") return;
    const recent = live?.lastActivityAt !== undefined && now - live.lastActivityAt < sec * 1000;
    const alive = this.toolsInFlight.size > 0 || !!live?.busy || recent;
    const capped = maxSec > 0 && quietMs >= maxSec * 1000;
    const signals = {
      quietSec: Math.round(quietMs / 1000), stallTimeoutSec: sec, stallMaxSec: maxSec,
      toolsInFlight: [...this.toolsInFlight.values()],
      liveness: this.session?.liveness ? (livenessError ? { error: livenessError } : {
        busy: live?.busy, lastActivityAgoSec: live?.lastActivityAt !== undefined ? Math.round((now - live.lastActivityAt) / 1000) : undefined,
        ...live?.signals }) : "not reported by this provider",
    };
    if (alive && !capped) {
      this.log.info("turn quiet but alive; not a stall", signals);
      return this.armStall(false);
    }
    this.log.warn(capped ? "turn stalled: hard ceiling (turn.stallMaxSec) reached; abandoning" : "turn stalled: no liveness signal; abandoning", signals);
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
    this.finishing++;
    try { await this.finishTurnInner(reason, error); } finally { this.finishing--; }
  }

  private async finishTurnInner(reason: "done" | "interrupted" | "error", error?: string) {
    clearTimeout(this.stallTimer);
    this.toolsInFlight.clear();
    // The turn is over: a prompt still waiting has nothing left to answer, and hook verdicts belong to this turn.
    this.cancelPermissions();
    this.hookEscalated = [];
    // Segments that streamed but never got a final (interrupt / error): freeze what was shown.
    for (const [id, seg] of [...this.live]) await this.finishLive(id, this.liveView(seg.buf));
    if (this.turn?.stalled) { reason = "error"; error = "stall"; }
    clearTimeout(this.interruptTimer);
    this.stopTyping();
    const turn = this.turn;
    this.turn = undefined;
    if (turn) await this.carryTaint(turn);
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
      this.retrying = { origins: turn.origins, input: turn.input, ...(turn.inputs ? { inputs: turn.inputs } : {}) };
      clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => {
        this.retrying = undefined;
        this.state = this.session ? "idle" : "closed";
        void this.startTurn(turn.origins, turn.input!, n, turn.inputs);
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
      const result = reason === "done" ? answer : `(${reason}${error ? `: ${error}` : ""}) ${answer}`.trim();
      const { primaryOf, mergedFor } = mergedAsks(turn.origins);
      const done = new Set<string>();
      for (const o of turn.origins) {
        if ((o.kind === "peer" && (o.mode === "ask" || o.mode === "trigger")) || o.kind === "a2a" || (o.kind === "scheduler" && o.taskId)) {
          if (done.has(o.taskId!)) continue;
          done.add(o.taskId!);
          const into = primaryOf.get(o.taskId!);
          if (into) { this.host.onTaskResult(o.taskId!, reason === "done", `merged into task ${into}; result delivered there`, { mergedInto: into }); continue; }
          const merged = mergedFor.get(o.taskId!);
          this.host.onTaskResult(o.taskId!, reason === "done", merged ? `[This result also answers your agent_asks ${merged.join(", ")}: they joined this turn]\n\n${result}` : result);
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

  /**
   * A permission request is handled off the event loop (prompts still one at a time, in order), so the loop keeps
   * seeing events while a human decides: a withdrawal (`permission_withdrawn`: the dialog was answered elsewhere or
   * went away), the turn's end, or the session closing all cancel the waiting prompt instead of leaving the turn
   * stuck behind it (with `timeoutSec: 0` it would never end).
   */
  private startPermission(ev: Extract<AgentEvent, { type: "permission_request" }>) {
    const ac = new AbortController();
    this.pendingPermissions.get(ev.id)?.abort();
    this.pendingPermissions.set(ev.id, ac);
    this.permissionChain = this.permissionChain
      .then(() => (ac.signal.aborted ? undefined : this.onPermissionInner(ev, ac.signal)))
      .catch((e) => this.log.error("permission handling failed", { tool: ev.tool, e: String(e) }))
      .finally(() => {
        if (this.pendingPermissions.get(ev.id) === ac) this.pendingPermissions.delete(ev.id);
        this.armStall();
      });
  }

  /** Cancel one waiting permission prompt (the provider withdrew it), or all of them. */
  private cancelPermissions(id?: string) {
    for (const [k, ac] of this.pendingPermissions) if (id === undefined || k === id) ac.abort();
  }

  private async onPermissionInner(ev: Extract<AgentEvent, { type: "permission_request" }>, signal?: AbortSignal) {
    const s = this.session;
    if (!s?.respondPermission) return;
    const mode = this.profile.permissions.approval.mode;
    if (mode === "auto-allow") return s.respondPermission(ev.id, { behavior: "allow" }, 1);
    if (mode === "auto-deny") return this.deny(s, ev, "auto-deny policy");
    const judged = await this.dialogVerdict(ev) ?? await this.judgeStage(ev);
    if (signal?.aborted) return;
    if (judged?.outcome.action === "allow") {
      this.record("permission", `${ev.tool}: allow (${judged.note})`, { decision: "allow", by: "judge", pSafe: judged.pSafe });
      return s.respondPermission(ev.id, { behavior: "allow", scope: "once" }, onceOption(ev.options));
    }
    if (judged?.outcome.action === "deny") {
      this.record("permission", `${ev.tool}: deny (${judged.outcome.rule})`, { decision: "deny", by: "policy" });
      return this.deny(s, ev, `blocked by policy: ${judged.outcome.rule}`);
    }
    const decided = (humanDecision: ApprovalDecisionRecord["humanDecision"]) => {
      if (judged?.audit) this.audit({ id: judged.id, humanDecision, decidedAt: new Date().toISOString() });
    };
    const target = this.approvalTarget();
    const platform = target && this.host.platform(target.platform);
    if (!target || !platform?.askChoice) {
      this.log.warn("no approval route; denying", { tool: ev.tool });
      decided("no-route");
      return this.deny(s, ev, "no approver available");
    }
    const options = ev.options?.length ? ev.options : ["Allow", "Deny"];
    // TUI providers hand over raw dialog text (docs: permission_request.input is unstructured);
    // strip rule lines / tips and show it once.
    const detail = cleanDialogText(typeof ev.input === "string" ? ev.input : JSON.stringify(ev.input, null, 2));
    const title = cleanDialogText(ev.title || "Permission request").split("\n")[0]!.slice(0, 120);
    const body = [...(judged?.note ? [`🤖 ${judged.note}`] : []), `**${this.channelKey}** wants to run **${ev.tool}**`, "```", truncate(detail, 1200), "```"].join("\n");
    const choice = await platform.askChoice({ platform: target.platform, chatId: target.chatId, threadId: target.threadId }, {
      title, body, options, approverIds: [],
      timeoutMs: this.profile.permissions.approval.timeoutSec * 1000,
      ...(signal ? { signal } : {}),
    }).catch(() => null);
    // Withdrawn while the human was deciding: the provider moved on, there is nothing left to answer.
    if (signal?.aborted) { decided("cancelled"); this.record("permission", `${ev.tool}: cancelled (resolved elsewhere)`, { decision: "cancelled" }); return; }
    if (choice === null) { decided("timeout"); return this.deny(s, ev, "approval timed out"); }
    const judgeMeta = judged ? { by: "operator", ...(judged.pSafe !== undefined ? { pSafe: judged.pSafe } : {}) } : {};
    if (ev.options?.length) {
      // Provider-native option list: deny iff the chosen label reads like a refusal.
      const label = options[choice] ?? "";
      const isDeny = /^(no|deny|cancel|reject)/i.test(label.trim());
      if (isDeny && this.turn) this.turn.denied = true;
      decided(isDeny ? "deny" : "allow");
      this.record("permission", `${ev.tool}: ${label}`, { decision: isDeny ? "deny" : "allow", ...judgeMeta });
      return s.respondPermission(ev.id, isDeny ? { behavior: "deny" } : { behavior: "allow" }, choice + 1);
    }
    decided(choice === 0 ? "allow" : "deny");
    this.record("permission", `${ev.tool}: ${choice === 0 ? "allow" : "deny"}`, { decision: choice === 0 ? "allow" : "deny", ...judgeMeta });
    return choice === 0 ? s.respondPermission(ev.id, { behavior: "allow" }, 1) : this.deny(s, ev, "denied by operator");
  }

  /** Session kinds this request answers to: the session's own (A2A, worker) and one per origin of the turn. The
   *  strictest decides (strictestKind). A worker's peer origins are its owner's asks: "worker". */
  sessionKinds(): SessionKind[] {
    const worker = this.channelKey.startsWith("worker:");
    const kinds = new Set<SessionKind>();
    if (isA2ASession(this.channelKey)) kinds.add("a2a");
    if (worker) kinds.add("worker");
    const origins = this.turn?.origins ?? [];
    for (const o of origins) {
      kinds.add(o.kind === "human" ? (o.trusted ? "chat" : "peer") : o.kind === "a2a" ? "a2a" : o.kind === "scheduler" ? "cron"
        : o.kind === "peer" && worker ? "worker" : "peer");
    }
    if (!origins.length) kinds.add(this.host.isInternal?.(this.channelKey) ? "cron" : worker ? "worker" : "peer");
    return [...kinds];
  }

  /** The newest message of a trusted human, as they wrote it, only when every origin of the turn is a trusted
   *  human: a steered-in peer, cron or A2A message must not make its own call look human-requested. */
  private trustedHumanText(): string | undefined {
    const origins = this.turn?.origins ?? [];
    if (!origins.length || !origins.every((o) => o.kind === "human" && o.trusted)) return undefined;
    for (const q of [...(this.turn?.inputs ?? [])].reverse()) {
      if (q.origin.kind === "human" && q.origin.trusted && !q.item.raw) return q.item.text;
    }
    return undefined;
  }

  /**
   * Permission hook (claude-tmux `PermissionRequest`, docs §10.4): judge the structured request before the provider
   * shows its dialog. allow / deny answer it; undefined defers to the dialog, which then reuses this verdict.
   */
  async permissionHook(req: { tool: string; input: unknown }): Promise<{ behavior: "allow" } | { behavior: "deny"; message: string } | undefined> {
    const cfg = this.profile.permissions.approval.judge;
    if (!cfg || cfg.mode === "off" || this.profile.permissions.approval.mode !== "ask-operator" || !this.session) return undefined;
    this.hookActive = true;
    const ev = { type: "permission_request" as const, id: `hook:${crypto.randomUUID()}`, tool: req.tool, input: req.input, title: "" };
    const judged = await this.judgeStage(ev);
    if (!judged) return undefined;
    if (judged.outcome.action === "allow") {
      this.record("permission", `${req.tool}: allow (${judged.note})`, { decision: "allow", by: "judge", pSafe: judged.pSafe });
      return { behavior: "allow" };
    }
    if (judged.outcome.action === "deny") {
      this.record("permission", `${req.tool}: deny (${judged.outcome.rule})`, { decision: "deny", by: "policy" });
      return { behavior: "deny", message: `blocked by policy: ${judged.outcome.rule}` };
    }
    this.hookEscalated.push({ at: Date.now(), tool: req.tool, input: req.input, fingerprint: inputFingerprint(req.tool, req.input), judged });
    return undefined;
  }

  /**
   * A provider dialog (raw text) after the permission hook has been active: reuse the hook's verdict only when the
   * dialog shows the same request (tool, and the command / path / URL found in the dialog text). Unmatched: escalate
   * with no score. Hard policy runs again either way. undefined = no hook in play: judge the dialog itself.
   */
  private async dialogVerdict(ev: Extract<AgentEvent, { type: "permission_request" }>): Promise<JudgeStageResult | undefined> {
    const cfg = this.profile.permissions.approval.judge;
    if (!cfg || cfg.mode === "off" || typeof ev.input !== "string" || !this.hookActive) return undefined;
    const now = Date.now();
    this.hookEscalated = this.hookEscalated.filter((h) => now - h.at < HOOK_ESCALATED_TTL_MS);
    const text = ev.input.replace(/\s+/g, "");
    const i = this.hookEscalated.findIndex((h) => !!h.fingerprint && text.includes(h.fingerprint)
      && (ev.tool === "unknown" || ev.tool.toLowerCase() === h.tool.toLowerCase()));
    const hit = i >= 0 ? this.hookEscalated.splice(i, 1)[0]! : undefined;
    const policy = this.profile.permissions;
    const cwd = this.host.cwdFor?.(this.channelKey) ?? this.host.projectDir;
    const toolPolicy = this.host.toolPolicyFor?.(this.channelKey);
    const rule = hardPolicyDeny({ tool: ev.tool, input: ev.input, structured: false, policy, toolPolicy, cwd })
      ?? (hit ? hardPolicyDeny({ tool: hit.tool, input: hit.input, structured: true, policy, toolPolicy, cwd, dialect: requestDialect(hit.tool, hit.input, this.capabilities.shellDialects) }) : undefined);
    if (rule && cfg.mode === "enforce") return { id: hit?.judged.id ?? crypto.randomUUID(), outcome: { action: "deny", rule }, audit: false };
    if (hit) return hit.judged;
    const id = crypto.randomUUID();
    if (cfg.audit) {
      this.audit({ id, ts: new Date().toISOString(), channelKey: this.channelKey, sessionKind: strictestKind(cfg, this.sessionKinds()).kind,
        provider: this.profile.provider, tool: ev.tool, structured: false, inputHash: inputHash(ev.input), input: redactInput(ev.input),
        mode: cfg.mode, outcome: "escalate", reason: "hook-unmatched", threshold: null });
    }
    return { id, outcome: { action: "escalate", reason: "hook-unmatched" }, audit: cfg.audit };
  }

  /** Judge stage (docs §10.4): hard policy, then the judge. undefined = no judge configured (mode off). */
  private async judgeStage(ev: Extract<AgentEvent, { type: "permission_request" }>): Promise<JudgeStageResult | undefined> {
    const policy = this.profile.permissions;
    const cfg = policy.approval.judge;
    if (!cfg || cfg.mode === "off") return undefined;
    const id = crypto.randomUUID();
    const { kind, threshold: kindThreshold } = strictestKind(cfg, this.sessionKinds());
    let threshold = kindThreshold;
    const cwd = this.host.cwdFor?.(this.channelKey) ?? this.host.projectDir;
    const toolPolicy = this.host.toolPolicyFor?.(this.channelKey);
    const structured = typeof ev.input !== "string";
    const dialect = requestDialect(ev.tool, ev.input, this.capabilities.shellDialects);
    const hardDeny = hardPolicyDeny({ tool: ev.tool, input: ev.input, structured, policy, toolPolicy, cwd, dialect });
    const human = this.trustedHumanText();
    const own = this.ownEntry(ev);
    const trace = this.capabilities.toolTrace === false ? undefined : this.traceBefore(ev);
    const targets = structured ? await this.targetsOf(ev, cwd) : undefined;
    // Taint: untrusted content in the context makes high-impact or far-reaching requests need a stricter score.
    const taint = await this.taintBefore(own?.id);
    const taintStrict = !!taint?.length && threshold !== undefined && highImpact(targets, cfg.taint?.highImpactEffects ?? DEFAULT_HIGH_IMPACT);
    if (taintStrict) threshold = Math.max(threshold!, cfg.taint?.taintedAbove ?? 0.97);
    const { altered, ...input } = buildJudgeInput({ tool: ev.tool, input: ev.input, policy, toolPolicy, cwd, sessionKind: kind, dialect,
      ...(human ? { humanRequest: human } : {}), ...(trace ? { trace } : {}), ...(targets ? { targets } : {}), ...(taint ? { taint } : {}) });
    const blockers = allowBlockers({ tool: ev.tool, input: ev.input, structured, altered, policy, dialect });
    if (ev.options?.length && onceOption(ev.options) === undefined) blockers.push("no-once-option");
    let judge: ApprovalJudge | undefined;
    try { judge = this.host.approvalJudge?.(this.profile); } catch (e) { this.log.warn("approval judge unavailable", { e: String(e) }); }
    // A hard deny in enforce mode needs no score; shadow still scores it (calibration data).
    let judged: JudgeResult | undefined;
    if (!(hardDeny && cfg.mode === "enforce")) {
      judged = judge ? await runJudge(judge, input, cfg.timeoutMs) : { ok: false, error: `judge provider "${cfg.provider}" is not available`, latencyMs: 0 };
    }
    const { outcome, would } = decideOutcome({ mode: cfg.mode, ...(hardDeny ? { hardDeny } : {}), ...(judged ? { judged } : {}), ...(threshold !== undefined ? { threshold } : {}), structured, blockers,
      inducedAbove: cfg.inducedAbove ?? 0.5, taskAbove: cfg.taskAbove ?? 0.5 });
    if (judged && !judged.ok) this.log.warn("approval judge failed; asking the operator", { tool: ev.tool, error: judged.error });
    const name = judge?.name ?? cfg.provider;
    const pSafe = judged?.ok ? judged.pSafe : undefined;
    if (cfg.audit) {
      this.audit({
        id, ts: new Date().toISOString(), channelKey: this.channelKey, sessionKind: kind, provider: this.profile.provider,
        tool: ev.tool, structured, inputHash: inputHash(ev.input), input: input.input, judge: name,
        ...(judged?.ok && judged.model ? { model: judged.model } : {}), ...(pSafe !== undefined ? { pSafe } : {}),
        threshold: threshold ?? null, mode: cfg.mode, outcome: outcome.action,
        ...(outcome.action === "escalate" ? { reason: outcome.reason } : outcome.action === "deny" ? { reason: outcome.rule } : {}),
        ...(cfg.mode === "shadow" ? { wouldOutcome: would.action, ...(would.action === "escalate" ? { wouldReason: would.reason } : {}) } : {}),
        ...(blockers.length ? { blockers } : {}),
        actionTrace: input.actionTrace, ...(input.targets ? { targets: input.targets } : {}), ...(input.unrecognized ? { unrecognized: input.unrecognized } : {}),
        ...(input.agentRationale ? { agentRationale: input.agentRationale } : {}),
        ...(input.taint ? { taint: input.taint, taintStrict } : {}),
        ...(judged?.ok && judged.pInduced !== undefined ? { pInduced: judged.pInduced } : {}), ...(judged?.ok && judged.inducedLabel ? { inducedLabel: judged.inducedLabel } : {}),
        ...(judged?.ok && judged.pTask !== undefined ? { pTask: judged.pTask } : {}), ...(judged?.ok && judged.inducedError ? { inducedError: judged.inducedError } : {}),
        ...(judged ? { latencyMs: judged.latencyMs } : {}), ...(judged && !judged.ok ? { error: judged.error } : {}),
      });
    }
    const note = judgeNote(name, judged, threshold);
    return { id, outcome, ...(pSafe !== undefined ? { pSafe } : {}), ...(note ? { note } : {}), audit: cfg.audit };
  }

  /** Start detecting the untrusted sources an observed action brings in (only with a judge and taint on). */
  private taintOf(tool: string, input: unknown, cwd: string): { taint?: Promise<TaintSource[]> } {
    const cfg = this.profile.permissions.approval.judge;
    if (!cfg || cfg.mode === "off" || cfg.taint?.enabled === false) return {};
    const scope = writeScope(this.profile.permissions, cwd) ?? [cwd];
    return { taint: detectTaint(tool, input, { cwd, scope, ledger: this.ledger, trustRepoFiles: cfg.taint?.trustRepoFiles ?? true,
      thirdPartyTools: compileToolPatterns(cfg.taint?.thirdPartyTools), localTools: compileToolPatterns(cfg.taint?.localTools, DEFAULT_LOCAL_TOOLS),
      taintedPath: (abs) => this.taintedPaths.has(abs), dialect: requestDialect(tool, input, this.capabilities.shellDialects), at: Date.now() })
      .catch(() => [] as TaintSource[]) };
  }

  /** Record what an observed action brought in, in observation order; a file it writes while the context is tainted
   *  (its own read included: `curl -o`) inherits the taint. */
  private trackTaint(turn: TurnState, entry: string, tool: string, input: unknown, cwd: string, found: Promise<TaintSource[]>) {
    const tt = (turn.taint ??= { found: [], chain: Promise.resolve() });
    tt.chain = tt.chain.then(async () => {
      for (const t of await found) {
        if (tt.found.length >= TAINT_FOUND_CAP) break; // the turn is tainted already; more labels add nothing
        if (!tt.found.some((f) => f.entry === entry && f.kind === t.kind && f.id === t.id)) tt.found.push({ ...t, entry });
      }
      if (tt.found.length || this.carriedTaint.length || this.originTaint(turn).length) {
        for (const p of writtenPaths(tool, input, cwd, requestDialect(tool, input, this.capabilities.shellDialects))) this.taintedPaths.add(p);
      }
    }).catch(() => undefined);
  }

  /** Taint from the turn's message origins (peer, cron, A2A, untrusted humans). */
  private originTaint(turn: TurnState | undefined): TaintSource[] {
    const now = Date.now();
    const out: TaintSource[] = [];
    for (const o of turn?.origins ?? []) {
      if (o.kind === "peer") out.push({ kind: "peer-message", id: o.fromSession, at: now });
      else if (o.kind === "scheduler") out.push({ kind: "cron-message", id: o.job, at: now });
      else if (o.kind === "a2a") out.push({ kind: "a2a-message", id: o.remote, at: now });
      else if (o.kind === "human" && !o.trusted) out.push({ kind: "untrusted-human", id: o.sender.name, at: now });
    }
    return out;
  }

  /** Untrusted sources in the context before this request: found this turn (the request's own action left out), the
   *  turn's message origins and taint carried from earlier turns. undefined = taint tracking off. */
  private async taintBefore(ownEntry: string | undefined): Promise<TaintSource[] | undefined> {
    const cfg = this.profile.permissions.approval.judge;
    if (!cfg || cfg.taint?.enabled === false) return undefined;
    const tt = this.turn?.taint;
    if (tt) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([tt.chain, new Promise<void>((res) => { timer = setTimeout(res, TARGETS_BUDGET_MS); })]).finally(() => clearTimeout(timer));
    }
    const all: TaintSource[] = [...this.carriedTaint.map(({ turnsLeft: _, ...t }) => t), ...(tt?.found ?? []).filter((f) => f.entry !== ownEntry).map(({ entry: _, ...t }) => t),
      ...this.originTaint(this.turn)];
    const seen = new Set<string>();
    return all.filter((t) => { const k = `${t.kind}:${t.id}`; if (seen.has(k)) return false; seen.add(k); return true; });
  }

  /** Turn end: what this turn read stays in the agent's context, so its taint applies to the next `carryTurns`
   *  turns (sticky: the rest of the session); older carried taint counts down. Persisted for a resumed session. */
  private async carryTaint(turn: TurnState) {
    const cfg = this.profile.permissions.approval.judge;
    if (!cfg || cfg.mode === "off" || cfg.taint?.enabled === false) return;
    if (turn.taint) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([turn.taint.chain, new Promise<void>((res) => { timer = setTimeout(res, TARGETS_BUDGET_MS); })]).finally(() => clearTimeout(timer));
    }
    const n = cfg.taint?.sticky ? Number.POSITIVE_INFINITY : cfg.taint?.carryTurns ?? DEFAULT_CARRY_TURNS;
    const next = new Map<string, TaintSource & { turnsLeft: number }>();
    for (const t of this.carriedTaint) if (t.turnsLeft - 1 > 0) next.set(`${t.kind}:${t.id}`, { ...t, turnsLeft: t.turnsLeft - 1 });
    if (n > 0) {
      for (const { entry: _, ...t } of [...(turn.taint?.found ?? []), ...this.originTaint(turn).map((x) => ({ ...x, entry: "" }))]) {
        const k = `${t.kind}:${t.id}`;
        if (next.size >= TAINT_FOUND_CAP && !next.has(k)) continue;
        next.set(k, { ...t, turnsLeft: n });
      }
    }
    this.carriedTaint = [...next.values()];
    this.saveCarriedTaint();
  }

  private clearTaint() { this.carriedTaint = []; this.taintedPaths = new Set(); this.saveCarriedTaint(); }
  private saveCarriedTaint() {
    try {
      if (this.carriedTaint.length) this.host.store.set(`taint:${this.channelKey}`, JSON.stringify(this.carriedTaint.map((t) => ({ ...t, turnsLeft: Number.isFinite(t.turnsLeft) ? t.turnsLeft : null }))));
      else this.host.store.del(`taint:${this.channelKey}`);
    } catch (e) { this.log.warn("taint persist failed", { e: String(e) }); }
  }
  private loadCarriedTaint(): (TaintSource & { turnsLeft: number })[] {
    try {
      const raw = this.host.store.get(`taint:${this.channelKey}`);
      if (!raw) return [];
      return (JSON.parse(raw) as (TaintSource & { turnsLeft: number | null })[]).map((t) => ({ ...t, turnsLeft: t.turnsLeft ?? Number.POSITIVE_INFINITY }));
    } catch { return []; }
  }

  /** The request's own observed action (its tool_start, if already seen). */
  private ownEntry(ev: { tool: string; input: unknown }): ObservedAction | undefined {
    const all = this.turn?.trace ?? [];
    const h = inputHash(ev.input);
    return all.findLast((e) => e.ok === undefined && e.tool === ev.tool && inputHash(e.input) === h);
  }

  /** This turn's observed actions before this request (the request's own tool_start, if already seen, left out). */
  private traceBefore(ev: { tool: string; input: unknown }): ObservedAction[] {
    const all = this.turn?.trace ?? [];
    const h = inputHash(ev.input);
    const i = all.findLastIndex((e) => e.ok === undefined && e.tool === ev.tool && inputHash(e.input) === h);
    return i >= 0 ? [...all.slice(0, i), ...all.slice(i + 1)] : [...all];
  }

  /** Targets of the request with provenance; bounded in time (a slow filesystem or git must not hold the request). */
  private async targetsOf(ev: { tool: string; input: unknown }, cwd: string): Promise<TargetReport | undefined> {
    const work = describeTargets(ev.tool, ev.input, { cwd, scope: writeScope(this.profile.permissions, cwd), ledger: this.ledger,
      dialect: requestDialect(ev.tool, ev.input, this.capabilities.shellDialects) });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<undefined>((res) => { timer = setTimeout(() => res(undefined), TARGETS_BUDGET_MS); });
    try { return await Promise.race([work, late]); } catch (e) { this.log.warn("target provenance failed", { e: String(e) }); return undefined; } finally { clearTimeout(timer); }
  }

  private audit(rec: ApprovalAuditRecord | ApprovalDecisionRecord) {
    try { this.host.approvalAudit?.append(rec); } catch (e) { this.log.warn("approval audit append failed", { e: String(e) }); }
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

/** 1-based index of the provider's plain one-time allow option ("Yes" / "Allow", never "always" / "don't ask
 *  again" / session-wide); undefined when there are options but none is that. */
function onceOption(options: string[] | undefined): number | undefined {
  const i = options?.findIndex((o) => /^(yes|allow)\b/i.test(o.trim()) && !/always|don't ask|do not ask|allow all|session|switch to/i.test(o)) ?? -1;
  return i >= 0 ? i + 1 : undefined;
}

function truncate(s: string, n: number) { return s.length > n ? s.slice(0, n - 1) + "…" : s; }

/** Drop box-drawing rule lines, TUI tips and the trailing question from dialog text. */
export function cleanDialogText(s: string): string {
  return s.split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^[─━╌┄┈═\-_]{3,}$/.test(l) && !/^tip:/i.test(l) && !/^do you want to (proceed|make this edit|create)/i.test(l))
    .join("\n");
}
