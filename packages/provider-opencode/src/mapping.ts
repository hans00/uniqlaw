// Pure mappings: PermissionPolicy → opencode permission ruleset, model strings,
// error codes, isolated config/env.
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { PermissionPolicy, SessionSpec } from "@uniqlaw/core";
import { envFor, type ResolvedCredential } from "@uniqlaw/credentials";

export interface PermissionRule { permission: string; pattern: string; action: "allow" | "ask" | "deny" }

/** UniQlaw/Claude-style tool names → opencode permission ids. */
const TOOL_ALIASES: Record<string, string> = {
  bash: "bash", shell: "bash", edit: "edit", write: "edit", multiedit: "edit", notebookedit: "edit",
  webfetch: "webfetch", websearch: "websearch", read: "read", glob: "glob", grep: "grep", list: "list", ls: "list",
  task: "task", todowrite: "todowrite",
};
export const toOpencodePermission = (tool: string) => TOOL_ALIASES[tool.toLowerCase().replace(/[^a-z]/g, "")] ?? tool.toLowerCase();

/** Rules are evaluated last-match-wins by opencode, so specific allow/deny go after the level defaults. */
export function permissionRules(p: PermissionPolicy, mcpServerName = "uniqlaw"): PermissionRule[] {
  const r = (permission: string, action: PermissionRule["action"], pattern = "*"): PermissionRule => ({ permission, pattern, action });
  const rules: PermissionRule[] = [];
  const allowAll = p.level === "unrestricted" && p.approval.mode === "auto-allow";
  switch (p.level) {
    case "locked":
      rules.push(r("bash", "deny"), r("edit", "deny"), r("webfetch", "deny"), r("websearch", "deny"), r("task", "deny"));
      break;
    case "strict":
      rules.push(r("bash", "deny"), r("webfetch", "deny"), r("websearch", "deny"), r("edit", "ask"));
      break;
    case "moderate":
      rules.push(r("bash", "ask"), r("edit", "ask"), r("webfetch", "ask"), r("websearch", "ask"));
      break;
    case "unrestricted":
      rules.push(...(allowAll ? [r("*", "allow")] : [r("bash", "ask"), r("edit", "ask"), r("webfetch", "ask")]));
      break;
  }
  if (p.level !== "unrestricted" || !allowAll) {
    // Leaving the project dir needs approval (or is denied when locked).
    rules.push(r("external_directory", p.level === "locked" ? "deny" : "ask"));
  }
  for (const t of p.allowTools) rules.push(r(toOpencodePermission(t), "allow"));
  for (const t of p.denyTools) rules.push(r(toOpencodePermission(t), "deny"));
  // UniQlaw bus tools never need approval (they are the agent's own control plane).
  rules.push(r(`${mcpServerName}_*`, "allow"));
  return rules;
}

export function parseModel(model: string | undefined, fallbackProvider = "opencode"): { providerID: string; modelID: string } | undefined {
  if (!model) return undefined;
  const i = model.indexOf("/");
  return i > 0 ? { providerID: model.slice(0, i), modelID: model.slice(i + 1) } : { providerID: fallbackProvider, modelID: model };
}

/** opencode error object → turn_end.error code (typed when recognisable). */
export function errorCode(err: unknown): string {
  const e = (err ?? {}) as { name?: string; data?: { message?: string; statusCode?: number; isRetryable?: boolean } };
  const msg = `${e.name ?? ""} ${e.data?.message ?? ""} ${typeof err === "string" ? err : ""}`;
  if (e.data?.statusCode === 429 || /rate.?limit|too many requests|429/i.test(msg)) return "rate_limit";
  if (/quota|usage limit|insufficient.?(credit|balance|funds)|billing/i.test(msg)) return "usage_limit";
  if (e.name === "ProviderAuthError" || e.data?.statusCode === 401 || /unauthori[sz]ed|invalid api key|auth/i.test(msg)) return "auth";
  return (e.data?.message ?? e.name ?? JSON.stringify(err ?? "error")).slice(0, 300);
}

export interface IsolationOptions {
  stateDir: string;
  /** Load the user's ~/.config/opencode (MCP servers, agents, plugins, …). Default true (false with an alternate-account home). */
  userConfig: boolean;
  /** Use the user's ~/.local/share/opencode (provider logins, session history). Default true (false with an alternate-account home). */
  userData: boolean;
}

/** Stable per-credential home so sessions persist across serve restarts (resume). */
export function homeFor(stateDir: string, cred: ResolvedCredential | undefined): string {
  if (cred?.kind === "provider-login" && cred.home) return cred.home;
  const key = cred ? createHash("sha256").update(JSON.stringify({ kind: cred.kind, ...("baseUrl" in cred ? { b: cred.baseUrl } : {}) })).digest("hex").slice(0, 10) : "default";
  return join(stateDir, "opencode", key);
}

/** env for one `opencode serve` (never the daemon's full env). */
export function serveEnv(spec: SessionSpec, cred: ResolvedCredential | undefined, iso: IsolationOptions, configContent: object): Record<string, string> {
  const base: Record<string, string> = {};
  for (const k of ["PATH", "HOME", "LANG", "USER", "TMPDIR", "TERM", "XDG_CACHE_HOME"]) if (process.env[k]) base[k] = process.env[k]!;
  const home = homeFor(iso.stateDir, cred);
  const env: Record<string, string> = {
    ...base, ...spec.env, ...(cred ? envFor(cred) : {}),
    OPENCODE_CONFIG_CONTENT: JSON.stringify(configContent),
    OPENCODE_DISABLE_AUTOUPDATE: "1",
  };
  if (!iso.userData) {
    // Sessions + auth live here (stable per credential → resume across serve restarts).
    env.XDG_DATA_HOME = join(home, "data");
    env.XDG_STATE_HOME = join(home, "state");
  }
  if (!iso.userConfig) env.XDG_CONFIG_HOME = join(home, "config");
  return env;
}

export function configContent(spec: SessionSpec, model?: string): object {
  const cfg: Record<string, unknown> = {
    $schema: "https://opencode.ai/config.json",
    autoupdate: false,
    share: "disabled",
    permission: Object.fromEntries(permissionRules(spec.profile.permissions).filter((r) => r.pattern === "*" && !r.permission.includes("*")).map((r) => [r.permission, r.action])),
  };
  if (model) cfg.model = model;
  if (spec.mcp) cfg.mcp = { uniqlaw: { type: "remote", url: spec.mcp.url, enabled: true, oauth: false } };
  return cfg;
}
