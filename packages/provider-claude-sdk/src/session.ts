// One UniQlaw session = one long-lived Agent SDK query() in streaming-input mode.
import { randomUUID } from "node:crypto";
import { query, type CanUseTool, type PermissionMode, type PermissionResult, type PermissionUpdate, type Query } from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentEvent, AgentSession, Logger, PermissionDecision, ProviderCapabilities, SessionSpec, TurnInput,
} from "@uniqlaw/core";
import {
  MCP_SERVER_NAME, claudeToolSets, baseChildEnv, claudeEnvForCredential, composeAppendSystemPrompt,
  mcpToolId, permissionModeFor, nativeMemorySettings, ISOLATED_SDK_OPTIONS,
} from "@uniqlaw/claude-common";
import { InputQueue } from "./input.ts";
import { SdkMapper } from "./mapper.ts";
import { EventQueue } from "./queue.ts";

export const CLAUDE_SDK_CAPABILITIES: ProviderCapabilities = {
  streaming: "token",
  interrupt: true,
  steer: true,
  resume: "native",
  denyEndsTurn: false,
  modelSwitch: "live",
  permissionCallback: true,
  mcp: "per-session",
  nativeTools: false,
  attachments: ["image", "file"],
  slashCommands: true,
  toolPolicy: true,
  isolation: true,
};

export interface ClaudeSdkConfig {
  claudePath?: string;
  /** Extra CLI args passed through to the bundled claude (e.g. {"debug": null}). */
  extraArgs?: Record<string, string | null>;
}

export interface ClaudeSdkProfileOptions {
  /** Default true. false → settingSources ["project","local"] (no user plugins/hooks/skills). */
  userSettings?: boolean;
  /** Override the pinned permission mode (default derived from PermissionPolicy). */
  permissionMode?: string;
}

type Pending = { resolve: (r: PermissionResult) => void; input: Record<string, unknown>; suggestions?: PermissionUpdate[] };

export class ClaudeSdkSession implements AgentSession {
  readonly capabilities = CLAUDE_SDK_CAPABILITIES;
  readonly events: EventQueue<AgentEvent>;
  private readonly input = new InputQueue();
  private readonly mapper = new SdkMapper();
  private q!: Query;
  private pending = new Map<string, Pending>();
  private closed = false;
  readonly providerSessionId: string;

  constructor(private spec: SessionSpec, private cfg: ClaudeSdkConfig, private log: Logger) {
    this.events = new EventQueue<AgentEvent>();
    this.providerSessionId = spec.providerSessionId ?? randomUUID();
    this.mapper.sessionId = this.providerSessionId;
  }

  async start(): Promise<void> {
    const { spec } = this;
    const opts = (spec.profile.options ?? {}) as ClaudeSdkProfileOptions;
    const policy = spec.profile.permissions;

    // Env isolation: minimal base env + core's base + this profile's credential. Never the daemon env.
    const env: Record<string, string> = {
      ...baseChildEnv(process.env),
      ...spec.env,
      ...(await claudeEnvForCredential(spec.profile.credentialResolved)),
      CLAUDE_AGENT_SDK_CLIENT_APP: "uniqlaw",
    };

    const sets = claudeToolSets(policy, spec.toolPolicy);
    const allow = new Set<string>(policy.allowTools);
    if (spec.mcp) for (const t of spec.mcp.toolNames) allow.add(mcpToolId(t));

    // "manual" is a TUI-only alias of "default".
    const pinned = permissionModeFor(policy, opts.permissionMode);
    const mode: PermissionMode = pinned === "manual" ? "default" : pinned;
    const canUseTool: CanUseTool = (toolName, input, o) => this.onCanUseTool(toolName, input, o);

    this.q = query({
      prompt: this.input,
      options: {
        cwd: spec.cwd,
        ...(spec.profile.model ? { model: spec.profile.model } : {}),
        ...(spec.providerSessionId ? { resume: spec.providerSessionId } : { sessionId: this.providerSessionId }),
        includePartialMessages: true,
        settingSources: opts.userSettings === false ? ["project", "local"] : ["user", "project", "local"],
        ...nativeMemorySettings(spec.isolated ? false : spec.nativeMemory),
        permissionMode: mode,
        ...(mode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
        canUseTool,
        ...(sets.tools ? { tools: sets.tools } : {}),
        ...(sets.strictMcp ? { strictMcpConfig: true } : {}),
        ...(allow.size ? { allowedTools: [...allow] } : {}),
        disallowedTools: sets.deny,
        systemPrompt: {
          type: "preset", preset: "claude_code",
          append: composeAppendSystemPrompt({ parts: spec.systemPrompt, permissions: policy, cwd: spec.cwd, mcpToolNames: spec.mcp?.toolNames, isolated: !!spec.isolated }),
        },
        ...(spec.mcp ? { mcpServers: { [MCP_SERVER_NAME]: { type: "http", url: spec.mcp.url, alwaysLoad: true } } } : {}),
        env,
        ...(this.cfg.claudePath ? { pathToClaudeCodeExecutable: this.cfg.claudePath } : {}),
        ...(this.cfg.extraArgs && !spec.isolated ? { extraArgs: this.cfg.extraArgs } : {}),
        // Remote-driven session: no built-in tools, no settings files, no MCP server but UniQlaw's (last: wins).
        ...(spec.isolated ? ISOLATED_SDK_OPTIONS : {}),
        stderr: (d: string) => this.log.debug("claude stderr", { d: d.slice(0, 500) }),
      },
    });

    // The id is ours (sessionId/resume), so it's known before the first prompt.
    this.events.push({ type: "session", providerSessionId: this.providerSessionId });
    void this.pump();
  }

  private async pump() {
    try {
      for await (const m of this.q) {
        for (const ev of this.mapper.map(m as never)) this.events.push(ev);
      }
    } catch (e) {
      if (!this.closed) {
        const msg = e instanceof Error ? e.message : String(e);
        this.log.error("sdk query failed", { msg });
        if (this.mapper.inTurn) this.events.push({ type: "turn_end", turnId: "crash", reason: "error", error: "crash" });
        this.events.push({ type: "error", error: msg, fatal: true });
      }
    } finally {
      for (const p of this.pending.values()) p.resolve({ behavior: "deny", message: "session closed" });
      this.pending.clear();
      this.events.end();
    }
  }

  private onCanUseTool(toolName: string, input: Record<string, unknown>, o: Parameters<CanUseTool>[2]): Promise<PermissionResult> {
    const id = o.toolUseID || randomUUID();
    return new Promise<PermissionResult>((resolve) => {
      this.pending.set(id, { resolve, input, suggestions: o.suggestions });
      o.signal?.addEventListener("abort", () => {
        if (this.pending.delete(id)) { resolve({ behavior: "deny", message: "aborted" }); this.events.push({ type: "permission_withdrawn", id }); }
      });
      this.events.push({
        type: "permission_request", id, tool: toolName, input,
        title: o.title ?? o.displayName ?? `Claude wants to use ${toolName}`, kind: "permission",
      });
    });
  }

  async respondPermission(id: string, d: PermissionDecision): Promise<void> {
    const p = this.pending.get(id);
    if (!p) throw new Error(`no pending permission request ${id}`);
    this.pending.delete(id);
    if (d.behavior === "allow") {
      p.resolve({ behavior: "allow", updatedInput: p.input, ...(d.scope === "session" && p.suggestions ? { updatedPermissions: p.suggestions } : {}) });
    } else {
      p.resolve({ behavior: "deny", message: d.message ?? "Denied by the operator." });
    }
  }

  private format(input: TurnInput): string {
    if (input.slashCommand || !input.attachments.length) return input.text;
    const lines = input.attachments.map((a) => `[Attached ${a.kind}${a.name ? ` "${a.name}"` : ""}: ${a.path}]`);
    return `${lines.join("\n")}\n\n${input.text}`;
  }

  async send(input: TurnInput): Promise<void> {
    if (this.closed) throw new Error("session closed");
    for (const ev of this.mapper.beginTurn()) this.events.push(ev);
    this.input.push(this.format(input));
  }

  async steer(input: TurnInput): Promise<void> {
    if (!this.mapper.inTurn) return this.send(input); // turn just ended: start a new one
    this.input.push(this.format(input), "next");
  }

  async interrupt(): Promise<void> {
    if (!this.mapper.inTurn) return;
    await this.q.interrupt();
  }

  async setModel(model: string): Promise<void> {
    await this.q.setModel(model);
    this.mapper.model = model;
    this.events.push({ type: "model", model });
  }

  async alive(): Promise<boolean> { return !this.closed; }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.input.close();
    try { this.q?.close(); } catch {}
    for (const p of this.pending.values()) p.resolve({ behavior: "deny", message: "session closed" });
    this.pending.clear();
    this.events.end();
  }
}
