// One UniQlaw session = one `claude` TUI process in a tmux session on the
// instance socket. Output comes from the session jsonl (segment granularity);
// dialogs, readiness and busy state come from pane snapshots.
import { randomUUID, createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type {
  AgentEvent, AgentSession, Liveness, Logger, PaneInspection, PermissionDecision, ProviderCapabilities, SessionRepair, TurnInput, UsageLimit,
} from "@uniqlaw/core";
import {
  claudeShellDialects,
  JsonlTailer, locateJsonl, expectedJsonlPath, classifyInternalOutput, isInterruptMarker,
  isRejectionText, isCrossSessionMessage, MCP_SERVER_NAME, type JsonlEvent,
} from "@uniqlaw/claude-common";
import { answerStartupPrompt, classifyBlocker, closeMcpDialog, reconnectMcp as driveMcpReconnect } from "./mcp.ts";
import type { Tmux } from "./tmux.ts";
import { AsyncQueue } from "./queue.ts";
import { hasReadyPrompt, isLoggedOut, parseLoginPrompt, parsePermissionDialog, type PermissionDialog } from "./dialogs.ts";
import { isReady, looksActivelyBusy, isRecoverableApiError, parseUsageLimit, describeUsageLimit, normalizePaneForLiveness, waitForReady, type UsageLimitInfo } from "./pane.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const CLAUDE_TMUX_CAPABILITIES: ProviderCapabilities = {
  // Bash tool: bash or zsh as Claude Code picks it; PowerShell tool: pwsh (approval judge normalizer).
  shellDialects: claudeShellDialects(),
  streaming: "segment",
  interrupt: true,
  steer: true,
  resume: "native",
  denyEndsTurn: true,
  modelSwitch: "live",
  permissionCallback: true,
  mcp: "per-session",
  nativeTools: false,
  attachments: ["image", "file"],
  slashCommands: true,
  toolPolicy: true,
  isolation: true,
};

export interface Timings {
  pollRunningMs: number;
  pollIdleMs: number;
  pasteSettleMs: number;
  tentativeEndMs: number;
  /** End a confirmed (non-tentative) turn after this long even if the pane heuristic still says busy. */
  endConfirmMaxMs: number;
  slashIdleMs: number;
  denyRecoveryMs: number;
  interruptFallbackMs: number;
  /** No liveness signal at all (no jsonl write, no pane change, not busy, no dialog) for this long, at an idle prompt:
   *  the turn ended without an end marker. */
  stallMs: number;
  /** No liveness signal at all for this long, whatever the pane shows. */
  stallMaxMs: number;
  /** Hard ceiling: end the turn after this long without a jsonl write even while the pane looks busy (a hung tool
   *  still ticks the spinner). 0 = leave it to core's turn.stallMaxSec, which interrupts the turn. */
  busyHardCapMs: number;
  /** An API error or usage-limit message at an idle prompt ends the turn once the jsonl has been quiet this long. */
  apiErrorQuietMs: number;
  modelEchoMs: number;
  dialogGonePolls: number;
  /** A dialog must stay gone this long before it is reported withdrawn (a redraw or resize can hide it briefly). */
  dialogWithdrawnMs: number;
}

export const DEFAULT_TIMINGS: Timings = {
  pollRunningMs: 500,
  pollIdleMs: 2000,
  pasteSettleMs: 250,
  tentativeEndMs: 1500,
  endConfirmMaxMs: 10_000,
  slashIdleMs: 2500,
  denyRecoveryMs: 4000,
  interruptFallbackMs: 6000,
  stallMs: 120_000,
  stallMaxMs: 600_000,
  busyHardCapMs: 0,
  apiErrorQuietMs: 5000,
  modelEchoMs: 5000,
  dialogGonePolls: 3,
  dialogWithdrawnMs: 3000,
};

type State = "starting" | "idle" | "running" | "dead";

export interface SessionInit {
  tmux: Tmux;
  name: string;
  providerSessionId: string;
  cwd: string;
  /** Env used to locate the jsonl (CLAUDE_CONFIG_DIR). */
  env: Record<string, string>;
  log: Logger;
  timings?: Partial<Timings>;
  /** Kill and restart claude with the current profile flags (--resume); used for a stale reattached process. */
  respawn?: () => Promise<void>;
  readyTimeoutMs?: number;
  /** Where detach() saves the jsonl read position; a reattach continues from it, so a reply written while the
   *  daemon was down is still emitted (as an unsolicited turn) instead of skipped. */
  tailStateFile?: string;
  /** The session's settings file (approval-judge hook, holds a token): deleted when the session closes for good
   *  (kept on detach: the live claude still uses it). */
  settingsFile?: string;
}

const fp = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 12);

export class ClaudeTmuxSession implements AgentSession {
  readonly capabilities = CLAUDE_TMUX_CAPABILITIES;
  readonly events = new AsyncQueue<AgentEvent>();
  readonly providerSessionId: string;

  private t: Timings;
  private tmux: Tmux;
  private name: string;
  private log: Logger;
  private tailer: JsonlTailer;
  private state: State = "starting";
  private staleLaunch = false;
  private respawning = false;
  /** MCP reconnect / repair in progress: the poller stands still and input waits (state "starting"). */
  private maintaining = false;
  /** Reattached to a claude that outlived the previous daemon. */
  reattached = false;
  private turnId = "";
  private turnSeq = 0;
  private closed = false;
  private poller: ReturnType<typeof setTimeout> | null = null;
  private readyWaiters: (() => void)[] = [];
  private idleWaiters: (() => void)[] = [];

  // turn-end bookkeeping
  private pendingEndAt = 0;
  private tentativeAt = 0;
  private slashTimer: ReturnType<typeof setTimeout> | null = null;
  private denyTimer: ReturnType<typeof setTimeout> | null = null;
  private interruptAt = 0;
  private turnStartedAt = 0;
  private lastActivityAt = 0;
  private stallAt = 0;
  /** The agent's text in the current turn (a usage-limit line it quotes is not Claude Code's notice). */
  private turnText = "";
  // liveness signals for the stall watchdogs (this one and core's, via liveness())
  private paneFp = "";
  private paneChangedAt = 0;
  private lastPane = "";
  private toolsInFlight = new Set<string>();

  // dialogs
  private activeDialog: { id: string; dialog: PermissionDialog } | null = null;
  private dialogMiss = 0;
  private dialogMissSince = 0;
  /** A dialog that left the pane without our answer: reported withdrawn once it stays gone for dialogWithdrawnMs;
   *  if the same request comes back first (redraw, resize), it is the same dialog again. */
  private goneDialog: { id: string; dialog: PermissionDialog; since: number } | null = null;
  private pendingSteers: TurnInput[] = [];

  // login
  private loginUrlSent: string | null = null;
  private loginTriggered = false;
  private loginInputId: string | null = null;

  // model switch
  private modelEcho: ((model?: string) => void) | null = null;
  private opChain: Promise<unknown> = Promise.resolve();
  private segSeq = 0;

  constructor(private init: SessionInit, startAt: "start" | "end") {
    this.t = { ...DEFAULT_TIMINGS, ...init.timings };
    this.tmux = init.tmux;
    this.name = init.name;
    this.log = init.log;
    this.providerSessionId = init.providerSessionId;
    const expected = expectedJsonlPath(init.providerSessionId, init.cwd, init.env);
    this.tailer = new JsonlTailer({
      locate: () => (Bun.file(expected).size > 0 || require("node:fs").existsSync(expected) ? expected : locateJsonl(init.providerSessionId, init.env)),
      startAt,
      onEvent: (ev) => this.onJsonl(ev),
      onError: (e) => this.log.warn("jsonl tail error", { err: String(e) }),
    });
  }

  // ───────────────────────── lifecycle ─────────────────────────

  /** Called by the provider after spawn/reattach. */
  private rootPid?: number;
  /** claude's pid in the pane: every Bash command this session runs descends from it. */
  processRoot(): number | undefined { return this.rootPid; }

  async start(o: { reattach: boolean; readyTimeoutMs?: number; staleLaunch?: boolean }): Promise<void> {
    this.emit({ type: "session", providerSessionId: this.providerSessionId });
    void (this.init.tmux.panePid?.(this.name) ?? Promise.resolve(undefined)).then((p) => { this.rootPid = p; }).catch(() => {});
    this.reattached = o.reattach;
    if (o.reattach) {
      this.staleLaunch = !!o.staleLaunch && !!this.init.respawn;
      const saved = this.takeTailState();
      if (saved) this.tailer.resumeFrom(saved);
      const pane = await this.tmux.capture(this.name).catch(() => "");
      if (looksActivelyBusy(pane)) {
        this.state = "running";
        this.beginTurn(true);
      } else if (isReady(pane)) {
        this.setIdle();
      }
      // Only now: output written while the daemon was down starts a turn of its own (idle) or joins the running one.
      this.tailer.start();
      // Otherwise (e.g. sitting on a permission dialog: neither busy nor ready) the first poll classifies it.
    } else {
      // Respawned with --resume after claude exited while the daemon was down: same session id, same jsonl. Continue
      // from the saved position once it is ready (idle), so a reply written before it exited still comes out.
      const saved = this.takeTailState();
      if (saved) this.tailer.resumeFrom(saved);
      else this.tailer.start();
      const r = await waitForReady(this.tmux, this.name, {
        timeoutMs: o.readyTimeoutMs,
        onPrompt: (label) => this.log.info(`startup prompt handled: ${label}`),
        isLoginPane: (p) => !!parseLoginPrompt(p) || isLoggedOut(p) || parsePermissionDialog(p)?.kind === "login",
      });
      if (r.status === "dead" || r.status === "timeout") {
        this.state = "dead";
        this.stopAll();
        throw new Error(`claude did not become ready (${r.status}). Last pane:\n${r.pane.split("\n").slice(-25).join("\n")}`);
      }
      if (r.status === "ready") this.setIdle();
      else this.log.warn("claude needs login; waiting for operator");
      if (saved) this.tailer.start();
    }
    this.schedulePoll(0);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.stopAll();
    await this.tmux.killSession(this.name).catch(() => {});
    if (this.init.settingsFile) rmSync(this.init.settingsFile, { force: true });
    this.state = "dead";
    this.events.end();
  }

  /** Stop watchers but leave tmux running (used when the daemon shuts down for restart). */
  detach() {
    this.closed = true;
    this.stopAll();
    const pos = this.tailer.position();
    if (pos && this.init.tailStateFile) {
      try { writeFileSync(this.init.tailStateFile, JSON.stringify(pos)); } catch (e) { this.log.warn("could not save jsonl position", { e: String(e) }); }
    }
    this.events.end();
  }

  private takeTailState(): { path: string; pos: number } | undefined {
    const f = this.init.tailStateFile;
    if (!f || !existsSync(f)) return undefined;
    try { return JSON.parse(readFileSync(f, "utf8")) as { path: string; pos: number }; }
    catch { return undefined; }
    finally { try { rmSync(f); } catch {} }
  }

  async alive(): Promise<boolean> {
    if (this.closed) return false;
    return (await this.tmux.hasSession(this.name)) && !(await this.tmux.paneDead(this.name));
  }

  // ───────────────────────── health / recovery (docs §11.4) ─────────────────────────

  async inspect(): Promise<PaneInspection> {
    const info = await this.tmux.paneInfo(this.name).catch(() => undefined);
    if (!info) return { process: "absent" };
    if (info.dead) return { process: "dead", ...(info.status !== undefined ? { exitStatus: info.status } : {}), cwd: this.init.cwd };
    const pane = await this.tmux.capture(this.name).catch(() => "");
    const blocker = classifyBlocker(pane);
    return { process: "alive", ...(blocker ? { blocker } : {}), cwd: this.init.cwd,
      idle: this.state === "idle" && !this.activeDialog && !blocker && isReady(pane) && !looksActivelyBusy(pane) };
  }

  /** Hold input (state "starting", poller paused) while `fn` drives the pane; afterwards pick up whatever the pane
   *  shows (a turn that started meanwhile is tracked, not lost). */
  private async maintain<T>(fn: () => Promise<T>): Promise<T> {
    this.maintaining = true;
    this.state = "starting";
    try { return await fn(); }
    finally {
      // Read what the repair wrote to the transcript (`/mcp` output) while still "starting": it is ignored there,
      // whereas in the turn a queued input starts next it would be taken for that turn's command output.
      await sleep(300);
      this.tailer.flush();
      this.maintaining = false;
      if (!this.closed && this.state === "starting") {
        const pane = await this.tmux.capture(this.name).catch(() => "");
        if (looksActivelyBusy(pane)) { this.state = "running"; this.beginTurn(true); }
        else this.setIdle();
      }
    }
  }

  private canMaintain(): string | undefined {
    if (this.closed || this.state === "dead") return "session closed";
    if (this.respawning || this.maintaining) return "already busy with a repair";
    if (this.state !== "idle") return `session is ${this.state}`;
    if (this.activeDialog) return "a dialog is open";
    if (this.pendingSteers.length) return "input is waiting";
    return undefined;
  }

  async reconnectMcp(verify: (since: number) => boolean, signal?: AbortSignal): Promise<{ ok: boolean; outcome: string; detail: string }> {
    const no = this.canMaintain();
    if (no) return { ok: false, outcome: "skipped", detail: no };
    return this.maintain(async () => {
      const r = await driveMcpReconnect({ tmux: this.tmux, name: this.name, server: MCP_SERVER_NAME, verify, ...(signal ? { signal } : {}),
        log: (msg, extra) => this.log.warn(msg, extra) });
      this.log.info("mcp reconnect", { outcome: r.outcome, detail: r.detail });
      return r;
    });
  }

  async respawn(): Promise<boolean> {
    if (!this.init.respawn || this.canMaintain()) return false;
    await this.respawnStale();
    return this.state === "idle";
  }

  async repair(action: SessionRepair): Promise<string | undefined> {
    if (this.closed || this.respawning || this.maintaining) return undefined;
    // A startup prompt only shows before claude takes input (state "starting"); a leftover dialog may sit anywhere
    // but in a running turn.
    if (this.state === "running") return undefined;
    const run = async () => {
      if (action === "answer-startup-prompt") return answerStartupPrompt(this.tmux, this.name);
      return (await closeMcpDialog(this.tmux, this.name)) ? "mcp-dialog" : undefined;
    };
    const was = this.state;
    if (was === "starting") {
      // Not taking input yet: nothing to hold; let the poller see the result (ready → idle).
      this.maintaining = true;
      try { return await run(); } finally { this.maintaining = false; }
    }
    return this.maintain(run);
  }

  private stopAll() {
    this.tailer.stop();
    if (this.poller) clearTimeout(this.poller);
    this.poller = null;
    this.clearTimer("slashTimer");
    this.clearTimer("denyTimer");
  }

  // ───────────────────────── input ─────────────────────────

  async send(input: TurnInput): Promise<void> {
    await this.waitReady();
    if (this.state === "running") {
      // Turn just started on its own (unsolicited) or caller raced: deliver as steer.
      return this.steer(input);
    }
    this.state = "running";
    this.beginTurn(false);
    await this.typeInput(input);
    if (input.slashCommand || input.text.trimStart().startsWith("/")) this.armSlashIdle();
  }

  async steer(input: TurnInput): Promise<void> {
    await this.waitReady();
    if (this.state === "idle") return this.send(input);
    if (this.activeDialog) {
      // Typing now would answer the dialog. Hold until it resolves.
      this.pendingSteers.push(input);
      return;
    }
    await this.typeInput(input);
  }

  async interrupt(): Promise<void> {
    if (this.state !== "running") return;
    this.interruptAt = Date.now();
    await this.tmux.sendKeys(this.name, "Escape");
    if (this.activeDialog) { this.activeDialog = null; }
  }

  async setModel(model: string): Promise<void> {
    return this.serial(async () => {
      await this.waitIdle();
      const echo = new Promise<string | undefined>((resolve) => {
        this.modelEcho = resolve;
        setTimeout(() => resolve(undefined), this.t.modelEchoMs);
      });
      await this.tmux.paste(this.name, `/model ${model}`);
      await sleep(this.t.pasteSettleMs);
      await this.tmux.sendKeys(this.name, "Enter");
      const got = await echo;
      this.modelEcho = null;
      this.emit({ type: "model", model: got ?? model });
    });
  }

  async respondPermission(id: string, decision: PermissionDecision, optionIndex?: number): Promise<void> {
    // A dialog briefly off the pane (redraw) is still the one being answered.
    const cur = this.activeDialog ?? (this.goneDialog?.id === id ? this.goneDialog : null);
    this.goneDialog = null;
    if (!cur || cur.id !== id) {
      this.log.warn("respondPermission for a dialog that is no longer open", { id });
      return;
    }
    const d = cur.dialog;
    let idx = optionIndex;
    if (idx === undefined) {
      if (decision.behavior === "allow") {
        const always = d.options.findIndex((o) => /always allow|don't ask again|allow all/i.test(o));
        idx = decision.scope === "session" && always >= 0 ? always + 1 : 1;
      } else {
        const no = d.options.findIndex((o) => /^No\b/i.test(o));
        idx = no >= 0 ? no + 1 : -1;
      }
    }
    this.activeDialog = null;
    if (idx < 1) { await this.tmux.sendKeys(this.name, "Escape"); }
    else await this.selectOption(d, idx);
    if (decision.behavior === "deny") this.armDenyRecovery();
    await this.flushSteers();
  }

  async respondInput(id: string, value: string): Promise<void> {
    if (id !== this.loginInputId) { this.log.warn("respondInput: unknown input id", { id }); return; }
    await this.tmux.paste(this.name, value.trim());
    await sleep(150);
    await this.tmux.sendKeys(this.name, "Enter");
    this.loginInputId = null;
    this.loginUrlSent = null;
    this.loginTriggered = false;
  }

  // ───────────────────────── internals: typing ─────────────────────────

  private async typeInput(input: TurnInput) {
    let text = input.text;
    if (input.attachments.length) {
      const lines = input.attachments.map((a) => `[Attached ${a.kind}${a.name ? ` "${a.name}"` : ""}: ${a.path}]`);
      text = `${lines.join("\n")}\n\n${text}`;
    }
    await this.tmux.paste(this.name, text);
    await sleep(this.t.pasteSettleMs);
    await this.tmux.sendKeys(this.name, "Enter");
    this.lastActivityAt = Date.now();
  }

  private async selectOption(d: PermissionDialog, index: number) {
    if (d.keypressMap?.[index]) { await this.tmux.sendKeys(this.name, d.keypressMap[index]); return; }
    for (let i = 0; i < index - 1; i++) { await this.tmux.sendKeys(this.name, "Down"); await sleep(60); }
    await this.tmux.sendKeys(this.name, "Enter");
  }

  private async flushSteers() {
    const items = this.pendingSteers.splice(0);
    for (const s of items) await this.steer(s);
  }

  // ───────────────────────── internals: turn tracking ─────────────────────────

  private beginTurn(unsolicited: boolean, source?: "background" | "external") {
    this.turnId = `t${++this.turnSeq}`;
    this.turnStartedAt = Date.now();
    this.lastActivityAt = Date.now();
    this.stallAt = Date.now();
    this.paneChangedAt = Date.now();
    this.toolsInFlight.clear();
    this.turnText = "";
    this.pendingEndAt = 0;
    this.tentativeAt = 0;
    this.interruptAt = 0;
    if (unsolicited) this.emit(source ? { type: "unsolicited_turn", source } : { type: "unsolicited_turn" });
    this.emit({ type: "turn_start", turnId: this.turnId });
  }

  /** Restart a reattached claude whose launch flags no longer match the profile; input waits (waitReady) meanwhile. */
  private async respawnStale() {
    this.state = "starting";
    this.respawning = true;
    try {
      await this.init.respawn!();
      const r = await waitForReady(this.tmux, this.name, { timeoutMs: this.init.readyTimeoutMs,
        onPrompt: (label) => this.log.info(`startup prompt handled: ${label}`) });
      if (r.status !== "ready") this.log.warn("respawned claude is not ready yet", { status: r.status });
      else this.setIdle();
    } catch (e) {
      this.log.error("respawn failed", { e: String(e) });
      this.onDead(`respawn failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.respawning = false;
    }
  }

  private endOnUsageLimit(l: UsageLimitInfo, from: "pane" | "jsonl") {
    this.log.warn("usage limit reached; ending the turn", { from, kind: l.kind, resets: l.resets,
      resetAt: l.resetAt !== undefined ? new Date(l.resetAt).toISOString() : undefined, line: l.line });
    this.endTurn("error", "usage_limit", { kind: l.kind, ...(l.resets ? { resets: l.resets } : {}), ...(l.resetAt !== undefined ? { resetAt: l.resetAt } : {}) });
  }

  private endTurn(reason: "done" | "interrupted" | "error", error?: string, limit?: UsageLimit) {
    if (this.state !== "running") return;
    this.clearTimer("slashTimer");
    this.clearTimer("denyTimer");
    this.pendingEndAt = 0;
    this.tentativeAt = 0;
    this.interruptAt = 0;
    this.activeDialog = null;
    this.emit({ type: "turn_end", turnId: this.turnId, reason, ...(error ? { error } : {}), ...(limit ? { limit } : {}) });
    this.setIdle();
  }

  private setIdle() {
    if (this.staleLaunch && !this.closed && !this.pendingSteers.length) {
      this.staleLaunch = false;
      void this.respawnStale();
      return;
    }
    this.state = "idle";
    for (const w of this.readyWaiters.splice(0)) w();
    for (const w of this.idleWaiters.splice(0)) w();
    void this.flushSteers();
  }

  private onJsonl(ev: JsonlEvent) {
    this.lastActivityAt = Date.now();
    this.stallAt = Date.now();
    // Claude Code records an API failure as a synthetic assistant message (isApiErrorMessage). A usage limit there
    // ends the turn; it is not the agent's reply.
    if (ev.type === "assistant-text" && ev.raw?.isApiErrorMessage === true && ev.text && parseUsageLimit(ev.text)) {
      if (this.state === "running") this.endOnUsageLimit(describeUsageLimit(ev.text), "jsonl");
      return;
    }
    const assistant = ev.type === "assistant-text" || ev.type === "assistant-tool-use" || ev.type === "assistant-thinking";
    if (assistant) {
      this.clearTimer("slashTimer");
      this.clearTimer("denyTimer");
      this.pendingEndAt = 0;
      this.tentativeAt = 0;
      if (this.state === "idle") { this.state = "running"; this.beginTurn(true); }
      if (ev.model) { /* model is reported via setModel / echo; jsonl model kept for diagnostics */ }
    }
    const seg = () => `${ev.msgId ?? ev.uuid ?? "seg"}:${ev.blockIndex ?? this.segSeq++}`;
    switch (ev.type) {
      case "assistant-text":
        if (this.state === "running" && ev.text) this.turnText += `${ev.text}\n`;
        if (ev.text?.trim()) this.emit({ type: "text", segmentId: seg(), final: ev.text });
        break;
      case "assistant-thinking":
        if (ev.text?.trim()) this.emit({ type: "thinking", segmentId: seg(), text: ev.text });
        break;
      case "assistant-tool-use":
        if (ev.toolUseId) this.toolsInFlight.add(ev.toolUseId);
        this.emit({ type: "tool_start", id: ev.toolUseId ?? seg(), name: ev.toolName ?? "?", input: ev.toolInput });
        break;
      case "user-tool-result":
        if (ev.toolUseId) this.toolsInFlight.delete(ev.toolUseId);
        this.emit({ type: "tool_end", id: ev.toolUseId ?? "?", ok: !ev.toolResultIsError, summary: ev.toolResult?.slice(0, 500) });
        if (ev.toolResultIsError && isRejectionText(ev.toolResult ?? "")) this.armDenyRecovery();
        break;
      case "user-message": {
        const text = ev.userText ?? "";
        if (isInterruptMarker(text)) { this.endTurn("interrupted"); break; }
        if (isRejectionText(text)) { this.endTurn("interrupted"); break; }
        if (isCrossSessionMessage(text)) {
          // Native Claude peer messaging bypasses the UniQlaw bus (no Origin). Flag the turn so
          // core routes its output to operators only (docs §5.2 messaging-socket risk).
          this.log.warn("native cross-session message received; flagging turn as external");
          if (this.state === "idle") { this.state = "running"; this.beginTurn(true, "external"); }
          else this.emit({ type: "unsolicited_turn", source: "external" });
          break;
        }
        const cls = classifyInternalOutput(text);
        if (cls.kind === "model-switch") {
          if (this.modelEcho) this.modelEcho(cls.model);
          else {
            if (cls.model) this.emit({ type: "model", model: cls.model });
            if (this.state === "running" && !this.hasAssistantSinceStart()) this.endTurn("done");
          }
        } else if (cls.kind === "context-report" || cls.kind === "command-stdout") {
          if (this.state === "running") {
            if (cls.forward) this.emit({ type: "text", segmentId: `cmd:${this.turnId}`, final: cls.forward });
            this.endTurn("done");
          }
        }
        break;
      }
      case "turn-end":
        if (this.state !== "running") break;
        if (ev.tentative) this.tentativeAt = Date.now();
        else this.pendingEndAt = Date.now();
        break;
      case "stop-hook-summary":
        if (this.state === "running" && !this.pendingEndAt) this.pendingEndAt = Date.now();
        break;
    }
  }

  private assistantSeenAt = 0;
  private hasAssistantSinceStart() { return this.assistantSeenAt > this.turnStartedAt; }

  private armSlashIdle() {
    this.clearTimer("slashTimer");
    this.slashTimer = setTimeout(async () => {
      this.slashTimer = null;
      if (this.state !== "running" || this.activeDialog) return;
      const pane = await this.tmux.capture(this.name).catch(() => "");
      if (!looksActivelyBusy(pane) && isReady(pane)) this.endTurn("done");
      else this.armSlashIdle();
    }, this.t.slashIdleMs);
  }

  private armDenyRecovery() {
    this.clearTimer("denyTimer");
    this.denyTimer = setTimeout(async () => {
      this.denyTimer = null;
      if (this.state !== "running") return;
      const pane = await this.tmux.capture(this.name).catch(() => "");
      if (!looksActivelyBusy(pane)) this.endTurn("interrupted");
    }, this.t.denyRecoveryMs);
  }

  private clearTimer(k: "slashTimer" | "denyTimer") {
    const t = this[k];
    if (t) clearTimeout(t);
    this[k] = null;
  }

  // ───────────────────────── pane poller ─────────────────────────

  private schedulePoll(ms: number) {
    if (this.closed) return;
    this.poller = setTimeout(() => void this.poll().finally(() => {
      this.schedulePoll(this.state === "running" || this.state === "starting" ? this.t.pollRunningMs : this.t.pollIdleMs);
    }), ms);
  }

  private async poll() {
    if (this.closed || this.respawning || this.maintaining) return;
    let pane: string;
    try { pane = await this.tmux.capture(this.name); }
    catch {
      if (!(await this.tmux.hasSession(this.name))) this.onDead("tmux session disappeared");
      return;
    }
    if (await this.tmux.paneDead(this.name)) { this.onDead("claude process exited"); return; }
    this.tailer.flush();
    this.lastPane = pane;
    const pfp = fp(normalizePaneForLiveness(pane));
    if (pfp !== this.paneFp) { this.paneFp = pfp; this.paneChangedAt = Date.now(); }

    // Login flow runs in any state.
    if (await this.checkLogin(pane)) return;

    if (this.state === "starting") {
      if (isReady(pane)) { this.setIdle(); return; }
      // A reattached pane may sit on a dialog (it opened while the daemon was down): surface it now,
      // or nobody answers it and the turn stalls.
      const d = parsePermissionDialog(pane);
      if (!d || d.kind === "login") return;
    }

    await this.checkDialogs(pane);

    if (this.state !== "running") return;
    const now = Date.now();
    const busy = looksActivelyBusy(pane);
    const ready = isReady(pane);

    // Confirmed end_turn / stop hook: wait for an idle pane (or give up waiting on the heuristic).
    if (this.pendingEndAt && !this.activeDialog) {
      if ((!busy && ready) || now - Math.max(this.pendingEndAt, this.lastActivityAt) > this.t.endConfirmMaxMs) {
        this.endTurn("done");
        return;
      }
    }
    // Tentative (thinking-only) end: only close it if the pane is quiet.
    if (this.tentativeAt && !this.pendingEndAt && now - this.tentativeAt > this.t.tentativeEndMs && !busy && ready && !this.activeDialog) {
      this.endTurn("done");
      return;
    }
    // Interrupt sent but no marker in the jsonl.
    if (this.interruptAt && now - this.interruptAt > this.t.interruptFallbackMs && !busy && ready) {
      this.endTurn("interrupted");
      return;
    }
    // Transient API errors / usage limit: Claude gives up and returns to the prompt without end_turn.
    if (!busy && ready && now - this.lastActivityAt > this.t.apiErrorQuietMs) {
      if (isRecoverableApiError(pane)) { this.endTurn("error", "rate_limit"); return; }
      const limit = parseUsageLimit(pane, now);
      // The agent's own reply may quote such a message (e.g. while discussing one): that is not Claude Code's notice.
      if (limit && !this.turnText.includes(limit.line.slice(0, 60))) { this.endOnUsageLimit(limit, "pane"); return; }
    }
    // Stall watchdog: only when there is no liveness signal at all. A long tool call (CI wait, a long test run) writes
    // nothing to the jsonl, but the pane shows it busy or changing, so it is not a stall.
    const live = this.livenessSignals(now, pane, busy, ready);
    if (live.jsonlQuietMs <= this.t.stallMs) return;
    const alive = busy || !!this.activeDialog || live.paneQuietMs < this.t.stallMs || (this.toolsInFlight.size > 0 && !ready);
    const capped = this.t.busyHardCapMs > 0 && live.jsonlQuietMs >= this.t.busyHardCapMs;
    if (alive && !capped) return;
    if (capped || ready || live.jsonlQuietMs > this.t.stallMaxMs) {
      this.log.warn(capped ? "stall: hard ceiling (busyHardCapMs) without jsonl activity; recovering" : "stall: no liveness signal; recovering",
        { ...live, alive, stallMs: this.t.stallMs, stallMaxMs: this.t.stallMaxMs, busyHardCapMs: this.t.busyHardCapMs,
          pane: pane.split("\n").slice(-15).join("\n") });
      this.endTurn("error", "stall");
    }
  }

  private livenessSignals(now: number, pane: string, busy = looksActivelyBusy(pane), ready = isReady(pane)) {
    const jsonlAt = Math.max(this.stallAt, this.tailer.lastActivityAt);
    return { jsonlQuietMs: now - jsonlAt, paneQuietMs: now - this.paneChangedAt, paneBusy: busy, ready,
      dialog: !!this.activeDialog, toolsInFlight: this.toolsInFlight.size, jsonlAt, paneChangedAt: this.paneChangedAt };
  }

  /** What core's stall watchdog checks before abandoning a quiet turn (see AgentSession.liveness). */
  async liveness(): Promise<Liveness> {
    const now = Date.now();
    const l = this.livenessSignals(now, this.lastPane);
    const { jsonlAt, paneChangedAt, ...signals } = l;
    return { busy: l.paneBusy || l.dialog || (l.toolsInFlight > 0 && !l.ready), lastActivityAt: Math.max(jsonlAt, paneChangedAt),
      signals: { ...signals, state: this.state } };
  }

  private async checkDialogs(pane: string) {
    const d = parsePermissionDialog(pane);
    if (!d) {
      if (this.activeDialog && this.dialogMiss++ === 0) this.dialogMissSince = Date.now();
      if (this.activeDialog && this.dialogMiss >= this.t.dialogGonePolls) {
        this.goneDialog = { ...this.activeDialog, since: this.dialogMissSince };
        this.activeDialog = null;
        await this.flushSteers();
      }
      // Gone without our answer for long enough (answered in the terminal, or the request went away): core
      // cancels its prompt.
      if (this.goneDialog && Date.now() - this.goneDialog.since >= this.t.dialogWithdrawnMs) {
        this.emit({ type: "permission_withdrawn", id: this.goneDialog.id });
        this.goneDialog = null;
      }
      return;
    }
    this.dialogMiss = 0;
    if (d.kind === "login") return; // handled by checkLogin
    if (d.kind === "survey") {
      const dismiss = Object.entries(d.keypressMap ?? {}).find(([i]) => /dismiss/i.test(d.options[Number(i) - 1] ?? ""));
      await this.tmux.sendKeys(this.name, dismiss?.[1] ?? "0");
      return;
    }
    if (d.kind === "model-switch") {
      // System decision, never the operator's — confirm (cursor is on "Yes").
      if (this.activeDialog?.id === d.fingerprint) return;
      this.activeDialog = { id: d.fingerprint, dialog: d };
      this.clearTimer("slashTimer");
      await this.tmux.sendKeys(this.name, "Enter");
      this.activeDialog = null;
      if (this.state === "running" && !this.modelEcho) this.armSlashIdle();
      return;
    }
    if (this.activeDialog?.id === d.fingerprint) return;
    // The same request redrawn (resize, wrapping, rotating hints): keep its id, core's prompt still answers it.
    const prev = this.activeDialog ?? this.goneDialog;
    if (prev && (prev.id === d.fingerprint || sameRequest(prev.dialog, d))) {
      this.activeDialog = { id: prev.id, dialog: d };
      this.goneDialog = null;
      return;
    }
    // A different dialog replaced the one still waiting for us: that one was settled elsewhere.
    if (prev) this.emit({ type: "permission_withdrawn", id: prev.id });
    this.goneDialog = null;
    if (this.state !== "running") { this.state = "running"; this.beginTurn(true); }
    this.activeDialog = { id: d.fingerprint, dialog: d };
    this.clearTimer("slashTimer");
    this.clearTimer("denyTimer");
    this.emit({
      type: "permission_request",
      id: d.fingerprint,
      tool: guessTool(d.question),
      input: d.question,
      title: dialogTitle(d),
      kind: d.kind === "question" ? "question" : "permission",
      options: d.options,
    });
  }

  /** Returns true when the pane is in a login state (other checks skipped). */
  private async checkLogin(pane: string): Promise<boolean> {
    if (hasReadyPrompt(pane)) {
      this.loginTriggered = false;
      if (this.loginInputId) { this.loginInputId = null; this.loginUrlSent = null; }
      return false;
    }
    const login = parseLoginPrompt(pane);
    if (login) {
      if (this.loginUrlSent !== login.url) {
        this.loginUrlSent = login.url;
        this.loginInputId = `login:${fp(login.url)}`;
        this.emit({ type: "input_request", id: this.loginInputId, kind: "login", url: login.url,
          title: "Claude Code needs to log in. Open the URL, authorize, and reply with the code." });
      }
      return true;
    }
    const d = parsePermissionDialog(pane);
    if (d?.kind === "login") { await this.tmux.sendKeys(this.name, "Enter"); return true; }
    if (isLoggedOut(pane)) {
      if (!this.loginTriggered) {
        this.loginTriggered = true;
        this.log.warn("session logged out — running /login");
        await this.tmux.paste(this.name, "/login");
        await sleep(150);
        await this.tmux.sendKeys(this.name, "Enter");
      }
      return true;
    }
    return false;
  }

  private onDead(reason: string) {
    if (this.closed || this.state === "dead") return;
    this.log.error(reason);
    if (this.state === "running") this.emit({ type: "turn_end", turnId: this.turnId, reason: "error", error: reason });
    this.state = "dead";
    this.emit({ type: "error", error: reason, fatal: true });
    this.stopAll();
    this.closed = true;
    this.events.end();
  }

  // ───────────────────────── helpers ─────────────────────────

  private emit(ev: AgentEvent) {
    if (ev.type === "text" || ev.type === "tool_start" || ev.type === "thinking") this.assistantSeenAt = Date.now();
    this.events.push(ev);
  }

  private waitReady(): Promise<void> {
    if (this.state === "dead") return Promise.reject(new Error("session is dead"));
    if (this.state !== "starting") return Promise.resolve();
    return new Promise((r) => this.readyWaiters.push(r));
  }

  private waitIdle(): Promise<void> {
    if (this.state === "idle") return Promise.resolve();
    if (this.state === "dead") return Promise.reject(new Error("session is dead"));
    return new Promise((r) => this.idleWaiters.push(r));
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.opChain.then(fn, fn);
    this.opChain = p.catch(() => {});
    return p;
  }
}

function guessTool(question: string): string {
  const q = question.toLowerCase();
  if (/bash command|run this command|shell/.test(q)) return "Bash";
  if (/\bedit\b|make this edit/.test(q)) return "Edit";
  if (/create|write/.test(q)) return "Write";
  if (/fetch|url|web/.test(q)) return "WebFetch";
  const m = question.match(/\b(mcp__[\w-]+)/);
  return m ? m[1] : "unknown";
}

function dialogTitle(d: PermissionDialog): string {
  const lines = d.question.split("\n").map((l) => l.trim()).filter((l) => l && !/^Tip:/i.test(l));
  return lines.slice(-6).join("\n").slice(0, 600) || "Permission requested";
}

export function newProviderSessionId(): string { return randomUUID(); }

/** Same tool and same request text (whitespace and rotating `Tip:` lines ignored): a redraw, not a new dialog. */
function sameRequest(a: PermissionDialog, b: PermissionDialog): boolean {
  const norm = (q: string) => q.split("\n").filter((l) => !/^\s*Tip:/i.test(l)).join("").replace(/\s+/g, "");
  return a.kind === b.kind && guessTool(a.question) === guessTool(b.question) && norm(a.question) === norm(b.question);
}
