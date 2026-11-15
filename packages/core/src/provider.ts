// Provider contract (docs/architecture.md §5). Every agent backend — claude-tmux,
// claude-sdk, codex, opencode, acp, agy, pi — implements AgentProvider.
import type { Credential } from "./credentials.ts";
import type { PermissionPolicy } from "./permissions.ts";
import type { ToolPolicy } from "./channel-policy.ts";

export interface ProviderCapabilities {
  /** false: the provider emits no tool_start / tool_end events, so the approval judge's action trace is unavailable
   *  (default: available). */
  toolTrace?: boolean;
  /** Shell dialect of each shell tool (lowercase tool name → dialect), for the approval judge's command normalizer
   *  (see shell.ts). Tools not listed are read as POSIX ("unknown"); a `PowerShell` tool is always powershell. */
  shellDialects?: Readonly<Record<string, import("./shell.ts").ShellDialect>>;
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
  /** Enforces SessionSpec.toolPolicy on its own (native) tools. Without it, core refuses to open a session whose
   *  channel policy restricts native tools (fail closed); MCP tools are filtered by the gateway either way. */
  toolPolicy?: boolean;
  /** Honors SessionSpec.isolated and enforces PermissionPolicy.denyTools exactly (tool names and path rules) on its
   *  own tools. Without it, core refuses inbound A2A sessions on this provider (fail closed) unless the operator
   *  opted in with `expose.<profile>.unsafeProvider`. */
  isolation?: boolean;
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
  /** Channel capabilities (settings.channels). Absent = unrestricted. `mcp.toolNames` is already filtered; the
   *  provider removes the native tools of the policy (see claudeToolLists) and, in allow mode, any MCP server
   *  other than UniQlaw's. */
  toolPolicy?: ToolPolicy;
  /** A remote party drives this session (inbound A2A). The provider loads nothing of the operator's own: no user /
   *  project settings, CLAUDE.md, hooks, skills or plugins, no MCP server but UniQlaw's, no native memory. `cwd` is
   *  an empty directory outside the project. Only honored by providers with the `isolation` capability. */
  isolated?: boolean;
  /** MCP Gateway endpoint for this session (identity = token). `permissionHookUrl`: where a provider with
   *  permission hooks (Claude Code `PermissionRequest`) posts a request for the approval judge (docs §10.4). */
  mcp?: { url: string; token: string; toolNames: string[]; permissionHookUrl?: string };
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
  /** summary: an excerpt of the tool's output (core shows it to the approval judge only for read-only diagnostic
   *  commands). */
  | { type: "tool_end"; id: string; ok: boolean; summary?: string }
  /** A permission_request was settled without us (answered in the provider's own UI, the dialog went away, the
   *  request was aborted): core cancels its chat prompt. */
  | { type: "permission_withdrawn"; id: string }
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

/** Signs of life a provider can report while a turn is quiet (no events), so a long tool call is not taken for a stall. */
export interface Liveness {
  /** Visibly working right now: in a tool call, generating, or waiting on a dialog. */
  busy?: boolean;
  /** Epoch ms of the last progress the provider saw outside its events (transcript write, terminal output change…). */
  lastActivityAt?: number;
  /** What was checked and what it showed, logged when a stall is declared. */
  signals?: Record<string, unknown>;
}

/** A provider process as seen from outside (docs §11.4 pane watchdog). */
export interface PaneInspection {
  process: "alive" | "dead" | "absent";
  /** Exit status of a dead process, when known. */
  exitStatus?: number;
  /** What keeps it from taking input: a startup prompt (label), a permission/question dialog (the approval path owns
   *  those), the provider's MCP dialog, or another menu/modal. */
  blocker?: { kind: "startup" | "permission" | "mcp-dialog" | "modal"; label?: string };
  /** Idle at an empty prompt (open sessions only). */
  idle?: boolean;
  /** The process's working directory, when known. */
  cwd?: string;
}

export type SessionRepair = "answer-startup-prompt" | "close-dialog";

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
  /** The pid every command of this session descends from (e.g. claude-tmux's pane process), so core can tell a
   *  process this session started from others (approval judge provenance). undefined = unknown. */
  processRoot?(): number | undefined;
  /** Optional: liveness signals, asked by core's stall watchdog before it abandons a quiet turn. */
  liveness?(): Promise<Liveness>;
  /** Process/connection is alive (used by health checks + reattach). */
  alive(): Promise<boolean>;
  /** This session reattached to a process that outlived the previous daemon (its MCP client may have lost the
   *  gateway during the restart). */
  readonly reattached?: boolean;
  /** Optional (pane watchdog): look at the process without changing anything. */
  inspect?(): Promise<PaneInspection>;
  /** Optional: make the provider's MCP client reconnect to the gateway, only while idle at an empty prompt.
   *  `verify(since)`: did the gateway see this session (re)initialize at or after `since`? */
  reconnectMcp?(verify: (since: number) => boolean, signal?: AbortSignal): Promise<{ ok: boolean; outcome: string; detail: string }>;
  /** Optional: restart the provider process keeping the conversation (resume), only while idle. */
  respawn?(): Promise<boolean>;
  /** Optional: a safe, specific repair of what blocks the session (core decides when it is allowed). */
  repair?(action: SessionRepair): Promise<string | undefined>;
}

export interface AgentProvider {
  readonly name: string;
  capabilities(profile: Profile): ProviderCapabilities;
  open(spec: SessionSpec): Promise<AgentSession>;
  /** Optional: how a human takes over this session in a terminal. live = attach to the running
   *  process (core keeps watching); otherwise core closes the session first and the command
   *  resumes the same conversation in the provider's own CLI. undefined = not possible. */
  /** Optional (pane watchdog): inspect a session's process without opening it. */
  inspect?(o: { instanceId: string; sessionId: string }): Promise<PaneInspection>;
  /** Optional: provider processes of this instance that belong to none of `known` (session ids). */
  orphans?(o: { instanceId: string; known: string[] }): Promise<{ id: string; inspection: PaneInspection }[]>;
  attachCommand?(o: { instanceId: string; sessionId: string; providerSessionId?: string; cwd: string; profile: Profile }):
    { argv: string[]; live: boolean; env?: Record<string, string> } | undefined;
}
