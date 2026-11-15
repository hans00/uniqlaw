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
  return !!parseUsageLimit(pane);
}

export interface UsageLimitInfo {
  /** Which limit Claude Code named: the 5-hour (session) window, the weekly quota, or a generic usage limit. */
  kind: "5-hour" | "weekly" | "usage";
  /** Claude Code's own reset wording, e.g. "2:10am (Asia/Taipei)" (shown to humans as is). */
  resets?: string;
  /** The reset as epoch ms, when it could be worked out. */
  resetAt?: number;
  /** The matched line (for logs). */
  line: string;
}

/** Blocking limit messages only (not the "approaching your limit" / "x% used" warnings, which also say "resets"):
 *  "You've hit your 5-hour limit · resets 2:10am (Asia/Taipei)", "You've hit your weekly limit · resets …",
 *  "5-hour limit reached ∙ resets 3pm", "Claude usage limit reached. Your limit will reset at 3pm (…)". */
const LIMIT_LINE_RE = new RegExp([
  String.raw`you[’']?ve (?:hit|reached) your\b[^\n]{0,40}?\blimit\b`,
  String.raw`\busage limit reached\b`,
  String.raw`\b(?:5-hour|five-hour|session|weekly|opus|sonnet|daily)\b[^\n]{0,20}?\blimit reached\b`,
  String.raw`\byour limit will reset\b`,
  String.raw`\breached your [^\n]{0,40}?\blimit\b`,
].join("|"), "i");
const NOT_LIMIT_RE = /not your usage limit|approaching|\b\d{1,3}\s*%/i;
/** A submitted prompt echoed in the transcript (`❯ text` at the left edge; the input box's `❯` sits between rules). */
const PROMPT_ECHO_RE = /^[>❯]\s?\S/;

/**
 * The usage-limit message of the current turn, if the pane shows one. Only the transcript below the last echoed
 * prompt counts (a limit hit by an earlier turn stays on screen after the reset) and only above the input box.
 * `now` anchors the reset time.
 */
export function parseUsageLimit(pane: string, now = Date.now()): UsageLimitInfo | undefined {
  let lines = pane.split("\n");
  // Cut at the input box (its top rule followed by the `❯` line), when there is one.
  for (let i = lines.length - 2; i >= 0; i--) {
    if (/─{20,}/.test(lines[i]!) && /^\s*❯/.test(lines[i + 1]!)) { lines = lines.slice(0, i); break; }
  }
  lines = lines.slice(-30);
  let start = 0;
  for (let i = lines.length - 1; i >= 0; i--) if (PROMPT_ECHO_RE.test(lines[i]!)) { start = i + 1; break; }
  for (let i = lines.length - 1; i >= start; i--) {
    const line = lines[i]!.replace(/^[\s│┃⎿●⏺]+/, "").trimEnd();
    if (!LIMIT_LINE_RE.test(line) || NOT_LIMIT_RE.test(line)) continue;
    // A narrow pane wraps the reset time onto the next line.
    const next = (lines[i + 1] ?? "").trim();
    return describeUsageLimit(/reset/i.test(line) || !/reset/i.test(next) ? line : `${line} ${next}`, now);
  }
  return undefined;
}

/** Kind and reset of a limit message (pane line or transcript text). */
export function describeUsageLimit(text: string, now = Date.now()): UsageLimitInfo {
  const line = text.trim().replace(/\s+/g, " ");
  const kind = /\bweekly\b/i.test(line) ? "weekly" : /\b(?:5-hour|five-hour|session)\b/i.test(line) ? "5-hour" : "usage";
  // Older transcripts carry the reset as epoch seconds: "Claude AI usage limit reached|1763230200".
  const epoch = /\|\s*(\d{10})\b/.exec(line);
  if (epoch) {
    const resetAt = Number(epoch[1]) * 1000;
    return { kind, resetAt, resets: new Date(resetAt).toISOString().replace(/:\d\d\.\d+Z$/, "Z"), line: line.replace(/\|\s*\d{10}\b.*/, "") };
  }
  const m = /\breset(?:s)?(?:\s+at)?\s+(.+?)\s*\.?$/i.exec(line);
  if (!m) return { kind, line };
  const resets = m[1]!.replace(/\s*[·∙•].*$/, "").trim();
  const resetAt = parseResetTime(resets, now);
  return { kind, resets, ...(resetAt !== undefined ? { resetAt } : {}), line };
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/**
 * "2:10am (Asia/Taipei)", "3pm", "Nov 20, 3am (UTC)", "Nov 20 at 3am", "Thu 3am" → the next such moment after `now`,
 * as epoch ms, in the named zone (else this machine's). undefined when it can't be read.
 */
export function parseResetTime(text: string, now = Date.now()): number | undefined {
  const tzm = /\(([A-Za-z_]+(?:\/[A-Za-z0-9_+\-]+)*)\)/.exec(text);
  const tz = tzm?.[1] ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); } catch { return undefined; }
  const body = text.replace(/\([^)]*\)/g, " ");
  const t = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i.exec(body) ?? /\b(\d{1,2}):(\d{2})\b()/.exec(body);
  if (!t) return undefined;
  let hour = Number(t[1]);
  const minute = Number(t[2] ?? 0);
  const ap = t[3]?.toLowerCase();
  if (ap) { if (hour < 1 || hour > 12) return undefined; hour = (hour % 12) + (ap === "pm" ? 12 : 0); }
  if (hour > 23 || minute > 59) return undefined;
  const date = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/i.exec(body);
  const wd = /\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*\b/i.exec(body);
  const today = zonedFields(now, tz);
  if (date) {
    const month = MONTHS.indexOf(date[1]!.toLowerCase()), day = Number(date[2]);
    for (const year of [today.year, today.year + 1]) {
      const at = zonedToEpoch(tz, year, month, day, hour, minute);
      if (at > now) return at;
    }
    return undefined;
  }
  for (let add = 0; add <= 7; add++) {
    const d = new Date(Date.UTC(today.year, today.month, today.day + add));
    if (wd && d.getUTCDay() !== WEEKDAYS.indexOf(wd[1]!.toLowerCase())) continue;
    const at = zonedToEpoch(tz, d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour, minute);
    if (at > now) return at;
  }
  return undefined;
}

function zonedFields(at: number, tz: string) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric",
    day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" }).formatToParts(new Date(at));
  const get = (k: string) => Number(parts.find((p) => p.type === k)?.value ?? 0);
  return { year: get("year"), month: get("month") - 1, day: get("day"), hour: get("hour") % 24, minute: get("minute"), second: get("second") };
}

/** Wall-clock time in `tz` → epoch ms (two passes, so a DST change between guess and answer is accounted for). */
function zonedToEpoch(tz: string, year: number, month: number, day: number, hour: number, minute: number): number {
  const wall = Date.UTC(year, month, day, hour, minute);
  let at = wall;
  for (let i = 0; i < 2; i++) {
    const f = zonedFields(at, tz);
    at += wall - Date.UTC(f.year, f.month, f.day, f.hour, f.minute, f.second);
  }
  return at;
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
