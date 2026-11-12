// Pane heuristics: readiness, busy state, startup prompts, transient API errors.
import type { Tmux } from "./tmux.ts";
import { hasReadyPrompt } from "./dialogs.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Ready = bordered `❯` input box (any permission mode), or the elevated-mode `⏵⏵` footer. */
export function isReady(pane: string): boolean {
  return hasReadyPrompt(pane) || (pane.includes("⏵⏵") && pane.includes("❯"));
}

/**
 * Claude is visibly working. CLI 2.1.316 shows `✻ Warping… (2s · ↓ 75 tokens)`
 * without "esc to interrupt" (M0 finding), so match the spinner shape too.
 */
export function looksActivelyBusy(pane: string): boolean {
  const tail = pane.split("\n").slice(-25).join("\n");
  return (
    /[✻✶✳✢✽✺·*◐◓◑◒]\s+\S[^\n]*…\s*\(\d+s/.test(tail) ||
    /[✻✶✳✢✽✺·*]\s+\S+…\s*\(/.test(tail) ||
    /Running\b[^\n]*[…\.]/.test(tail) ||
    /Compacting conversation/i.test(tail) ||
    /esc to interrupt/i.test(tail) ||
    /[↓↑]\s*[\d.,]+\s*k?\s*tokens/i.test(tail) ||
    /\(\d+m\s+\d+s[^)]*\)/.test(tail)
  );
}

/** The pane with what changes on its own while claude merely waits stripped out (spinner glyphs, elapsed time and
 *  token counters), so a changed fingerprint means real output moved (e.g. a tool streaming its output). */
export function normalizePaneForLiveness(pane: string): string {
  return pane.replace(/[\d✻✶✳✢✽✺·*◐◓◑◒⠀-⣿]/g, "").replace(/[ \t]+/g, " ");
}

/** Transient server error (rate limit/overload) — not the user's usage limit. */
export function isRecoverableApiError(pane: string): boolean {
  const tail = pane.split("\n").slice(-30).join("\n");
  if (!/API Error/i.test(tail)) return false;
  return /(temporarily limiting requests|rate limited|overloaded|too many requests|\b429\b|\b503\b|\b529\b|try again in a moment)/i.test(tail);
}

/** Usage/quota limit reached (not retryable). */
export function isUsageLimit(pane: string): boolean {
  const tail = pane.split("\n").slice(-30).join("\n");
  return /(usage limit reached|limit will reset|reached your .* limit)/i.test(tail) && !/not your usage limit/i.test(tail);
}

interface StartupPrompt {
  label: string;
  match(pane: string): boolean;
  respond(tmux: Tmux, name: string, pane: string): Promise<void>;
}

const downEnter = async (tmux: Tmux, name: string) => { await tmux.sendKeys(name, "Down"); await sleep(150); await tmux.sendKeys(name, "Enter"); };

export const STARTUP_PROMPTS: StartupPrompt[] = [
  { label: "bypass-permissions-warning",
    match: (p) => p.includes("Bypass Permissions mode") && p.includes("No, exit") && p.includes("Yes, I accept"),
    respond: downEnter },
  // New in M0: first launch in an untrusted cwd.
  { label: "folder-trust",
    match: (p) => /Yes, I trust this folder/.test(p) && /No, exit/.test(p),
    respond: async (t, n, pane) => {
      // Cursor may already be on "Yes" in some builds.
      if (/❯\s*\d\.\s*Yes, I trust/.test(pane)) await t.sendKeys(n, "Enter"); else await downEnter(t, n);
    } },
  { label: "compact-confirm", match: (p) => /Compact\?[\s\S]{0,40}\(y\/N\)/i.test(p),
    respond: async (t, n) => { await t.sendKeys(n, "y"); await sleep(100); await t.sendKeys(n, "Enter"); } },
  { label: "generic-continue", match: (p) => /Continue\?\s*\(y\/N\)/i.test(p), respond: async (t, n) => t.sendKeys(n, "Enter") },
  { label: "press-enter-to-continue", match: (p) => /Press Enter to continue/i.test(p), respond: async (t, n) => t.sendKeys(n, "Enter") },
];

export type InitResult =
  | { status: "ready"; pane: string }
  | { status: "login"; pane: string }
  | { status: "timeout"; pane: string }
  | { status: "dead"; pane: string };

/** Wait for the TUI to accept input, auto-answering known startup prompts. */
export async function waitForReady(tmux: Tmux, name: string, o: {
  timeoutMs?: number; onPrompt?: (label: string) => void; isLoginPane?: (pane: string) => boolean;
} = {}): Promise<InitResult> {
  const deadline = Date.now() + (o.timeoutMs ?? 90_000);
  let fp = "", stableSince = Date.now(), escSent = false, pane = "";
  while (Date.now() < deadline) {
    try { pane = await tmux.capture(name); } catch { return { status: "dead", pane }; }
    if (isReady(pane)) return { status: "ready", pane };
    if (await tmux.paneDead(name)) return { status: "dead", pane };
    if (o.isLoginPane?.(pane)) return { status: "login", pane };
    const prompt = STARTUP_PROMPTS.find((p) => p.match(pane));
    if (prompt) {
      o.onPrompt?.(prompt.label);
      await prompt.respond(tmux, name, pane);
      fp = ""; stableSince = Date.now(); escSent = false;
      await sleep(1000);
      continue;
    }
    const f = `${pane.length}:${pane.slice(-200)}`;
    if (f !== fp) { fp = f; stableSince = Date.now(); }
    else if (!escSent && Date.now() - stableSince > 15_000) { await tmux.sendKeys(name, "Escape").catch(() => {}); escSent = true; stableSince = Date.now(); }
    await sleep(400);
  }
  return { status: "timeout", pane };
}
