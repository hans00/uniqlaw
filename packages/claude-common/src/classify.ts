// Classifiers for user-role jsonl text Claude Code writes on its own.

/** Tool permission denied (dialog "No" or Esc on a tool). */
export function isRejectionText(text: string): boolean {
  return /doesn't want to proceed with this tool use/i.test(text)
    || /\buser rejected\b/i.test(text)
    || /Request interrupted by user for tool use/i.test(text);
}

/** Plain interrupt (Esc mid-stream), not a tool rejection. */
export function isInterruptMarker(text: string): boolean {
  return /^\s*\[Request interrupted by user\]\s*$/i.test(text);
}

/** Native cross-session message wrapper (should never appear — tools disabled — but detect it). */
export function isCrossSessionMessage(text: string): boolean {
  return /Another Claude session sent a message:/i.test(text) || /<cross-session-message\s+from=/i.test(text);
}

export type InternalClassification =
  | { kind: "none" }
  | { kind: "model-switch"; model?: string }
  | { kind: "context-report"; forward: string }
  | { kind: "command-stdout"; forward: string | null }
  | { kind: "command-meta" };

const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
export const stripAnsi = (s: string) => s.replace(ANSI_RE, "");

export function classifyInternalOutput(text: string): InternalClassification {
  const t = text.trimStart();
  if (t.startsWith("## Context Usage")) return { kind: "context-report", forward: t };
  const wrapped = t.match(/^<local-command-stdout>([\s\S]*?)<\/local-command-stdout>\s*$/);
  if (wrapped) {
    const inner = stripAnsi(wrapped[1]).trim();
    const m = inner.match(/^set model to\s+(.+)$/i);
    if (m) return { kind: "model-switch", model: m[1].replace(/\s*\(.*\)\s*$/, "").trim() };
    return { kind: "command-stdout", forward: inner || null };
  }
  if (/^<(command-name|command-message|command-args|local-command-caveat)>/.test(t)) return { kind: "command-meta" };
  return { kind: "none" };
}
