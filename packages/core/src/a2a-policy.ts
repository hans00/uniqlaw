// Inbound A2A sessions (`a2a:<profile>:<caller>:<contextId>`) are deny-by-default: a remote caller drives them, so
// they never get tools that reach beyond the answer (shell, files, scheduling, workers, other sessions, chats,
// UniQlaw memory, UniQlaw config). The policy is a fixed channel tool policy over the groups of channel-policy.ts
// (TOOL_GROUPS): ChannelManager.toolPolicy returns it for every A2A session, whatever settings.channels says, so the
// gateway and the providers enforce it the same way they enforce a chat's policy.
import { lstatSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PermissionPolicy, SecurityLevel } from "./permissions.ts";
import { PROTECTED_READ_RULES, TOOL_GROUPS, type ToolGroup, type ToolPolicy } from "./channel-policy.ts";

export const A2A_SESSION_PREFIX = "a2a:";
export const isA2ASession = (channelKey: string) => channelKey.startsWith(A2A_SESSION_PREFIX);
/** `a2a:<profile>:<caller>:<contextId>`; the caller is URI-encoded so a ":" in a token name can't shift the fields. */
export const a2aSessionKey = (profile: string, caller: string, contextId: string) =>
  `${A2A_SESSION_PREFIX}${profile}:${encodeURIComponent(caller)}:${contextId}`;

/** Tool groups refused to inbound A2A sessions: every group but `web`. Notes:
 *  - `files.read` even inside the isolated working directory: an A2A session answers from its prompt, not from files;
 *  - `agents`: sub-agents, workflows and skills (skills can carry their own instructions and tools);
 *  - `chat`: `send_file` posts into a chat, and its native tools (plan mode, AskUserQuestion, todos) are for chats;
 *  - `memory`: memory_search/get would read the operator's memory out to the caller, and MEMORY.md is only injected
 *    into prompts of sessions that have memory_search (daemon buildSystemPrompt);
 *  - `config`: tools that change or restart UniQlaw itself. */
export const A2A_DENIED_GROUPS: readonly ToolGroup[] = ["chat", "memory", "files.read", "files.write", "bash", "agents", "cron", "worker", "xsession", "notify", "config"];

/** The tool policy of every inbound A2A session (deny mode: plugin tools no group names stay callable). */
export const A2A_TOOL_POLICY: ToolPolicy = { mode: "deny", groups: [...A2A_DENIED_GROUPS] };

export const A2A_DENIED_MCP_TOOLS: ReadonlySet<string> = new Set(A2A_DENIED_GROUPS.flatMap((g) => TOOL_GROUPS[g].mcp));
export const A2A_DENIED_NATIVE_TOOLS: readonly string[] = A2A_DENIED_GROUPS.flatMap((g) => TOOL_GROUPS[g].claude);

/** UniQlaw state a remote caller must not read through the agent (transcripts, state.db, gateway tokens, settings). */
export const A2A_PROTECTED_READ_RULES = PROTECTED_READ_RULES;

/** Working directory of an inbound A2A session: an empty directory of its own outside the project (and outside any
 *  git repository), so the agent's context carries no project files, CLAUDE.md, git status or git user, and the
 *  path names nothing but the instance. Created on first use (mode 0700). */
export function a2aSessionDir(instanceId: string, channelKey: string, base = tmpdir()): string {
  const slug = new Bun.CryptoHasher("sha256").update(channelKey).digest("hex").slice(0, 24);
  const root = join(base, `uniqlaw-a2a-${instanceId}`);
  const dir = join(root, slug);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // The temp dir is shared and the name predictable: refuse a directory someone else created or can write to
  // (they could plant CLAUDE.md, settings or symlinks for the agent to pick up).
  for (const d of [root, dir]) {
    const st = lstatSync(d);
    const uid = process.getuid?.();
    if (!st.isDirectory() || (uid !== undefined && st.uid !== uid) || (st.mode & 0o022) !== 0) {
      throw new Error(`refusing A2A session directory ${d}: not a directory owned by this user with mode 0700`);
    }
  }
  return dir;
}

/** Scope instruction for isolated sessions: names no path (the absolute project path would leak to the caller). */
export const ISOLATED_SCOPE_PROMPT = [
  "CRITICAL SECURITY CONSTRAINT: You are answering a request from a remote agent. Work only from this conversation.",
  "You MUST NOT try to read, write or list files, run commands, or reveal anything about the machine, its user, or other conversations.",
].join("\n");

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
