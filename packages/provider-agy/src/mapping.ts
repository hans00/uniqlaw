// Pure mapping helpers for the agy adapter (unit-tested).
import type { PermissionPolicy, ProviderCapabilities } from "@uniqlaw/core";
import type { ResolvedCredential } from "@uniqlaw/credentials";
import { homedir } from "node:os";
import { join } from "node:path";

export const AGY_CAPABILITIES: ProviderCapabilities = {
  streaming: "token",
  interrupt: true,          // SIGINT + respawn with --conversation (slower than other providers)
  steer: false,             // a second stdin line is queued as its own turn
  resume: "native",         // --conversation <id>
  denyEndsTurn: false,      // headless auto-denies; the turn continues
  modelSwitch: "spawn",     // respawn with --model + --conversation
  permissionCallback: false,// no control channel on stdin; pre-allow via --settings
  mcp: "per-process",       // workspace .agents/mcp_config.json (+ stdio shim, identity via env)
  nativeTools: false,
  attachments: [],
  slashCommands: true,
};

/** Name of the MCP server the shim registers under (matches gateway prompts). */
export const MCP_SERVER_NAME = "uniqlaw";

/** Claude-style tool names → agy permission rules. Raw agy rules (`command(...)`, `read_file(...)`,
 *  `write_file(...)`, `url(...)`, `mcp(...)`) pass through unchanged. agy matches commands only
 *  exactly or with `command(*)` — prefix globs like `command(git *)` do not match (M0). */
export function toAgyRule(tool: string): string | undefined {
  const t = tool.trim();
  if (/^(command|read_file|write_file|url|mcp|custom)\(.*\)$/.test(t)) return t;
  const m = t.match(/^(\w+)(?:\((.*)\))?$/);
  if (!m) return undefined;
  const [, name, arg] = m;
  switch (name!.toLowerCase()) {
    case "bash": case "shell": case "command": return `command(${arg ?? "*"})`;
    case "read": case "glob": case "grep": return `read_file(${arg ?? "*"})`;
    case "write": case "edit": case "multiedit": return `write_file(${arg ?? "*"})`;
    case "webfetch": return `url(${arg ?? "*"})`;
    default: return undefined;
  }
}

export interface PermissionArgs {
  /** `--settings` JSON (permissions.allow / deny). */
  settings: { permissions: { allow: string[]; deny?: string[] } };
  /** Extra CLI flags (e.g. --dangerously-skip-permissions, --mode plan). */
  flags: string[];
  /** Tools the policy wanted that have no agy equivalent (reported, not enforced). */
  unmapped: string[];
}

/** PermissionPolicy → agy flags. agy cannot ask an operator in headless mode, so
 *  "ask-operator" degrades to: pre-allowed list + everything else auto-denied (reported). */
export function permissionArgs(p: PermissionPolicy): PermissionArgs {
  const allow = new Set<string>([`mcp(${MCP_SERVER_NAME}/*)`]); // bus tools always reachable
  const unmapped: string[] = [];
  for (const t of p.allowTools) { const r = toAgyRule(t); if (r) allow.add(r); else unmapped.push(t); }
  const deny: string[] = [];
  for (const t of p.denyTools) { const r = toAgyRule(t); if (r) deny.push(r); else unmapped.push(t); }
  const flags: string[] = [];
  if (p.approval.mode === "auto-allow") flags.push("--dangerously-skip-permissions");
  if (p.level === "locked") flags.push("--mode", "plan");
  if (p.level === "strict") deny.push("command(*)", "url(*)");
  return { settings: { permissions: { allow: [...allow], ...(deny.length ? { deny } : {}) } }, flags, unmapped };
}

/** Credential → agy env. `provider-login` → isolated HOME (config + conversations only:
 *  the account token lives in the user keyring, so HOME does NOT isolate the login — M3 finding). */
export function credentialEnv(c: ResolvedCredential | undefined, defaultHome?: string, realHome: string = homedir()): { env: Record<string, string>; warnings: string[] } {
  const warnings: string[] = [];
  if (!c) return { env: defaultHome ? { HOME: defaultHome } : {}, warnings };
  const home: Record<string, string> = defaultHome ? { HOME: defaultHome } : {};
  switch (c.kind) {
    case "gemini-api-key":
      // agy: AUTH_MODE_GEMINI_API_KEY via GEMINI_API_KEY. GOOGLE_API_KEY would win ("Both GOOGLE_API_KEY
      // and GEMINI_API_KEY are set. Using GOOGLE_API_KEY.") and AGY_ADC_AUTH would switch to ADC sign-in,
      // so neither may be present — the spawn env is built from scratch, never inherited.
      return { env: { GEMINI_API_KEY: c.key, ...home }, warnings };
    case "gcp": {
      // agy ADC sign-in ("Agent Platform"): AGY_ADC_AUTH set; project + location from GOOGLE_CLOUD_PROJECT /
      // GOOGLE_CLOUD_LOCATION (or settings.json gcp.project / gcp.location); credentials from
      // GOOGLE_APPLICATION_CREDENTIALS or the gcloud default ADC file. See CONTRACT-NOTES.md for the quotes.
      if (c.impersonate) throw new Error("agy does not document service-account impersonation for ADC sign-in; create an impersonated ADC file (gcloud auth application-default login --impersonate-service-account=…) and set gcp.serviceAccountFile");
      // We override HOME for isolation, which would hide ~/.config/gcloud/application_default_credentials.json;
      // point at the user's default ADC file explicitly (path only — never read here).
      const adc = c.serviceAccountFile ?? join(realHome, ".config", "gcloud", "application_default_credentials.json");
      return { env: { AGY_ADC_AUTH: "1", GOOGLE_CLOUD_PROJECT: c.project, GOOGLE_CLOUD_LOCATION: c.location, GOOGLE_APPLICATION_CREDENTIALS: adc, ...home }, warnings };
    }
    case "provider-login":
      if (c.home) return { env: { HOME: c.home }, warnings: ["agy keeps its login in the user keyring: a separate HOME isolates config/history, not the account"] };
      return { env: home, warnings };
    default:
      throw new Error(`agy does not support credential kind "${c.kind}" (use gemini-api-key, gcp or provider-login)`);
  }
}

/** stderr `AGY_ERROR: {...}` → typed turn_end.error code. */
export function errorCodeFromStderr(line: string): string | undefined {
  const i = line.indexOf("AGY_ERROR:");
  if (i < 0) return undefined;
  let info: Record<string, unknown> = {};
  try { info = JSON.parse(line.slice(i + "AGY_ERROR:".length).trim()); } catch { return "crash"; }
  const blob = JSON.stringify(info).toLowerCase();
  if (/unauthenticated|permission_denied.*auth|sign.?in|login/.test(blob)) return "auth";
  if (/resource_exhausted|429|quota|rate/.test(blob)) {
    return info.retryable === false || /daily|spend cap|prepaid|exhausted daily/.test(blob) ? "usage_limit" : "rate_limit";
  }
  return typeof info.message === "string" ? info.message : "crash";
}

export interface DeniedAction { action: string; display_name?: string }

export function deniedNote(denied: DeniedAction[]): string {
  const list = denied.map((d) => d.display_name ? `${d.display_name} (${d.action})` : d.action).join(", ");
  return `⚠️ Blocked by the permission policy (agy cannot ask for approval in headless mode): ${list}. Add a matching rule to the profile's permissions.allowTools to allow it.`;
}
