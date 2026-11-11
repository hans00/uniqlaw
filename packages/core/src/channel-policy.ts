// Per-channel capabilities (settings.channels): which tool groups a chat's session gets. The one mapping
// table from tool group → concrete tools lives here; the MCP gateway filters its tools with it and providers
// that declare `toolPolicy` translate SessionSpec.toolPolicy into their own flags (claude-common for Claude Code).
import type { ChannelPolicyConfig, Settings } from "./config.ts";
import { TOOL_GROUP_NAMES } from "./config.ts";

export type ToolGroup = (typeof TOOL_GROUP_NAMES)[number];

export interface ToolGroupDef {
  /** UniQlaw MCP gateway tools (core + plugin tools). */
  mcp: string[];
  /** Claude Code built-in tool names. */
  claude: string[];
}

// Claude Code names checked against claude 2.1.322 (stream-json init event, `--tools` probe). `--tools` ignores
// unknown names, so names from other versions/platforms (PowerShell, BashOutput, …) are listed too: in deny mode
// they must be caught whatever the installed version calls them.
export const TOOL_GROUPS: Record<ToolGroup, ToolGroupDef> = {
  chat: { mcp: ["send_file"], claude: ["TaskCreate", "TaskGet", "TaskList", "TaskUpdate", "TodoWrite", "ToolSearch",
    "AskUserQuestion", "EnterPlanMode", "ExitPlanMode", "ReportFindings"] },
  memory: { mcp: ["memory_write", "memory_search", "memory_get"], claude: [] },
  web: { mcp: [], claude: ["WebSearch", "WebFetch"] },
  "files.read": { mcp: [], claude: ["Read", "Grep", "Glob", "LSP", "NotebookRead"] },
  "files.write": { mcp: [], claude: ["Write", "Edit", "MultiEdit", "NotebookEdit", "EnterWorktree", "ExitWorktree"] },
  // Anything that runs code or shell commands.
  bash: { mcp: [], claude: ["Bash", "Monitor", "PowerShell", "TaskStop", "TaskOutput", "BashOutput", "KillShell", "KillBash"] },
  // Sub-agents and skills (they run with the same tool set as the session).
  agents: { mcp: [], claude: ["Task", "Agent", "Workflow", "Skill"] },
  // Scheduling: UniQlaw cron plus Claude Code's own schedulers / remote agents.
  cron: { mcp: ["cron_list", "cron_save", "cron_delete"], claude: ["CronCreate", "CronDelete", "CronList", "ScheduleWakeup", "RemoteTrigger"] },
  worker: { mcp: ["worker_start", "worker_stop"], claude: [] },
  // Talking to other sessions (ListAgents / SendMessage are always disallowed by claude-common).
  xsession: { mcp: ["agents_list", "agent_ask", "agent_trigger", "task_status"], claude: ["SendToProject", "SendToProjectContext", "ListAgents", "SendMessage"] },
  // Reaching people outside this chat: other chats, push notifications, published pages.
  notify: { mcp: ["notify"], claude: ["PushNotification", "Artifact", "ArtifactData", "ArtifactComments", "DesignSync", "SendFeedback"] },
  // Reserved for tools that change UniQlaw's own settings; none exist yet.
  config: { mcp: [], claude: [] },
};

/** Groups that let a restricted chat reach an unrestricted session or UniQlaw's own config (a cron job in its own
 *  session, a worker, another chat's session, or files such as .uniqlaw/jobs, .uniqlaw/settings.json and
 *  .claude/settings.json hooks): granting one is effectively granting full access. */
export const ADMIN_TOOL_GROUPS: readonly ToolGroup[] = ["bash", "files.write", "cron", "worker", "xsession"];

/** Files a restricted chat may not read even with files.read (UniQlaw state: transcripts, state.db, gateway
 *  tokens in claude-tmux mcp.json files, settings). Paths are relative to the session's cwd (the project dir). */
export const PROTECTED_READ_RULES = ["Read(./.uniqlaw/**)", "Grep(./.uniqlaw/**)", "Glob(./.uniqlaw/**)"];

/** Groups whose tools are the provider's own (enforced by the provider, not the gateway). */
const NATIVE_GROUPS = (Object.keys(TOOL_GROUPS) as ToolGroup[]).filter((g) => TOOL_GROUPS[g].claude.length > 0 && g !== "chat" && g !== "xsession");

/**
 * A session's tool policy, handed to the provider in SessionSpec.toolPolicy.
 *  - allow: only the tools of `groups` exist (every other native tool and MCP server is off);
 *  - deny: everything except the tools of `groups`.
 */
export interface ToolPolicy { mode: "allow" | "deny"; groups: ToolGroup[] }

/** Settings entry for a channel: exact key, then shorter prefixes (Slack thread → channel), then "defaults". */
function entryFor(channels: Settings["channels"], channelKey: string): ChannelPolicyConfig | undefined {
  const parts = channelKey.split(":");
  for (let n = parts.length; n >= 2; n--) {
    const e = channels[parts.slice(0, n).join(":")];
    if (e) return e;
  }
  return undefined;
}

/**
 * Effective policy for a chat channel. undefined = unrestricted (no entry and no "defaults": installs from before
 * settings.channels keep every tool). Missing fields of an entry fall back to "defaults", then to "*".
 */
export function resolveToolPolicy(channels: Settings["channels"], channelKey: string): ToolPolicy | undefined {
  return policyOf(entryFor(channels, channelKey), channels.defaults);
}

function policyOf(entry: ChannelPolicyConfig | undefined, defaults: ChannelPolicyConfig | undefined): ToolPolicy | undefined {
  if (!entry && !defaults) return undefined;
  const tools = entry?.tools ?? defaults?.tools ?? "*";
  const deny = new Set(entry?.deny ?? defaults?.deny ?? []);
  if (tools === "*") return deny.size ? { mode: "deny", groups: [...deny] } : undefined;
  return { mode: "allow", groups: tools.filter((g) => !deny.has(g)) };
}

/** May a session with this policy call this UniQlaw MCP tool? Unrestricted: yes. Allow mode: only tools a granted
 *  group names (plugin tools no group names are off). Deny mode: anything a denied group does not name. */
export function mcpToolAllowed(policy: ToolPolicy | undefined, tool: string): boolean {
  if (!policy) return true;
  const inGroups = policy.groups.some((g) => TOOL_GROUPS[g].mcp.includes(tool));
  return policy.mode === "allow" ? inGroups : !inGroups;
}

export function groupAllowed(policy: ToolPolicy | undefined, group: ToolGroup): boolean {
  if (!policy) return true;
  return policy.mode === "allow" ? policy.groups.includes(group) : !policy.groups.includes(group);
}

/** Does the policy need the provider to restrict its own (native) tools? */
export function restrictsNativeTools(policy: ToolPolicy | undefined): boolean {
  if (!policy) return false;
  return policy.mode === "allow" || policy.groups.some((g) => NATIVE_GROUPS.includes(g));
}

/** Claude Code flags for a policy: the built-in tools to keep (allow mode → `--tools`) and to disallow. Any
 *  restricted chat also loses read access to UniQlaw's state directory. */
export function claudeToolLists(policy: ToolPolicy): { tools?: string[]; disallowed: string[] } {
  const names = [...new Set(policy.groups.flatMap((g) => TOOL_GROUPS[g].claude))];
  return policy.mode === "allow" ? { tools: names, disallowed: [...PROTECTED_READ_RULES] } : { disallowed: [...names, ...PROTECTED_READ_RULES] };
}

/** Config-load warnings: restricted chats that are granted admin-level groups, and bare ids in the global
 *  groups.allowFrom (they match no one there: an id means different people on different platforms). */
export function channelPolicyWarnings(settings: Pick<Settings, "channels" | "groups">): string[] {
  const out: string[] = [];
  for (const [key, entry] of Object.entries(settings.channels)) {
    const policy = key === "defaults" ? policyOf(undefined, entry) : policyOf(entry, settings.channels.defaults);
    if (!policy) continue;
    const admin = ADMIN_TOOL_GROUPS.filter((g) => groupAllowed(policy, g));
    if (admin.length) {
      out.push(`channels.${key} restricts tools but grants ${admin.join(", ")}: these reach unrestricted sessions or UniQlaw's config, so this chat effectively has full access`);
    }
  }
  const bare = settings.groups.allowFrom.filter((a) => !a.includes(":"));
  if (bare.length) out.push(`groups.allowFrom: bare ids (${bare.join(", ")}) match no one in the global list; write them as "<platform>:<id>"`);
  return out;
}
