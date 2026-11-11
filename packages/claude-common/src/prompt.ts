// SystemPromptParts → --append-system-prompt text.
import type { SystemPromptParts, PermissionPolicy } from "@uniqlaw/core";
import { dirScopePrompt } from "./permissions.ts";

export const MCP_SERVER_NAME = "uniqlaw";

export function mcpToolId(tool: string): string {
  return `mcp__${MCP_SERVER_NAME}__${tool}`;
}

export interface ComposeOptions {
  parts: SystemPromptParts;
  permissions?: PermissionPolicy;
  cwd: string;
  /** Gateway tool names; listed so deferred tool loading can't hide them. */
  mcpToolNames?: string[];
  /** SessionSpec.isolated: no path-bearing dir-scope text (core already adds a path-free scope instruction). */
  isolated?: boolean;
}

export function composeAppendSystemPrompt(o: ComposeOptions): string {
  const out: string[] = [];
  for (const f of o.parts.fragments) if (f.text.trim()) out.push(f.text.trim());
  if (o.permissions && o.permissions.level !== "unrestricted" && !o.isolated) {
    out.push(dirScopePrompt(o.permissions.dirScope?.length ? o.permissions.dirScope : [o.cwd]));
  }
  if (o.mcpToolNames?.length) {
    out.push([
      "## UniQlaw tools",
      `These tools come from the MCP server "${MCP_SERVER_NAME}" and are always available. Call them directly by name:`,
      ...o.mcpToolNames.map((t) => `- ${mcpToolId(t)}`),
      "For talking to other agents/sessions, ALWAYS use these tools — never any built-in cross-session messaging.",
    ].join("\n"));
  }
  return out.join("\n\n");
}
