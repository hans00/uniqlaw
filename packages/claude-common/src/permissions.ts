// PermissionPolicy → claude CLI flags. Port of v2 buildSecurityArgs with two
// M0 rules: ALWAYS pin --permission-mode (user settings may say "auto"), and
// ALWAYS disallow the native cross-session tools.
import type { PermissionPolicy } from "@uniqlaw/core";

export const NATIVE_CROSS_SESSION_TOOLS = ["ListAgents", "SendMessage"];

export type ClaudePermissionMode = "acceptEdits" | "auto" | "bypassPermissions" | "manual" | "dontAsk" | "plan" | "default";

export function permissionModeFor(p: PermissionPolicy, override?: string): ClaudePermissionMode {
  if (override) return override as ClaudePermissionMode;
  switch (p.approval.mode) {
    case "ask-operator": return "default";
    case "auto-deny": return "dontAsk";
    case "auto-allow": return p.level === "unrestricted" ? "bypassPermissions" : "auto";
  }
}

export interface PermissionArgsOptions {
  /** Extra tools always allowed (e.g. the UniQlaw MCP server). */
  extraAllowed?: string[];
  /** profile.options.permissionMode override. */
  modeOverride?: string;
}

export function buildPermissionArgs(p: PermissionPolicy, o: PermissionArgsOptions = {}): string[] {
  const args: string[] = ["--permission-mode", permissionModeFor(p, o.modeOverride)];
  const deny = new Set<string>([...NATIVE_CROSS_SESSION_TOOLS, ...p.denyTools]);
  const allow = new Set<string>([...p.allowTools, ...(o.extraAllowed ?? [])]);
  switch (p.level) {
    case "locked": args.push("--tools", "Read,Grep,Glob"); break;
    case "strict": for (const t of ["Bash", "WebSearch", "WebFetch"]) deny.add(t); break;
    case "moderate": case "unrestricted": break;
  }
  if (allow.size) args.push("--allowedTools", [...allow].join(" "));
  args.push("--disallowedTools", [...deny].join(" "));
  return args;
}

export function dirScopePrompt(dirs: string[]): string {
  return [
    `CRITICAL SECURITY CONSTRAINT: You are scoped to: ${dirs.join(", ")}`,
    "You MUST NOT read, write, edit, or delete any file outside these directories.",
    "You MUST NOT run bash commands that modify anything outside them (no cd /, no /etc, no ~/, no ../.. escapes).",
    "If a request requires accessing files outside, refuse and explain why.",
  ].join("\n");
}

/** Claude Code settings that turn off its own memory when UniQlaw memory is in use
 *  (SessionSpec.nativeMemory === false): auto-memory files and background auto-dream. */
export const NO_NATIVE_MEMORY_SETTINGS = { autoMemoryEnabled: false, autoDreamEnabled: false } as const;

/** CLI flags for SessionSpec.nativeMemory (claude-tmux). */
export function nativeMemoryArgs(nativeMemory: boolean | undefined): string[] {
  return nativeMemory === false ? ["--settings", JSON.stringify(NO_NATIVE_MEMORY_SETTINGS)] : [];
}
/** SDK `settings` option for SessionSpec.nativeMemory (claude-sdk). */
export function nativeMemorySettings(nativeMemory: boolean | undefined): { settings?: { autoMemoryEnabled: false; autoDreamEnabled: false } } {
  return nativeMemory === false ? { settings: { ...NO_NATIVE_MEMORY_SETTINGS } } : {};
}
