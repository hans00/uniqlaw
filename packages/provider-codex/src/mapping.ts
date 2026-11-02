// Pure translation helpers: UniQlaw policy/credentials → codex settings,
// codex items/errors → AgentEvent fields.
import { expandHome, resolveSecret, type Credential, type PermissionPolicy } from "@uniqlaw/core";
import type { AskForApproval } from "./protocol/v2/AskForApproval";
import type { SandboxMode } from "./protocol/v2/SandboxMode";
import type { SandboxPolicy } from "./protocol/v2/SandboxPolicy";
import type { TurnError } from "./protocol/v2/TurnError";

export interface CodexPolicy {
  approvalPolicy: AskForApproval;
  sandbox: SandboxMode;
  sandboxPolicy: SandboxPolicy;
}

/**
 * ask-operator / auto-deny → "untrusted": codex asks before any command it doesn't consider
 * safe, and core answers (operator buttons, or auto-deny). auto-allow → "never".
 * The sandbox comes from the security level; approving a command never escalates it.
 */
export function policyFor(p: PermissionPolicy, cwd: string): CodexPolicy {
  const approvalPolicy: AskForApproval = p.approval.mode === "auto-allow" ? "never" : "untrusted";
  const roots = [cwd, ...(p.dirScope ?? [])];
  switch (p.level) {
    case "locked":
      return { approvalPolicy, sandbox: "read-only", sandboxPolicy: { type: "readOnly", networkAccess: false } };
    case "strict":
      return { approvalPolicy, sandbox: "workspace-write", sandboxPolicy: { type: "workspaceWrite", writableRoots: roots, networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false } };
    case "unrestricted":
      return { approvalPolicy, sandbox: "danger-full-access", sandboxPolicy: { type: "dangerFullAccess" } };
    default:
      return { approvalPolicy, sandbox: "workspace-write", sandboxPolicy: { type: "workspaceWrite", writableRoots: roots, networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false } };
  }
}

/** Per-thread config overrides that every session gets. */
export function threadConfig(mcp: { url: string } | undefined, level: PermissionPolicy["level"]): Record<string, unknown> {
  // Never let codex carry context across UniQlaw sessions or message other threads natively.
  // Feature flags are really honoured at process level (DISABLED_FEATURES); these per-thread
  // values are belt and braces. The collaboration.* tools (list_agents/send_message/…) cannot be
  // disabled in codex 0.166, but only see the thread's own subagent tree (isolation.e2e.test.ts).
  const cfg: Record<string, unknown> = {
    features: { memories: false, agent_message_board: false, wake_on_agent_messages: false, send_message_to_user_async: false },
  };
  if (mcp) cfg.mcp_servers = { uniqlaw: { url: mcp.url, default_tools_approval_mode: "approve" } };
  if (level === "locked" || level === "strict") cfg.tools = { web_search: false };
  return cfg;
}

/** Features always disabled at process level (where codex actually honours them). */
export const DISABLED_FEATURES = ["memories", "agent_message_board", "wake_on_agent_messages", "send_message_to_user_async"];

/** `--disable` args for the app-server process. */
export function processArgs(): string[] {
  return DISABLED_FEATURES.flatMap((f) => ["--disable", f]);
}

export interface CredentialSetup {
  env: Record<string, string>;
  /** `-c key=value` overrides for the app-server process. */
  configArgs: string[];
  modelProvider?: string;
}

const toml = (s: string) => JSON.stringify(s); // JSON string literal is a valid TOML basic string

export async function credentialSetup(cred: Credential | undefined, opts: { wireApi?: string } = {}): Promise<CredentialSetup> {
  if (!cred) return { env: {}, configArgs: [] };
  const wire = opts.wireApi ?? "responses";
  const provider = (name: string, baseUrl: string, envKey: string, extra = "") =>
    `model_providers.uniqlaw={name=${toml(name)},base_url=${toml(baseUrl)},env_key=${toml(envKey)},wire_api=${toml(wire)}${extra}}`;
  switch (cred.kind) {
    case "openai-api-key":
      // A dedicated model provider keeps the key out of CODEX_HOME/auth.json and never
      // disturbs the user's ChatGPT login.
      return {
        env: { UNIQLAW_OPENAI_API_KEY: await resolveSecret(cred.key) },
        configArgs: ["-c", provider("OpenAI (UniQlaw)", cred.baseUrl ?? "https://api.openai.com/v1", "UNIQLAW_OPENAI_API_KEY")],
        modelProvider: "uniqlaw",
      };
    case "openai-compatible":
      return {
        env: cred.key ? { UNIQLAW_OPENAI_API_KEY: await resolveSecret(cred.key) } : {},
        configArgs: ["-c", cred.key
          ? provider("OpenAI-compatible (UniQlaw)", cred.baseUrl, "UNIQLAW_OPENAI_API_KEY")
          : `model_providers.uniqlaw={name="OpenAI-compatible (UniQlaw)",base_url=${toml(cred.baseUrl)},wire_api=${toml(wire)}}`],
        modelProvider: "uniqlaw",
      };
    case "azure": {
      if (cred.auth.type !== "api-key") throw new Error("codex: Azure Entra ID auth is not supported by codex model providers; use an api-key credential");
      const base = `${cred.endpoint.replace(/\/+$/, "")}/openai`;
      return {
        env: { UNIQLAW_AZURE_OPENAI_API_KEY: await resolveSecret(cred.auth.key) },
        configArgs: ["-c", provider("Azure OpenAI (UniQlaw)", base, "UNIQLAW_AZURE_OPENAI_API_KEY", `,query_params={"api-version"=${toml(cred.apiVersion ?? "2025-04-01-preview")}}`)],
        modelProvider: "uniqlaw",
      };
    }
    case "provider-login":
      return { env: cred.home ? { CODEX_HOME: expandHome(cred.home) } : {}, configArgs: [] };
    default:
      throw new Error(`codex: credential kind "${cred.kind}" is not supported (use openai-api-key, openai-compatible, azure or provider-login)`);
  }
}

const TOOL_ITEMS = new Set(["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "webSearch", "collabAgentToolCall", "imageGeneration"]);

/** Tool-like thread items → tool_start name/input (names chosen to match core's tool display). */
export function toolFromItem(item: any): { name: string; input: unknown } | undefined {
  if (!item || !TOOL_ITEMS.has(item.type)) return undefined;
  switch (item.type) {
    case "commandExecution": return { name: "Bash", input: { command: item.command, cwd: item.cwd } };
    case "fileChange": {
      const first = Array.isArray(item.changes) ? item.changes[0] : undefined;
      return { name: "Edit", input: { file_path: first?.path, changes: Array.isArray(item.changes) ? item.changes.length : undefined } };
    }
    case "mcpToolCall": return { name: `mcp__${item.server}__${item.tool}`, input: item.arguments };
    case "dynamicToolCall": return { name: item.tool ?? "tool", input: item.arguments };
    case "webSearch": return { name: "WebSearch", input: { query: item.query } };
    case "collabAgentToolCall": return { name: "Agent", input: { description: item.prompt ?? item.description } };
    default: return { name: item.type, input: {} };
  }
}

export function toolOk(item: any): boolean {
  const s = String(item?.status ?? "completed");
  return !["failed", "declined", "error"].includes(s) && !(item?.type === "commandExecution" && typeof item.exitCode === "number" && item.exitCode !== 0);
}

/** codex TurnError → turn_end.error (typed codes per core contract). */
export function errorCode(err: TurnError | null | undefined): string | undefined {
  if (!err) return undefined;
  const info = err.codexErrorInfo;
  if (info === "rateLimitExceeded" || info === "serverOverloaded") return "rate_limit";
  if (info === "usageLimitExceeded" || info === "sessionBudgetExceeded") return "usage_limit";
  if (info === "unauthorized") return "auth";
  return err.message || (typeof info === "string" ? info : "error");
}
