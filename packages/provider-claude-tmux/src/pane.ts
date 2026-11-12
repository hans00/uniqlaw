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
  /** Answer it. Returns false when nothing was sent (e.g. the cursor could not be placed): try again on a later poll. */
  respond(tmux: Tmux, name: string, pane: string, o?: MenuOptions): Promise<boolean>;
}

interface MenuOptions { keyDelayMs?: number }

/** A selectable option line of a TUI menu: `❯ 1. Yes`, `  2. No, exit`, `❯ Yes, I trust this folder`, `  No, exit`. */
const OPTION_LINE = /^\s*(❯)?\s*(?:\d+\.\s+)?(\S.*?)\s*$/;

/** The menu's option lines (index in the pane, text, cursor): the run of lines around the `❯` line that contains `target`. */
export function parseMenu(pane: string, target: RegExp): { options: { text: string; cursor: boolean }[]; target: number; cursor: number } | undefined {
  // Dialogs may be drawn in a box: drop its side borders so `│ ❯ 1. Yes │` reads as `❯ 1. Yes`.
  const lines = pane.split("\n").map((l) => l.replace(/^\s*[│┃|]/, "").replace(/[│┃|]\s*$/, ""));
  const ti = lines.findIndex((l) => target.test(l));
  if (ti < 0) return undefined;
  // Options are consecutive non-empty lines; take the block containing the target.
  let a = ti, b = ti;
  while (a > 0 && lines[a - 1]!.trim() && OPTION_LINE.test(lines[a - 1]!) && !/[─━]{3,}/.test(lines[a - 1]!)) a--;
  while (b < lines.length - 1 && lines[b + 1]!.trim() && !/[─━]{3,}/.test(lines[b + 1]!)) b++;
  const block = lines.slice(a, b + 1);
  const options = block.map((l) => { const m = OPTION_LINE.exec(l)!; return { text: m[2]!, cursor: !!m[1] }; });
  const cursor = options.findIndex((o) => o.cursor);
  if (cursor < 0) return undefined;
  return { options, target: ti - a, cursor };
}

/** Select the option matching `target` by where the cursor actually is (no blind Down that could wrap onto
 *  "No, exit"), check the cursor landed on it, then press Enter. */
export async function selectMenuOption(tmux: Tmux, name: string, pane: string, target: RegExp, o: MenuOptions = {}): Promise<boolean> {
  const delay = o.keyDelayMs ?? 150;
  let menu = parseMenu(pane, target);
  if (!menu) return false;
  const moves = menu.target - menu.cursor;
  for (let i = 0; i < Math.abs(moves); i++) { await tmux.sendKeys(name, moves > 0 ? "Down" : "Up"); await sleep(delay); }
  if (moves !== 0) {
    menu = parseMenu(await tmux.capture(name).catch(() => ""), target);
    if (!menu || menu.cursor !== menu.target) return false; // not where we expected: look again on the next poll
  }
  await tmux.sendKeys(name, "Enter");
  return true;
}

export const STARTUP_PROMPTS: StartupPrompt[] = [
  { label: "bypass-permissions-warning",
    match: (p) => p.includes("Bypass Permissions mode") && p.includes("No, exit") && p.includes("Yes, I accept"),
    respond: (t, n, pane, o) => selectMenuOption(t, n, pane, /Yes, I accept/, o) },
  // First launch in an untrusted cwd. Seen both numbered (`❯ 1. Yes, I trust this folder`) and unnumbered with the
  // cursor on "No, exit"; select "Yes" by cursor position either way.
  { label: "folder-trust",
    match: (p) => /Yes, I trust this folder/.test(p) && /No, exit/.test(p),
    respond: (t, n, pane, o) => selectMenuOption(t, n, pane, /^\s*(❯\s*)?(\d+\.\s*)?Yes, I trust this folder/, o) },
  { label: "compact-confirm", match: (p) => /Compact\?[\s\S]{0,40}\(y\/N\)/i.test(p),
    respond: async (t, n) => { await t.sendKeys(n, "y"); await sleep(100); await t.sendKeys(n, "Enter"); return true; } },
  { label: "generic-continue", match: (p) => /Continue\?\s*\(y\/N\)/i.test(p), respond: async (t, n) => { await t.sendKeys(n, "Enter"); return true; } },
  { label: "press-enter-to-continue", match: (p) => /Press Enter to continue/i.test(p), respond: async (t, n) => { await t.sendKeys(n, "Enter"); return true; } },
];

export type InitResult =
  | { status: "ready"; pane: string }
  | { status: "login"; pane: string }
  | { status: "timeout"; pane: string }
  | { status: "dead"; pane: string };

/** Wait for the TUI to accept input, auto-answering known startup prompts. */
export async function waitForReady(tmux: Tmux, name: string, o: {
  timeoutMs?: number; onPrompt?: (label: string) => void; isLoginPane?: (pane: string) => boolean;
  /** Test hooks: poll interval, pause after answering a prompt, how long an unchanged answered prompt waits before
   *  it is answered again, key delay inside a menu. */
  pollMs?: number; afterPromptMs?: number; reanswerMs?: number; keyDelayMs?: number;
} = {}): Promise<InitResult> {
  const deadline = Date.now() + (o.timeoutMs ?? 90_000);
  const pollMs = o.pollMs ?? 400, afterPromptMs = o.afterPromptMs ?? 1000, reanswerMs = o.reanswerMs ?? 3000;
  let fp = "", stableSince = Date.now(), escSent = false, pane = "";
  /** The prompt answered last and the screen it was answered on: the same screen is not answered again (a second
   *  answer to a menu that is still closing could land on another option) until reanswerMs passes. */
  let answered: { label: string; screen: string; at: number } | undefined;
  while (Date.now() < deadline) {
    try { pane = await tmux.capture(name); } catch { return { status: "dead", pane }; }
    if (isReady(pane)) return { status: "ready", pane };
    if (await tmux.paneDead(name)) return { status: "dead", pane };
    if (o.isLoginPane?.(pane)) return { status: "login", pane };
    const prompt = STARTUP_PROMPTS.find((p) => p.match(pane));
    if (prompt) {
      if (answered && answered.label === prompt.label && answered.screen === pane.trimEnd() && Date.now() - answered.at < reanswerMs) {
        await sleep(pollMs);
        continue;
      }
      o.onPrompt?.(prompt.label);
      const sent = await prompt.respond(tmux, name, pane, { keyDelayMs: o.keyDelayMs });
      // Remember the screen as it is after our keys (cursor moved): only a different screen gets a new answer.
      if (sent) answered = { label: prompt.label, screen: (await tmux.capture(name).catch(() => pane)).trimEnd(), at: Date.now() };
      fp = ""; stableSince = Date.now(); escSent = false;
      await sleep(sent ? afterPromptMs : pollMs);
      continue;
    }
    const f = `${pane.length}:${pane.slice(-200)}`;
    if (f !== fp) { fp = f; stableSince = Date.now(); }
    else if (!escSent && Date.now() - stableSince > 15_000) { await tmux.sendKeys(name, "Escape").catch(() => {}); escSent = true; stableSince = Date.now(); }
    await sleep(pollMs);
  }
  return { status: "timeout", pane };
}
