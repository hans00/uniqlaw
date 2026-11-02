// One UniQlaw session = one codex thread on a (possibly shared) app-server process.
import type {
  AgentEvent, AgentSession, Logger, PermissionDecision, ProviderCapabilities, TurnInput,
} from "@uniqlaw/core";
import { AsyncQueue } from "./queue.ts";
import { RpcError, type AppServer, type RpcId } from "./rpc.ts";
import { errorCode, toolFromItem, toolOk, type CodexPolicy } from "./mapping.ts";
import type { UserInput } from "./protocol/v2/UserInput";
import type { ReasoningEffort } from "./protocol/ReasoningEffort";

export const CODEX_CAPABILITIES: ProviderCapabilities = {
  streaming: "token",
  interrupt: true,
  steer: true,
  resume: "native",
  denyEndsTurn: false,
  modelSwitch: "live",
  permissionCallback: true,
  mcp: "per-session",
  nativeTools: false,
  attachments: ["image", "audio"],
  slashCommands: false,
};

export interface CodexSessionInit {
  server: AppServer;
  log: Logger;
  cwd: string;
  model?: string;
  effort?: string;
  policy: CodexPolicy;
  onClose: (s: CodexSession) => void;
}

type Pending =
  | { kind: "command" | "fileChange" | "legacyExec" | "legacyPatch"; rpcId: RpcId }
  | { kind: "permissions"; rpcId: RpcId; requested: any }
  | { kind: "userInput"; rpcId: RpcId; questionIds: string[] }
  | { kind: "elicitation"; rpcId: RpcId };

export class CodexSession implements AgentSession {
  readonly capabilities = CODEX_CAPABILITIES;
  readonly events = new AsyncQueue<AgentEvent>();
  threadId = "";
  private activeTurnId = "";
  private expectingTurns = 0;
  private model?: string;
  private reasoning = new Map<string, string>();
  private lastUsage?: { inputTokens: number; outputTokens: number };
  private pending = new Map<string, Pending>();
  private closed = false;

  constructor(private o: CodexSessionInit) {
    this.model = o.model;
  }

  get server() { return this.o.server; }

  emit(ev: AgentEvent) { this.events.push(ev); }

  // ── outbound ────────────────────────────────────────────────────────────

  private toInput(input: TurnInput): UserInput[] {
    const items: UserInput[] = [];
    const extra: string[] = [];
    for (const a of input.attachments) {
      if (a.kind === "image" || a.kind === "sticker") items.push({ type: "localImage", path: a.path });
      else if (a.kind === "audio" || a.kind === "voice") items.push({ type: "localAudio", path: a.path });
      else extra.push(`[Attached ${a.kind}${a.name ? ` ${a.name}` : ""}: ${a.path}]`);
    }
    const text = [...extra, input.text].filter(Boolean).join("\n");
    return [{ type: "text", text, text_elements: [] }, ...items];
  }

  async send(input: TurnInput): Promise<void> {
    this.ensureOpen();
    this.expectingTurns++;
    try {
      // Per-turn overrides are sticky in codex, so always send the full effective settings.
      const r = await this.o.server.request<{ turn: { id: string } }>("turn/start", {
        threadId: this.threadId,
        input: this.toInput(input),
        cwd: this.o.cwd,
        model: this.model ?? null,
        effort: (this.o.effort as ReasoningEffort | undefined) ?? null,
        approvalPolicy: this.o.policy.approvalPolicy,
        sandboxPolicy: this.o.policy.sandboxPolicy,
      });
      if (!this.activeTurnId) this.activeTurnId = r.turn.id;
    } catch (e) {
      this.expectingTurns = Math.max(0, this.expectingTurns - 1);
      throw e;
    }
  }

  async steer(input: TurnInput): Promise<void> {
    this.ensureOpen();
    if (!this.activeTurnId) return this.send(input);
    try {
      await this.o.server.request("turn/steer", { threadId: this.threadId, expectedTurnId: this.activeTurnId, input: this.toInput(input) });
    } catch (e) {
      // Turn ended (or changed) between our check and the request: start a new turn instead.
      if (e instanceof RpcError && (e.code === -32600 || /no active turn|expected turn/i.test(e.message))) return this.send(input);
      throw e;
    }
  }

  async interrupt(): Promise<void> {
    if (!this.activeTurnId || this.closed) return;
    await this.o.server.request("turn/interrupt", { threadId: this.threadId, turnId: this.activeTurnId });
  }

  async setModel(model: string): Promise<void> {
    // Takes effect on the next turn/start (sticky from then on).
    this.model = model;
    this.emit({ type: "model", model });
  }

  async respondPermission(id: string, d: PermissionDecision): Promise<void> {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    const allow = d.behavior === "allow";
    const session = allow && d.scope === "session";
    switch (p.kind) {
      case "command":
      case "fileChange":
        return this.o.server.respond(p.rpcId, { decision: allow ? (session ? "acceptForSession" : "accept") : "decline" });
      case "legacyExec":
      case "legacyPatch":
        return this.o.server.respond(p.rpcId, { decision: allow ? (session ? "approved_for_session" : "approved") : { denied: { rejection: (d.behavior === "deny" && d.message) || "denied by operator" } } });
      case "permissions": {
        const granted: Record<string, unknown> = {};
        if (allow) for (const [k, v] of Object.entries(p.requested ?? {})) if (v != null) granted[k] = v;
        return this.o.server.respond(p.rpcId, { permissions: granted, scope: session ? "session" : "turn" });
      }
      default:
        return;
    }
  }

  async respondInput(id: string, value: string): Promise<void> {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    if (p.kind === "userInput") {
      const answers: Record<string, { answers: string[] }> = {};
      for (const q of p.questionIds) answers[q] = { answers: [value] };
      this.o.server.respond(p.rpcId, { answers });
    } else if (p.kind === "elicitation") {
      this.o.server.respond(p.rpcId, { action: "accept", content: null, _meta: null });
    }
  }

  async alive(): Promise<boolean> { return !this.closed && !this.o.server.exited; }

  async close(): Promise<void> {
    if (this.closed) return;
    if (this.activeTurnId) await this.interrupt().catch(() => {});
    this.closed = true;
    // Unanswered server requests would hang the thread; decline them.
    for (const [id] of this.pending) await this.respondPermission(id, { behavior: "deny", message: "session closed" });
    if (!this.o.server.exited && this.threadId) await this.o.server.request("thread/unsubscribe", { threadId: this.threadId }).catch(() => {});
    this.events.close();
    this.o.onClose(this);
  }

  private ensureOpen() {
    if (this.closed) throw new Error("codex session is closed");
    if (this.o.server.exited) throw new Error("codex app-server is not running");
  }

  // ── inbound (dispatched by the provider for this thread) ────────────────

  onNotification(method: string, p: any) {
    switch (method) {
      case "turn/started": {
        const id: string = p.turn.id;
        this.activeTurnId = id;
        if (this.expectingTurns > 0) this.expectingTurns--;
        else this.emit({ type: "unsolicited_turn", source: "background" });
        this.emit({ type: "turn_start", turnId: id });
        return;
      }
      case "item/agentMessage/delta":
        this.emit({ type: "text", segmentId: p.itemId, delta: p.delta });
        return;
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta":
        this.reasoning.set(p.itemId, (this.reasoning.get(p.itemId) ?? "") + p.delta);
        return;
      case "item/started": {
        const t = toolFromItem(p.item);
        if (t) this.emit({ type: "tool_start", id: p.item.id, name: t.name, input: t.input });
        return;
      }
      case "item/completed": {
        const it = p.item;
        if (it.type === "agentMessage") this.emit({ type: "text", segmentId: it.id, final: it.text ?? "" });
        else if (it.type === "reasoning") {
          const text = this.reasoning.get(it.id) ?? [...(it.summary ?? [])].join("\n");
          this.reasoning.delete(it.id);
          if (text.trim()) this.emit({ type: "thinking", segmentId: it.id, text });
        } else if (toolFromItem(it)) {
          this.emit({ type: "tool_end", id: it.id, ok: toolOk(it), summary: it.status ? String(it.status) : undefined });
        }
        return;
      }
      case "thread/tokenUsage/updated": {
        const last = p.tokenUsage?.last;
        if (last) this.lastUsage = { inputTokens: last.inputTokens, outputTokens: last.outputTokens };
        return;
      }
      case "thread/settings/updated": {
        const m = p.threadSettings?.model;
        if (typeof m === "string" && m && m !== this.model) { this.model = m; this.emit({ type: "model", model: m }); }
        return;
      }
      case "turn/completed": {
        const t = p.turn;
        if (this.activeTurnId === t.id) this.activeTurnId = "";
        const reason = t.status === "completed" ? "done" : t.status === "interrupted" ? "interrupted" : "error";
        this.emit({ type: "turn_end", turnId: t.id, reason, usage: this.lastUsage, error: reason === "error" ? errorCode(t.error) ?? "turn failed" : undefined });
        this.lastUsage = undefined;
        return;
      }
      case "error":
        if (!p.willRetry) this.o.log.warn("codex turn error", { threadId: this.threadId, error: p.error?.message, info: p.error?.codexErrorInfo });
        return;
      default:
        return;
    }
  }

  onServerRequest(method: string, p: any, rpcId: RpcId) {
    const id = `codex-${String(rpcId)}`;
    switch (method) {
      case "item/commandExecution/requestApproval":
        this.pending.set(id, { kind: "command", rpcId });
        this.emit({ type: "permission_request", id, tool: "Bash", kind: "permission",
          input: { command: p.command, cwd: p.cwd, reason: p.reason ?? undefined },
          title: p.command ? `Run: ${p.command}` : (p.reason ?? "Run a command") });
        return;
      case "item/fileChange/requestApproval":
        this.pending.set(id, { kind: "fileChange", rpcId });
        this.emit({ type: "permission_request", id, tool: "Edit", kind: "permission",
          input: { reason: p.reason ?? undefined, grantRoot: p.grantRoot ?? undefined },
          title: p.grantRoot ? `Write files under ${p.grantRoot}` : (p.reason ?? "Apply file changes") });
        return;
      case "item/permissions/requestApproval":
        this.pending.set(id, { kind: "permissions", rpcId, requested: p.permissions });
        this.emit({ type: "permission_request", id, tool: "SandboxPermissions", kind: "permission",
          input: { permissions: p.permissions, reason: p.reason ?? undefined },
          title: p.reason ?? "Grant additional sandbox permissions" });
        return;
      case "execCommandApproval":
        this.pending.set(id, { kind: "legacyExec", rpcId });
        this.emit({ type: "permission_request", id, tool: "Bash", kind: "permission", input: { command: p.command, cwd: p.cwd }, title: `Run: ${[].concat(p.command ?? []).join(" ")}` });
        return;
      case "applyPatchApproval":
        this.pending.set(id, { kind: "legacyPatch", rpcId });
        this.emit({ type: "permission_request", id, tool: "Edit", kind: "permission", input: { reason: p.reason }, title: p.reason ?? "Apply file changes" });
        return;
      case "item/tool/requestUserInput": {
        const qs: any[] = p.questions ?? [];
        this.pending.set(id, { kind: "userInput", rpcId, questionIds: qs.map((q) => q.id) });
        this.emit({ type: "input_request", id, kind: "elicitation", title: qs.map((q) => q.question || q.header).join("\n") || "The agent needs input" });
        return;
      }
      case "mcpServer/elicitation/request":
        if (p.mode === "url") {
          this.pending.set(id, { kind: "elicitation", rpcId });
          this.emit({ type: "input_request", id, kind: "elicitation", title: p.message, url: p.url });
        } else {
          this.o.log.info("declining MCP elicitation", { server: p.serverName, mode: p.mode });
          this.o.server.respond(rpcId, { action: "decline", content: null, _meta: null });
        }
        return;
      default:
        this.o.log.warn("codex: unhandled server request", { method });
        this.o.server.respondError(rpcId, -32601, `UniQlaw does not handle ${method}`);
    }
  }

  /** The app-server process died. */
  onServerExit(reason: string) {
    if (this.closed) return;
    if (this.activeTurnId) this.emit({ type: "turn_end", turnId: this.activeTurnId, reason: "error", error: "crash" });
    this.emit({ type: "error", error: reason, fatal: true });
    this.closed = true;
    this.events.close();
  }
}
