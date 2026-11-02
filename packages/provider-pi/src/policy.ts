// PermissionPolicy → pi tool exclusion + per-call gate decisions (docs §10).
import type { PermissionPolicy } from "@uniqlaw/core";

/** pi built-in tools that never modify anything. */
export const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);

/** Built-in tools removed from the session entirely, per security level. */
export function excludedTools(p: PermissionPolicy): string[] {
  const out = new Set<string>();
  if (p.level === "locked") for (const t of ["bash", "edit", "write"]) out.add(t);
  if (p.level === "strict") out.add("bash");
  // Exact (non-glob) deny entries can be removed up front; globs are enforced by the gate.
  for (const d of p.denyTools) if (!d.includes("*")) out.add(d.toLowerCase());
  return [...out];
}

function matches(pattern: string, tool: string): boolean {
  const p = pattern.toLowerCase(), t = tool.toLowerCase();
  if (!p.includes("*")) return p === t;
  const re = new RegExp(`^${p.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
  return re.test(t);
}

export type GateDecision = { action: "allow" } | { action: "deny"; reason: string } | { action: "ask" };

/** Decide without asking where the policy already answers. */
export function decide(p: PermissionPolicy, tool: string, isBusTool: boolean): GateDecision {
  if (isBusTool) return { action: "allow" };
  if (p.denyTools.some((d) => matches(d, tool))) return { action: "deny", reason: `${tool} is denied by policy` };
  if (p.level === "locked" && !READ_ONLY_TOOLS.has(tool.toLowerCase())) return { action: "deny", reason: `${tool} is not allowed at security level "locked"` };
  if (p.allowTools.some((a) => matches(a, tool))) return { action: "allow" };
  if (READ_ONLY_TOOLS.has(tool.toLowerCase())) return { action: "allow" };
  if (p.approval.mode === "auto-allow") return { action: "allow" };
  if (p.approval.mode === "auto-deny") return { action: "deny", reason: `${tool} needs approval and the policy auto-denies` };
  return { action: "ask" };
}

/** One-line summary of a tool call for the approval prompt. */
export function summarize(tool: string, input: unknown): string {
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    for (const k of ["command", "path", "file_path", "url", "pattern", "query"]) {
      if (typeof o[k] === "string" && o[k]) return `${tool}: ${String(o[k]).slice(0, 300)}`;
    }
  }
  return tool;
}
