// One UniQlaw session = one `opencode serve` + one opencode session. Maps raw SSE
// events onto AgentEvent and tracks turns (busy → first idle; stale idles dropped).
import { dialectOfShell, type AgentEvent, type AgentSession, type Logger, type PermissionDecision, type ProviderCapabilities, type TurnInput, type Usage } from "@uniqlaw/core";
import { AsyncQueue } from "./queue.ts";
import type { OpencodeServer, RawEvent } from "./server.ts";
import { errorCode, parseModel } from "./mapping.ts";

export const OPENCODE_CAPABILITIES: ProviderCapabilities = {
  // The bash tool runs in $SHELL (opencode's `shell` config can override it), falling back to /bin/bash.
  shellDialects: { bash: dialectOfShell(process.env.SHELL) === "unknown" ? "bash" : dialectOfShell(process.env.SHELL) },
  streaming: "token",
  interrupt: true,
  steer: true,            // prompt_async while busy → admitted at the next step boundary (M0 S4)
  resume: "native",       // session ids persist in XDG_DATA_HOME across serve restarts
  denyEndsTurn: false,    // rejected permission = tool error, turn continues
  modelSwitch: "live",    // model is per message
  permissionCallback: true,
  mcp: "per-process",     // MCP is instance-wide → one serve per session
  nativeTools: false,
  attachments: ["image", "file"],
  slashCommands: true,
};

const NO_BUSY_TIMEOUT_MS = 90_000;

export class OpencodeSession implements AgentSession {
  readonly capabilities = OPENCODE_CAPABILITIES;
  readonly events = new AsyncQueue<AgentEvent>();
  id = "";
  private state: "idle" | "running" = "idle";
  private turnSeq = 0;
  private turnId = "";
  private turnStartedAt = 0;
  private awaitingBusy = false;
  private errorBeforeBusy = false;
  private interrupting = false;
  private lastError: unknown;
  private closing = false;
  private noBusyTimer?: ReturnType<typeof setTimeout>;
  private msgRole = new Map<string, string>();
  private msgCreated = new Map<string, number>();
  private partType = new Map<string, string>();
  private partMsg = new Map<string, string>();
  private finalSent = new Set<string>();
  private toolStarted = new Set<string>();
  private toolEnded = new Set<string>();
  private permsSeen = new Set<string>();
  private usageByMsg = new Map<string, Usage>();
  private lastInterruptedEndAt = 0;

  constructor(private server: OpencodeServer, private log: Logger, private o: { model?: string; system?: string }) {
    server.on((e) => this.onRaw(e));
  }

  emit(ev: AgentEvent) { this.events.push(ev); }

  // ── input ────────────────────────────────────────────────────────────────

  private parts(input: TurnInput) {
    const parts: Record<string, unknown>[] = [{ type: "text", text: input.text }];
    for (const a of input.attachments) {
      parts.push({ type: "file", mime: a.mime ?? (a.kind === "image" ? "image/png" : "application/octet-stream"), url: `file://${a.path}`, filename: a.name ?? a.path.split("/").pop() });
    }
    return parts;
  }

  private body(input: TurnInput) {
    const b: Record<string, unknown> = { parts: this.parts(input) };
    const m = parseModel(this.o.model);
    if (m) b.model = m;
    if (this.o.system) b.system = this.o.system;
    return b;
  }

  async send(input: TurnInput): Promise<void> {
    if (this.state === "running") return this.steer(input);
    this.beginTurn(false);
    try {
      if (input.slashCommand || /^\/[a-zA-Z][\w:-]*(\s|$)/.test(input.text.trim())) {
        const t = input.text.trim().slice(1);
        const sp = t.search(/\s/);
        const command = sp < 0 ? t : t.slice(0, sp);
        const args = sp < 0 ? "" : t.slice(sp + 1).trim();
        await this.server.api("POST", `/session/${this.id}/command`, { command, arguments: args, ...(this.o.model ? { model: this.o.model } : {}) });
      } else {
        await this.server.api("POST", `/session/${this.id}/prompt_async`, this.body(input));
      }
    } catch (e) {
      this.log.error("send failed", { e: String(e) });
      this.endTurn("error", String(e).slice(0, 300));
    }
  }

  async steer(input: TurnInput): Promise<void> {
    if (this.state === "idle") return this.send(input);
    await this.server.api("POST", `/session/${this.id}/prompt_async`, this.body(input));
  }

  async interrupt(): Promise<void> {
    if (this.state !== "running") return;
    this.interrupting = true;
    await this.server.api("POST", `/session/${this.id}/abort`).catch((e) => this.log.warn("abort failed", { e: String(e) }));
  }

  async setModel(model: string): Promise<void> {
    this.o.model = model;
    this.emit({ type: "model", model });
  }

  async respondPermission(id: string, d: PermissionDecision): Promise<void> {
    const reply = d.behavior === "allow" ? (d.scope === "session" ? "always" : "once") : "reject";
    await this.server.api("POST", `/permission/${id}/reply`, { reply });
  }

  async respondInput(id: string, value: string): Promise<void> {
    await this.server.api("POST", `/question/${id}/reply`, { answers: [[value]] });
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    clearTimeout(this.noBusyTimer);
    await this.server.stop();
    this.events.close();
  }

  async alive() { return this.server.alive(); }

  // ── turn tracking ────────────────────────────────────────────────────────

  private beginTurn(unsolicited: boolean) {
    this.state = "running";
    this.turnId = `t${++this.turnSeq}`;
    this.turnStartedAt = Date.now();
    this.awaitingBusy = !unsolicited;
    this.errorBeforeBusy = false;
    this.interrupting = false;
    this.lastError = undefined;
    if (unsolicited) this.emit({ type: "unsolicited_turn" });
    this.emit({ type: "turn_start", turnId: this.turnId });
    clearTimeout(this.noBusyTimer);
    if (!unsolicited) {
      this.noBusyTimer = setTimeout(() => {
        if (this.state === "running" && this.awaitingBusy) this.endTurn("error", "opencode did not start the turn");
      }, NO_BUSY_TIMEOUT_MS);
    }
  }

  private endTurn(reason: "done" | "interrupted" | "error", error?: string) {
    if (this.state !== "running") return;
    clearTimeout(this.noBusyTimer);
    const usage = this.turnUsage();
    if (reason === "interrupted") this.lastInterruptedEndAt = Date.now();
    this.state = "idle";
    this.awaitingBusy = false;
    this.emit({ type: "turn_end", turnId: this.turnId, reason, ...(usage ? { usage } : {}), ...(error ? { error } : {}) });
  }

  private turnUsage(): Usage | undefined {
    let input = 0, output = 0, cost = 0, any = false;
    for (const [mid, u] of this.usageByMsg) {
      if ((this.msgCreated.get(mid) ?? 0) < this.turnStartedAt - 1000) continue;
      any = true; input += u.inputTokens ?? 0; output += u.outputTokens ?? 0; cost += u.costUsd ?? 0;
    }
    return any ? { inputTokens: input, outputTokens: output, costUsd: cost } : undefined;
  }

  private onRaw(e: RawEvent) {
    if (e.type === "uniqlaw.stream_closed") {
      if (!this.closing) {
        this.emit({ type: "error", error: "opencode event stream closed", fatal: true });
        this.endTurn("error", "crash");
        this.events.close();
      }
      return;
    }
    const p = e.properties ?? {};
    const sid = p.sessionID ?? p.info?.sessionID ?? p.part?.sessionID;
    if (!this.id || sid !== this.id) return;
    switch (e.type) {
      case "message.updated": {
        const info = p.info ?? {};
        this.msgRole.set(info.id, info.role);
        const created = info.time?.created ?? Date.now();
        this.msgCreated.set(info.id, created);
        if (info.role !== "assistant") break;
        if (info.tokens) this.usageByMsg.set(info.id, { inputTokens: info.tokens.input, outputTokens: info.tokens.output, costUsd: info.cost });
        // Ignore errors re-pushed for messages from earlier turns (M0 trap 2).
        if (info.error && this.state === "running" && created >= this.turnStartedAt - 1000) this.lastError = info.error;
        break;
      }
      case "message.part.updated": {
        const part = p.part ?? {};
        this.partType.set(part.id, part.type);
        this.partMsg.set(part.id, part.messageID);
        const role = this.msgRole.get(part.messageID);
        if (part.type === "text" && role === "assistant" && part.time?.end && !this.finalSent.has(part.id)) {
          this.finalSent.add(part.id);
          if ((part.text ?? "").trim()) this.emit({ type: "text", segmentId: part.id, final: part.text });
        } else if (part.type === "reasoning" && part.time?.end && (part.text ?? "").trim()) {
          this.emit({ type: "thinking", segmentId: part.id, text: part.text });
        } else if (part.type === "tool") {
          const st = part.state ?? {};
          const id = part.callID ?? part.id;
          const hasInput = st.input && Object.keys(st.input).length > 0;
          if (!this.toolStarted.has(id) && (st.status === "running" || (st.status === "pending" && hasInput) || st.status === "completed" || st.status === "error")) {
            this.toolStarted.add(id);
            this.emit({ type: "tool_start", id, name: part.tool, input: st.input ?? {} });
          }
          if ((st.status === "completed" || st.status === "error") && !this.toolEnded.has(id)) {
            this.toolEnded.add(id);
            this.emit({ type: "tool_end", id, ok: st.status === "completed", summary: String(st.output ?? st.error ?? "").slice(0, 500) });
          }
        }
        break;
      }
      case "message.part.delta": {
        const pid = p.partID;
        if (this.partType.get(pid) === "text" && this.msgRole.get(this.partMsg.get(pid) ?? p.messageID) === "assistant" && typeof p.delta === "string") {
          this.emit({ type: "text", segmentId: pid, delta: p.delta });
        }
        break;
      }
      case "permission.asked":
      case "permission.v2.asked": {
        const id = p.id;
        if (!id || this.permsSeen.has(id)) break;
        this.permsSeen.add(id);
        const tool = p.permission ?? p.action ?? "tool";
        const patterns: string[] = p.patterns ?? p.resources ?? [];
        this.emit({ type: "permission_request", id, tool, input: { patterns, metadata: p.metadata }, title: `${tool} ${patterns.join(" ")}`.trim() });
        break;
      }
      case "question.asked": {
        const qs: { question?: string; header?: string; options?: { label: string }[] }[] = p.questions ?? [];
        const title = qs.map((q) => [q.header, q.question, q.options?.length ? `(${q.options.map((o) => o.label).join(" / ")})` : ""].filter(Boolean).join(" ")).join("\n");
        this.emit({ type: "input_request", id: p.id, kind: "elicitation", title: title || "The agent has a question" });
        break;
      }
      case "session.error":
        if (this.state === "running") {
          this.lastError = p.error ?? "session error";
          if (this.awaitingBusy) this.errorBeforeBusy = true;
        }
        this.log.warn("session.error", { error: JSON.stringify(p.error ?? {}).slice(0, 300) });
        break;
      case "session.status": {
        const t = p.status?.type;
        if (t === "busy") {
          if (this.state === "running") this.awaitingBusy = false;
          // A late busy right after an abort belongs to the aborted run, not a new turn.
          else if (!this.closing && Date.now() - this.lastInterruptedEndAt > 2000) this.beginTurn(true);
        }
        break;
      }
      case "session.idle": {
        if (this.state !== "running") break;            // duplicate idle after a finished turn
        if (this.awaitingBusy && !this.errorBeforeBusy) break; // stale idle from before our prompt
        const aborted = this.interrupting || (this.lastError as { name?: string } | undefined)?.name === "MessageAbortedError";
        if (aborted) this.endTurn("interrupted");
        else if (this.lastError) this.endTurn("error", errorCode(this.lastError));
        else this.endTurn("done");
        break;
      }
    }
  }
}
