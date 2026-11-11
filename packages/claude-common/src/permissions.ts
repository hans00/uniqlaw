// PermissionPolicy → claude CLI flags. Port of v2 buildSecurityArgs with two
// M0 rules: ALWAYS pin --permission-mode (user settings may say "auto"), and
// ALWAYS disallow the native cross-session tools.
import { claudeToolLists, type PermissionPolicy, type ToolPolicy } from "@uniqlaw/core";

export const NATIVE_CROSS_SESSION_TOOLS = ["ListAgents", "SendMessage"];

export type ClaudePermissionMode = "acceptEdits" | "auto" | "bypassPermissions" | "manual" | "dontAsk" | "plan" | "default";

export function permissionModeFor(p: PermissionPolicy, override?: string): ClaudePermissionMode {
  if (override) return override as ClaudePermissionMode;
  switch (p.approval.mode) {
    // v2 parity: moderate runs Claude Code's auto mode (routine actions approved by its classifier);
    // whatever still raises a dialog goes to the operator. Other levels prompt for everything.
    case "ask-operator": return p.level === "moderate" ? "auto" : "default";
    case "auto-deny": return "dontAsk";
    case "auto-allow": return p.level === "unrestricted" ? "bypassPermissions" : "auto";
  }
}

export interface PermissionArgsOptions {
  /** Extra tools always allowed (e.g. the UniQlaw MCP server). */
  extraAllowed?: string[];
  /** profile.options.permissionMode override. */
  modeOverride?: string;
  /** Channel capabilities (SessionSpec.toolPolicy). */
  toolPolicy?: ToolPolicy;
}

const LOCKED_TOOLS = ["Read", "Grep", "Glob"];

/** Built-in tools to keep (undefined = Claude Code's default set) and to deny, from the profile's permission level
 *  and the channel's tool policy. Allow-mode policies also cut every MCP server but UniQlaw's (strictMcp). */
export function claudeToolSets(p: PermissionPolicy, policy?: ToolPolicy): { tools?: string[]; deny: string[]; strictMcp: boolean } {
  const deny = new Set<string>([...NATIVE_CROSS_SESSION_TOOLS, ...p.denyTools]);
  let tools: string[] | undefined = p.level === "locked" ? [...LOCKED_TOOLS] : undefined;
  if (p.level === "strict") for (const t of ["Bash", "WebSearch", "WebFetch"]) deny.add(t);
  if (policy) {
    const l = claudeToolLists(policy);
    for (const t of l.disallowed) deny.add(t);
    if (l.tools) tools = tools ? tools.filter((t) => l.tools!.includes(t)) : l.tools;
  }
  return { ...(tools ? { tools } : {}), deny: [...deny], strictMcp: policy?.mode === "allow" };
}

export function buildPermissionArgs(p: PermissionPolicy, o: PermissionArgsOptions = {}): string[] {
  const args: string[] = ["--permission-mode", permissionModeFor(p, o.modeOverride)];
  const sets = claudeToolSets(p, o.toolPolicy);
  const allow = new Set<string>([...p.allowTools, ...(o.extraAllowed ?? [])]);
  if (sets.tools) args.push("--tools", sets.tools.join(","));
  if (sets.strictMcp) args.push("--strict-mcp-config");
  if (allow.size) args.push("--allowedTools", [...allow].join(" "));
  args.push("--disallowedTools", sets.deny.join(" "));
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
