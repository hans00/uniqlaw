// One UniQlaw session ↔ one ACP session. session/prompt resolution = turn end;
// concurrent prompts (steer) end the turn only when the last one resolves.
import type { AgentEvent, AgentSession, Logger, PermissionDecision, ProviderCapabilities, TurnInput, Usage } from "@uniqlaw/core";
import { AsyncQueue } from "./queue.ts";
import type { AcpAgent, SessionSink } from "./agent.ts";
import { elicitationContent, errorCode, pickOption, promptBlocks, stopReasonToEnd, type AcpPermissionOption } from "./mapping.ts";

interface PendingPermission { resolve: (r: unknown) => void; options: AcpPermissionOption[] }
interface PendingElicitation { resolve: (r: unknown) => void; schema?: { properties?: Record<string, unknown> }; url?: string }

export class AcpSession implements AgentSession, SessionSink {
  readonly events = new AsyncQueue<AgentEvent>();
  id = "";
  replaying = false;
  /** Prepended once to the first prompt (agents without a system-prompt channel). */
  pendingSystem?: string;
  configOptions: any[] = [];
  commands: { name: string; description?: string }[] = [];
  private state: "idle" | "running" = "idle";
  private turnSeq = 0;
  private turnId = "";
  private outstanding = 0;
  private cancelled = false;
  private lastStop?: string;
  private lastError?: unknown;
  private usage?: Usage;
  private textBuf = "";
  private segment = 0;
  private toolsOpen = new Set<string>();
  private perms = new Map<string, PendingPermission>();
  private elicits = new Map<string, PendingElicitation>();
  private closed = false;
  /** Provider-side failure seen outside ACP (e.g. agent logs): wins over "cancelled". */
  private forcedError?: string;

  constructor(readonly capabilities: ProviderCapabilities, private agent: AcpAgent, private log: Logger,
    private o: { onClose: (s: AcpSession) => Promise<void> }) {}

  emit(ev: AgentEvent) { this.events.push(ev); }

  // ── input ────────────────────────────────────────────────────────────────

  async send(input: TurnInput): Promise<void> {
    if (this.state === "running") return this.steer(input);
    this.state = "running";
    this.turnId = `t${++this.turnSeq}`;
    this.cancelled = false; this.lastStop = undefined; this.lastError = undefined; this.usage = undefined; this.forcedError = undefined;
    this.emit({ type: "turn_start", turnId: this.turnId });
    void this.runPrompt(input);
  }

  async steer(input: TurnInput): Promise<void> {
    if (this.state === "idle") return this.send(input);
    if (!this.capabilities.steer) throw new Error("this ACP agent does not support mid-turn input (steer); queue it instead");
    void this.runPrompt(input);
  }

  private async runPrompt(input: TurnInput) {
    this.outstanding++;
    try {
      let text = input.text;
      if (this.pendingSystem && !input.slashCommand) { text = `[Instructions for this session]\n${this.pendingSystem}\n\n[Message]\n${text}`; this.pendingSystem = undefined; }
      const prompt = await promptBlocks(text, input.attachments, this.agent.caps.promptCapabilities ?? {});
      const res = await this.agent.request<{ stopReason?: string; usage?: any }>("session/prompt", { sessionId: this.id, prompt });
      if (res?.stopReason === "cancelled") this.cancelled = true;
      this.lastStop = this.cancelled ? "cancelled" : res?.stopReason;
      if (res?.usage) this.usage = { inputTokens: res.usage.inputTokens ?? res.usage.input_tokens, outputTokens: res.usage.outputTokens ?? res.usage.output_tokens };
    } catch (e) {
      this.lastError = e;
      this.log.warn("session/prompt failed", { e: String(e) });
    } finally {
      this.outstanding--;
      if (this.outstanding === 0) this.finishTurn();
    }
  }

  private finishTurn() {
    if (this.state !== "running") return;
    this.flushText();
    for (const [id, p] of this.perms) { p.resolve({ outcome: { outcome: "cancelled" } }); this.perms.delete(id); }
    this.state = "idle";
    const end = this.forcedError ? { reason: "error" as const, error: this.forcedError }
      : this.lastError && !this.cancelled ? { reason: "error" as const, error: errorCode(this.lastError) } : stopReasonToEnd(this.lastStop);
    this.emit({ type: "turn_end", turnId: this.turnId, ...end, ...(this.usage ? { usage: this.usage } : {}) });
  }

  async interrupt(): Promise<void> {
    if (this.state !== "running") return;
    this.cancelled = true;
    // ACP: the client must answer outstanding permission requests with "cancelled".
    for (const [id, p] of this.perms) { p.resolve({ outcome: { outcome: "cancelled" } }); this.perms.delete(id); }
    await this.agent.notify("session/cancel", { sessionId: this.id });
  }

  /** The agent failed in a way ACP doesn't surface (it would keep retrying silently):
   *  record the typed error and cancel the stuck prompt so the turn ends. */
  async providerError(code: string): Promise<void> {
    if (this.state !== "running" || this.forcedError) return;
    this.forcedError = code;
    this.log.warn("agent reported a provider error; cancelling the turn", { code });
    await this.agent.notify("session/cancel", { sessionId: this.id });
  }

  modelOption(): any | undefined {
    return this.configOptions.find((o) => o.category === "model") ?? this.configOptions.find((o) => o.id === "model");
  }

  async setModel(model: string): Promise<void> {
    const opt = this.modelOption();
    if (!opt) throw new Error("this ACP agent exposes no model option");
    const values: { value: string; name?: string }[] = (opt.options ?? []).flatMap((o: any) => (o.options ?? [o]));
    const hit = values.find((v) => v.value === model) ?? values.find((v) => v.value.endsWith(`/${model}`) || v.value.endsWith(model)) ?? values.find((v) => v.name === model);
    if (!hit) throw new Error(`model "${model}" is not offered by the agent (${values.slice(0, 8).map((v) => v.value).join(", ")}…)`);
    const r = await this.agent.request<{ configOptions?: any[] }>("session/set_config_option", { sessionId: this.id, configId: opt.id, value: hit.value });
    if (r?.configOptions) this.configOptions = r.configOptions;
    this.emit({ type: "model", model: hit.value });
  }

  async respondPermission(id: string, d: PermissionDecision): Promise<void> {
    const p = this.perms.get(id);
    if (!p) return;
    this.perms.delete(id);
    const optionId = pickOption(p.options, d);
    p.resolve(optionId ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } });
  }

  async respondInput(id: string, value: string): Promise<void> {
    const e = this.elicits.get(id);
    if (!e) return;
    this.elicits.delete(id);
    if (/^(cancel|decline|no)$/i.test(value.trim())) return e.resolve({ action: "decline" });
    e.resolve(e.url ? { action: "accept" } : { action: "accept", content: elicitationContent(e.schema, value) });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.perms.values()) p.resolve({ outcome: { outcome: "cancelled" } });
    for (const e of this.elicits.values()) e.resolve({ action: "cancel" });
    await this.o.onClose(this);
    this.events.close();
  }

  async alive() { return !this.closed && this.agent.alive(); }

  /** Agent process died. */
  crashed(code: number | null) {
    if (this.closed) return;
    this.emit({ type: "error", error: `ACP agent exited (${code})`, fatal: true });
    if (this.state === "running") { this.lastError = new Error("crash"); this.state = "running"; this.outstanding = 0; this.finishTurn(); }
    this.closed = true;
    this.events.close();
  }

  // ── agent → client ───────────────────────────────────────────────────────

  private seg() { return `${this.id}:${this.turnSeq}:${this.segment}`; }

  private flushText() {
    if (!this.textBuf) return;
    this.emit({ type: "text", segmentId: this.seg(), final: this.textBuf });
    this.textBuf = ""; this.segment++;
  }

  onUpdate(u: any) {
    switch (u?.sessionUpdate) {
      case "available_commands_update": this.commands = u.availableCommands ?? []; return;
      case "config_option_update": if (u.configOptions) this.configOptions = u.configOptions; return;
    }
    if (this.replaying) return; // session/load replays history; never forward it
    if (this.state !== "running") { this.log.debug("update outside a turn dropped", { kind: u?.sessionUpdate }); return; }
    switch (u.sessionUpdate) {
      case "agent_message_chunk":
        if (u.content?.type === "text") { this.textBuf += u.content.text; this.emit({ type: "text", segmentId: this.seg(), delta: u.content.text }); }
        break;
      case "agent_thought_chunk":
        if (u.content?.type === "text" && u.content.text.trim()) this.emit({ type: "thinking", segmentId: this.seg(), text: u.content.text });
        break;
      case "tool_call":
        this.flushText();
        if (!this.toolsOpen.has(u.toolCallId)) {
          this.toolsOpen.add(u.toolCallId);
          this.emit({ type: "tool_start", id: u.toolCallId, name: u.kind ?? u.title ?? "tool", input: u.rawInput ?? { title: u.title } });
        }
        if (u.status === "completed" || u.status === "failed") this.toolEnd(u);
        break;
      case "tool_call_update":
        if (u.status === "completed" || u.status === "failed") this.toolEnd(u);
        break;
    }
  }

  private toolEnd(u: any) {
    if (!this.toolsOpen.delete(u.toolCallId)) return;
    const summary = typeof u.rawOutput === "string" ? u.rawOutput : JSON.stringify(u.rawOutput ?? u.content ?? "");
    this.emit({ type: "tool_end", id: u.toolCallId, ok: u.status === "completed", summary: summary.slice(0, 500) });
  }

  onPermission(params: any): Promise<unknown> {
    const tc = params.toolCall ?? {};
    const id = tc.toolCallId ?? crypto.randomUUID();
    return new Promise((resolve) => {
      this.perms.set(id, { resolve, options: params.options ?? [] });
      this.emit({ type: "permission_request", id, tool: tc.kind ?? tc.title ?? "tool", input: tc.rawInput ?? tc.title ?? {}, title: tc.title ?? tc.kind ?? "Permission request" });
    });
  }

  onElicitation(params: any): Promise<unknown> {
    const id = params.elicitationId ?? crypto.randomUUID();
    return new Promise((resolve) => {
      this.elicits.set(id, { resolve, schema: params.requestedSchema, url: params.url });
      this.emit({ type: "input_request", id, kind: "elicitation", title: params.message ?? "The agent needs input", ...(params.url ? { url: params.url } : {}), ...(params.requestedSchema ? { schema: params.requestedSchema } : {}) });
    });
  }
}
