// Claude Code usage-limit messages ("You've hit your 5-hour limit · resets 2:10am (Asia/Taipei)"): detection and
// reset-time parsing. Shared by claude-tmux (pane / jsonl) and claude-sdk (result errors).

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
/** How many non-empty lines above the input box can hold the notice (it plus its "/upgrade …" hint lines). */
const LIMIT_TAIL_LINES = 4;
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
  // Claude Code prints the notice last, right above the input box: a line further up is earlier output (the agent's
  // reply, a diff, a log) that merely mentions a limit.
  let seen = 0;
  for (let i = lines.length - 1; i >= start && seen < LIMIT_TAIL_LINES; i--) {
    if (lines[i]!.trim()) seen++;
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
