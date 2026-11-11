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

export const TOOL_GROUPS: Record<ToolGroup, ToolGroupDef> = {
  chat: { mcp: ["send_file"], claude: ["TodoWrite"] },
  memory: { mcp: ["memory_write", "memory_search", "memory_get"], claude: [] },
  web: { mcp: [], claude: ["WebSearch", "WebFetch"] },
  "files.read": { mcp: [], claude: ["Read", "Grep", "Glob"] },
  "files.write": { mcp: [], claude: ["Write", "Edit", "NotebookEdit"] },
  bash: { mcp: [], claude: ["Bash"] },
  cron: { mcp: ["cron_list", "cron_save", "cron_delete"], claude: [] },
  worker: { mcp: ["worker_start", "worker_stop"], claude: [] },
  xsession: { mcp: ["agents_list", "agent_ask", "agent_trigger", "task_status"], claude: [] },
  notify: { mcp: ["notify"], claude: [] },
  // Reserved for tools that change UniQlaw's own settings; none exist yet.
  config: { mcp: [], claude: [] },
};

/** Groups whose tools are the provider's own (enforced by the provider, not the gateway). */
const NATIVE_GROUPS = (Object.keys(TOOL_GROUPS) as ToolGroup[]).filter((g) => TOOL_GROUPS[g].claude.length > 0 && g !== "chat");

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
  const entry = entryFor(channels, channelKey);
  const defaults = channels.defaults;
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

/** Claude Code flags for a policy: the built-in tools to keep (allow mode → `--tools`) and to disallow. */
export function claudeToolLists(policy: ToolPolicy): { tools?: string[]; disallowed: string[] } {
  const names = policy.groups.flatMap((g) => TOOL_GROUPS[g].claude);
  return policy.mode === "allow" ? { tools: [...new Set(names)], disallowed: [] } : { disallowed: [...new Set(names)] };
}
