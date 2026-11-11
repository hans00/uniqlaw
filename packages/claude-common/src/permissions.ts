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
  /** SessionSpec.isolated (see ISOLATED_CLI_ARGS): replaces the --tools / --strict-mcp-config the profile level and
   *  tool policy would set. */
  isolated?: boolean;
}

const LOCKED_TOOLS = ["Read", "Grep", "Glob"];

/** Built-in tools to keep (undefined = Claude Code's default set) and to deny, from the profile's permission level
 *  and the channel's tool policy. Any channel policy also cuts every MCP server but UniQlaw's (strictMcp): the user's
 *  own servers (browser automation, mail, …) belong to no tool group, so neither mode can grant them. */
export function claudeToolSets(p: PermissionPolicy, policy?: ToolPolicy): { tools?: string[]; deny: string[]; strictMcp: boolean } {
  const deny = new Set<string>([...NATIVE_CROSS_SESSION_TOOLS, ...p.denyTools]);
  let tools: string[] | undefined = p.level === "locked" ? [...LOCKED_TOOLS] : undefined;
  if (p.level === "strict") for (const t of ["Bash", "WebSearch", "WebFetch"]) deny.add(t);
  if (policy) {
    const l = claudeToolLists(policy);
    for (const t of l.disallowed) deny.add(t);
    if (l.tools) tools = tools ? tools.filter((t) => l.tools!.includes(t)) : l.tools;
  }
  return { ...(tools ? { tools } : {}), deny: [...deny], strictMcp: !!policy };
}

/** SessionSpec.isolated → claude CLI flags: no built-in tools at all, no settings files (so no CLAUDE.md, hooks,
 *  skills, plugins or `permissions.allow` from the operator's user/project/local settings), and no MCP server but
 *  the one given with --mcp-config (UniQlaw's). Native memory is turned off separately (nativeMemoryArgs(false)).
 *  Checked against claude 2.1.322: `--setting-sources ""` loads no CLAUDE.md and no user plugins/MCP servers. */
export const ISOLATED_CLI_ARGS = ["--tools", "", "--setting-sources", "", "--strict-mcp-config"];

/** The same for the Agent SDK (claude-sdk) query options. */
export const ISOLATED_SDK_OPTIONS = { tools: [] as string[], settingSources: [] as [], strictMcpConfig: true } as const;

export function buildPermissionArgs(p: PermissionPolicy, o: PermissionArgsOptions = {}): string[] {
  const args: string[] = ["--permission-mode", permissionModeFor(p, o.modeOverride)];
  const sets = claudeToolSets(p, o.toolPolicy);
  const allow = new Set<string>([...p.allowTools, ...(o.extraAllowed ?? [])]);
  if (o.isolated) args.push(...ISOLATED_CLI_ARGS); // no built-in tools whatever the level or policy would keep
  else {
    if (sets.tools) args.push("--tools", sets.tools.join(","));
    if (sets.strictMcp) args.push("--strict-mcp-config");
  }
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

/** Claude Code `PermissionRequest` HTTP hook to the approval judge (docs §10.4). Checked on claude 2.1.322: fires in
 *  `default` mode only when a dialog would be shown, gets `tool_name` / `tool_input` / `cwd` / `permission_mode`;
 *  `{}`, an error or an unreachable URL fall through to the dialog; an allow is not remembered. Hooks from
 *  `--settings` also apply under `--setting-sources ""`, but `disableAllHooks: true` in any settings layer turns
 *  it off (requests then reach the operator through the dialog as before). */
export function permissionHookSettings(url: string, timeoutSec: number) {
  return { hooks: { PermissionRequest: [{ matcher: "*", hooks: [{ type: "http", url, timeout: timeoutSec }] }] } };
}

/** The one `--settings` flag of a claude-tmux launch: native memory off and/or the permission hook (claude takes
 *  a single `--settings`). Without a hook it is exactly nativeMemoryArgs. */
export function claudeSettingsArgs(o: { nativeMemory: boolean | undefined; permissionHook?: { url: string; timeoutSec: number } }): string[] {
  if (!o.permissionHook) return nativeMemoryArgs(o.nativeMemory);
  return ["--settings", JSON.stringify({ ...(o.nativeMemory === false ? NO_NATIVE_MEMORY_SETTINGS : {}),
    ...permissionHookSettings(o.permissionHook.url, o.permissionHook.timeoutSec) })];
}
/** SDK `settings` option for SessionSpec.nativeMemory (claude-sdk). */
export function nativeMemorySettings(nativeMemory: boolean | undefined): { settings?: { autoMemoryEnabled: false; autoDreamEnabled: false } } {
  return nativeMemory === false ? { settings: { ...NO_NATIVE_MEMORY_SETTINGS } } : {};
}
