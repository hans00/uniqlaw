// Provider contract (docs/architecture.md §5). Every agent backend — claude-tmux,
// claude-sdk, codex, opencode, acp, agy, pi — implements AgentProvider.
import type { Credential } from "./credentials.ts";
import type { PermissionPolicy } from "./permissions.ts";

export interface ProviderCapabilities {
  /** Output granularity. */
  streaming: "token" | "segment" | "final";
  interrupt: boolean;
  /** Mid-turn injection (lands after the in-flight tool call). Turn-boundary
   *  queueing is always done by the core, so it is not a capability. */
  steer: boolean;
  /** Who persists conversation history. */
  resume: "native" | "core-managed";
  /** Denying a permission request ends the whole turn (claude-tmux). */
  denyEndsTurn: boolean;
  modelSwitch: "live" | "spawn" | false;
  permissionCallback: boolean;
  /** "per-session" only if the adapter passes the cross-session MCP isolation
   *  contract test; otherwise the core runs one provider process per session. */
  mcp: "per-session" | "per-process" | false;
  nativeTools: boolean;
  attachments: ("image" | "file" | "audio")[];
  slashCommands: boolean;
}

/** Named agent configuration (provider + model + prompt + permissions). */
export interface Profile {
  name: string;
  provider: string;
  model?: string;
  credential?: string;
  credentialResolved?: Credential;
  permissions: PermissionPolicy;
  /** Provider-specific options, validated by the provider plugin. */
  options: Record<string, unknown>;
  /** Profiles offered when this one hits its usage limit. */
  fallback?: string[];
}

export interface SystemPromptParts {
  /** Ordered fragments; the adapter decides how to inject them
   *  (--append-system-prompt, system message, AGENTS.md, …). */
  fragments: { id: string; text: string }[];
}

export interface Attachment {
  kind: "image" | "file" | "audio" | "video" | "voice" | "sticker";
  path: string;
  mime?: string;
  name?: string;
  durationSec?: number;
}

export interface TurnInput {
  /** Already-composed prompt text (sender tags, inbox block, merged queue). */
  text: string;
  attachments: Attachment[];
  /** Raw slash command (e.g. "/compact"); adapters with slashCommands send it verbatim. */
  slashCommand?: boolean;
}

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema of the arguments. */
  inputSchema: Record<string, unknown>;
  handler(args: unknown): Promise<{ text: string; isError?: boolean }>;
}

export interface SessionSpec {
  /** UniQlaw session id (stable across restarts). */
  sessionId: string;
  /** Present when resuming. */
  providerSessionId?: string;
  cwd: string;
  profile: Profile;
  systemPrompt: SystemPromptParts;
  /** MCP Gateway endpoint for this session (identity = token). */
  mcp?: { url: string; token: string; toolNames: string[] };
  nativeTools?: ToolDef[];
  /** Base environment for the provider child process (never the daemon's full env).
   *  Core does NOT put credentials here: each adapter maps profile.credentialResolved
   *  to its own provider-specific env/config. */
  env: Record<string, string>;
  /** Instance-scoped namespace for anything global (tmux socket, process names). */
  instanceId: string;
  /** false: UniQlaw memory is in use; disable the provider's own memory features if it has any
   *  (Claude Code auto-memory / auto-dream). Undefined/true: leave them as configured. */
  nativeMemory?: boolean;
}

export type PermissionDecision =
  | { behavior: "allow"; scope?: "once" | "session" }
  | { behavior: "deny"; message?: string };

export type Usage = { inputTokens?: number; outputTokens?: number; costUsd?: number };

export type AgentEvent =
  | { type: "session"; providerSessionId: string }
  | { type: "turn_start"; turnId: string }
  | { type: "text"; segmentId: string; delta?: string; final?: string }
  | { type: "thinking"; segmentId: string; text: string }
  | { type: "tool_start"; id: string; name: string; input: unknown }
  | { type: "tool_end"; id: string; ok: boolean; summary?: string }
  | { type: "permission_request"; id: string; tool: string; input: unknown; title: string;
      kind?: "permission" | "model-switch" | "question"; options?: string[] }
  | { type: "input_request"; id: string; title: string; schema?: unknown; url?: string;
      kind?: "login" | "elicitation" }
  | { type: "turn_end"; turnId: string; reason: "done" | "interrupted" | "error"; usage?: Usage;
      /** Free text, or a typed code: "rate_limit" (retryable) | "usage_limit" | "stall" | "auth" | "crash". */
      error?: string }
  /** A turn the core did not start. source "external" = input arrived through a channel
   *  outside UniQlaw (e.g. Claude's native peer messaging socket): core routes it to
   *  operators only, never to the regular chat. */
  | { type: "unsolicited_turn"; source?: "background" | "external" }
  | { type: "model"; model: string }
  | { type: "error"; error: string; fatal: boolean };

export interface AgentSession {
  readonly capabilities: ProviderCapabilities;
  /** Start a new turn (session must be idle). */
  send(input: TurnInput): Promise<void>;
  /** capabilities.steer only. If the turn just ended, the adapter falls back to send(). */
  steer?(input: TurnInput): Promise<void>;
  interrupt?(): Promise<void>;
  setModel?(model: string): Promise<void>;
  respondPermission?(id: string, decision: PermissionDecision, optionIndex?: number): Promise<void>;
  respondInput?(id: string, value: string): Promise<void>;
  /** Single consumer. Ends when the session is closed. */
  events: AsyncIterable<AgentEvent>;
  /** Release resources but keep the conversation resumable. */
  close(): Promise<void>;
  /** Stop watching without stopping the provider process (daemon restart). The next
   *  open() with the same providerSessionId reattaches. Optional: core falls back to close(). */
  detach?(): void;
  /** Process/connection is alive (used by health checks + reattach). */
  alive(): Promise<boolean>;
}

export interface AgentProvider {
  readonly name: string;
  capabilities(profile: Profile): ProviderCapabilities;
  open(spec: SessionSpec): Promise<AgentSession>;
  /** Optional: how a human takes over this session in a terminal. live = attach to the running
   *  process (core keeps watching); otherwise core closes the session first and the command
   *  resumes the same conversation in the provider's own CLI. undefined = not possible. */
  attachCommand?(o: { instanceId: string; sessionId: string; providerSessionId?: string; cwd: string; profile: Profile }):
    { argv: string[]; live: boolean; env?: Record<string, string> } | undefined;
}
