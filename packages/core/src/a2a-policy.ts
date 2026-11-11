// Inbound A2A sessions (`a2a:<profile>:<caller>:<contextId>`) are deny-by-default: a remote caller drives them, so
// they never get tools that reach beyond the answer (shell, file writes, scheduling, workers, other sessions,
// chats, UniQlaw memory). Group names match the channel tool-policy groups (TOOL_GROUPS in channel-policy.ts on
// the channel-policy work), so this table can become `{ mode: "deny", groups: A2A_DENIED_GROUPS }` there.
import type { PermissionPolicy, SecurityLevel } from "./permissions.ts";

export const A2A_SESSION_PREFIX = "a2a:";
export const isA2ASession = (channelKey: string) => channelKey.startsWith(A2A_SESSION_PREFIX);
/** `a2a:<profile>:<caller>:<contextId>`; the caller is URI-encoded so a ":" in a token name can't shift the fields. */
export const a2aSessionKey = (profile: string, caller: string, contextId: string) =>
  `${A2A_SESSION_PREFIX}${profile}:${encodeURIComponent(caller)}:${contextId}`;

/** Tool group → UniQlaw MCP gateway tools + provider-native (Claude Code) tools refused to inbound A2A sessions. */
export const A2A_DENIED_GROUPS = {
  bash: { mcp: [], native: ["Bash", "Monitor", "PowerShell", "TaskStop", "TaskOutput", "BashOutput", "KillShell", "KillBash"] },
  "files.write": { mcp: [], native: ["Write", "Edit", "MultiEdit", "NotebookEdit", "EnterWorktree", "ExitWorktree"] },
  cron: { mcp: ["cron_list", "cron_save", "cron_delete"], native: ["CronCreate", "CronDelete", "CronList", "ScheduleWakeup", "RemoteTrigger"] },
  worker: { mcp: ["worker_start", "worker_stop"], native: [] },
  xsession: { mcp: ["agents_list", "agent_ask", "agent_trigger", "task_status"], native: ["SendToProject", "SendToProjectContext", "ListAgents", "SendMessage"] },
  notify: { mcp: ["notify", "send_file"], native: ["PushNotification", "Artifact", "ArtifactData", "ArtifactComments", "DesignSync", "SendFeedback"] },
  // The operator's memory: memory_search/get would read it out to the caller, and MEMORY.md is only injected
  // into prompts of sessions that have memory_search (daemon buildSystemPrompt).
  memory: { mcp: ["memory_write", "memory_search", "memory_get"], native: [] },
} as const satisfies Record<string, { mcp: readonly string[]; native: readonly string[] }>;

export type A2ADeniedGroup = keyof typeof A2A_DENIED_GROUPS;

export const A2A_DENIED_MCP_TOOLS: ReadonlySet<string> = new Set(Object.values(A2A_DENIED_GROUPS).flatMap((g) => g.mcp));
export const A2A_DENIED_NATIVE_TOOLS: readonly string[] = Object.values(A2A_DENIED_GROUPS).flatMap((g) => g.native);

/** UniQlaw state a remote caller must not read through the agent (transcripts, state.db, gateway tokens, settings). */
export const A2A_PROTECTED_READ_RULES = ["Read(./.uniqlaw/**)", "Grep(./.uniqlaw/**)", "Glob(./.uniqlaw/**)"];

const ORDER: SecurityLevel[] = ["locked", "strict", "moderate", "unrestricted"];

/** The permissions an inbound A2A session runs with: at most "strict" (locked stays locked), plus the denied
 *  native tools and protected reads. Auto-allow is downgraded to ask-operator: no one but the operator approves. */
export function a2aPermissions(p: PermissionPolicy): PermissionPolicy {
  const level = ORDER.indexOf(p.level) > ORDER.indexOf("strict") ? "strict" : p.level;
  return {
    ...p,
    level,
    allowTools: p.allowTools.filter((t) => !A2A_DENIED_NATIVE_TOOLS.includes(t.replace(/\(.*$/, ""))),
    denyTools: [...new Set([...p.denyTools, ...A2A_DENIED_NATIVE_TOOLS, ...A2A_PROTECTED_READ_RULES])],
    approval: { ...p.approval, mode: p.approval.mode === "auto-allow" ? "ask-operator" : p.approval.mode },
  };
}
