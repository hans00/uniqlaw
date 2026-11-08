// Provider-independent text handling (ported from claudeclaw-v2: silent.ts,
// reactions.ts, tool-display.ts, compose.ts, channel.ts prompt formatting).
import type { Sender } from "./platform.ts";

// ── silent replies ─────────────────────────────────────────────────────────
export const SILENT_REPLY_TOKEN = "NO_REPLY";
const SILENT_SENTINELS = [SILENT_REPLY_TOKEN, "HEARTBEAT_OK"];
const WRAP_CHARS = "`\"'*_~";
const END_PUNCT = ".!?;:。！？；：,，";
const LEAD_RE = new RegExp(`^[${WRAP_CHARS}\\s]+`);
const TAIL_RE = new RegExp(`[${WRAP_CHARS}${END_PUNCT}\\s]+$`);
const TRAILING_RE = new RegExp(`\\s*[${WRAP_CHARS}]*NO_REPLY[${WRAP_CHARS}${END_PUNCT}\\s]*$`);

function normalizeSilent(text: string): string {
  let t = text.trim();
  if (t.startsWith("```")) t = t.replace(/^```[a-zA-Z0-9]*\s*/, "").replace(/\s*```$/, "").trim();
  return t.replace(LEAD_RE, "").replace(TAIL_RE, "");
}
export function isSilentReplyText(text: string): boolean {
  if (!text) return false;
  const norm = normalizeSilent(text);
  return SILENT_SENTINELS.some((s) => norm === s);
}
export function stripSilentToken(text: string): string {
  return text.replace(TRAILING_RE, "").replace(/\s+$/, "");
}

// ── reactions ──────────────────────────────────────────────────────────────
const REACT_TAG_RE = /\[react:([^\]]+)\]/g;
export function extractReactions(text: string): { cleanText: string; reactions: string[] } {
  if (!text || !text.includes("[react:")) return { cleanText: text ?? "", reactions: [] };
  const reactions: string[] = [];
  const stripped = text.replace(REACT_TAG_RE, (_m, emoji) => {
    const t = String(emoji).trim();
    if (t) reactions.push(t);
    return "";
  });
  const cleanText = stripped.replace(/[ \t]+\n/g, "\n").replace(/\n[ \t]+/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/^[ \t\n]+|[ \t\n]+$/g, "");
  return { cleanText, reactions };
}

// ── tool status line ───────────────────────────────────────────────────────
interface ToolSpec { emoji: string; title?: string; detailKeys: string[] }
const FALLBACK: ToolSpec = { emoji: "🧩", detailKeys: ["command", "path", "file_path", "url", "targetUrl", "target", "query", "pattern", "name", "id", "messageId", "to", "description"] };
const TOOL_MAP: Record<string, ToolSpec> = {
  bash: { emoji: "🛠️", title: "Bash", detailKeys: ["command"] },
  shell: { emoji: "🛠️", title: "Shell", detailKeys: ["command"] },
  commandexecution: { emoji: "🛠️", title: "Shell", detailKeys: ["command"] },
  read: { emoji: "📖", title: "Read", detailKeys: ["file_path", "path"] },
  write: { emoji: "✍️", title: "Write", detailKeys: ["file_path", "path"] },
  edit: { emoji: "📝", title: "Edit", detailKeys: ["file_path", "path"] },
  multiedit: { emoji: "📝", title: "MultiEdit", detailKeys: ["file_path", "path"] },
  filechange: { emoji: "📝", title: "Edit", detailKeys: ["path", "file_path"] },
  glob: { emoji: "🔎", title: "Glob", detailKeys: ["pattern", "path"] },
  grep: { emoji: "🔎", title: "Grep", detailKeys: ["pattern", "path"] },
  ls: { emoji: "📂", title: "Ls", detailKeys: ["path"] },
  webfetch: { emoji: "🌐", title: "WebFetch", detailKeys: ["url"] },
  websearch: { emoji: "🌐", title: "WebSearch", detailKeys: ["query"] },
  task: { emoji: "🤖", title: "Task", detailKeys: ["description", "subagent_type"] },
  agent: { emoji: "🤖", title: "Agent", detailKeys: ["description", "subagent_type"] },
  todowrite: { emoji: "✅", title: "TodoWrite", detailKeys: [] },
  schedulewakeup: { emoji: "⏰", title: "ScheduleWakeup", detailKeys: ["delaySeconds", "reason"] },
  toolsearch: { emoji: "🔌", title: "ToolSearch", detailKeys: ["query"] },
  askuserquestion: { emoji: "❓", title: "AskUser", detailKeys: [] },
};
export function formatToolStatus(toolName: string, input: unknown): string {
  // MCP tools arrive as mcp__<server>__<tool>; show the tool part.
  const display = toolName.startsWith("mcp__") ? toolName.split("__").slice(2).join("__") || toolName : toolName;
  const spec = TOOL_MAP[display.toLowerCase().replace(/[^a-z0-9]/g, "")] ?? FALLBACK;
  const title = spec.title ?? display;
  let detail = "";
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    for (const k of spec.detailKeys) {
      const v = o[k];
      if (typeof v === "string" && v) { detail = v; break; }
      if (typeof v === "number" || typeof v === "boolean") { detail = String(v); break; }
    }
  } else if (typeof input === "string") detail = input;
  detail = detail.replace(/\s+/g, " ").trim();
  if (detail.length > 180) detail = detail.slice(0, 179) + "…";
  return detail ? `${spec.emoji} ${title} · ${detail}` : `${spec.emoji} ${title}`;
}

// ── time ───────────────────────────────────────────────────────────────────
/** Accepts "UTC", "UTC+8", "+08:00", "-5", or an IANA zone ("Asia/Taipei"). */
export function formatTimestamp(d: Date, tz: string): string {
  const off = parseUtcOffset(tz);
  if (off === null) {
    try {
      const parts = new Intl.DateTimeFormat("sv-SE", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(d);
      return `${parts} ${tz}`;
    } catch { return formatTimestamp(d, "UTC"); }
  }
  const s = new Date(d.getTime() + off * 60_000);
  const p = (n: number) => String(n).padStart(2, "0");
  const label = off === 0 ? "UTC" : `UTC${off > 0 ? "+" : "-"}${Math.floor(Math.abs(off) / 60)}${Math.abs(off) % 60 ? ":" + p(Math.abs(off) % 60) : ""}`;
  return `${s.getUTCFullYear()}-${p(s.getUTCMonth() + 1)}-${p(s.getUTCDate())} ${p(s.getUTCHours())}:${p(s.getUTCMinutes())}:${p(s.getUTCSeconds())} ${label}`;
}
export function parseUtcOffset(tz: string): number | null {
  const t = tz.trim().toUpperCase();
  if (t === "UTC" || t === "GMT" || t === "Z") return 0;
  const m = t.match(/^(?:UTC|GMT)?\s*([+-])(\d{1,2})(?::?(\d{2}))?$/);
  if (!m) return null;
  const v = Number(m[2]) * 60 + Number(m[3] ?? 0);
  return m[1] === "-" ? -v : v;
}

// ── prompt composition ─────────────────────────────────────────────────────
export function renderSourceLine(platform: string, sender: Sender): string {
  const P = platform.charAt(0).toUpperCase() + platform.slice(1);
  const ident = [sender.username ? `@${sender.username}` : "", sender.id].filter(Boolean).join(" · ");
  return `[${P} from ${sender.name} (${ident})]`;
}

export interface PromptItem {
  text: string;
  receivedAt: number;
  /** "[Telegram from …]" style line, or "[label]" for non-human origins. */
  sourceLine: string;
  /** Text is already a complete prompt (no "Message:" prefix). */
  raw?: boolean;
}

export function formatPromptBody(item: PromptItem, tz: string): string {
  const stamp = formatTimestamp(new Date(item.receivedAt), tz);
  return item.raw ? `[${stamp}]\n${item.sourceLine}\n${item.text}` : `[${stamp}]\n${item.sourceLine}\nMessage: ${item.text}`;
}

export function mergeQueued(items: PromptItem[], tz: string, dropped: string[] = []): string {
  if (items.length === 1 && dropped.length === 0) return formatPromptBody(items[0]!, tz);
  const blocks = ["[Queued messages while agent was busy]"];
  if (dropped.length) {
    blocks.push([`[${dropped.length} earlier message${dropped.length === 1 ? "" : "s"} dropped due to queue cap]`, ...dropped.map((s) => `  - ${s}`)].join("\n"));
  }
  items.forEach((it, i) => {
    const stamp = formatTimestamp(new Date(it.receivedAt), tz);
    blocks.push(`---\nQueued #${i + 1}\n[${stamp}]\n${it.sourceLine}\n${it.raw ? it.text : `Message: ${it.text}`}`);
  });
  return blocks.join("\n\n");
}

export function isPassthroughSlashCommand(text: string): boolean {
  const t = text.trim();
  if (!t || t.includes("\n")) return false;
  return /^\/[a-zA-Z][\w:-]*(\s+\S.*?)?$/.test(t);
}

export interface PendingNote { at: number; label: string; text: string }
export function formatPendingForPrompt(notes: PendingNote[], tz: string): string {
  if (!notes.length) return "";
  const lines = ["[Activity on this channel since your last turn — including messages sent on your behalf. Already-seen context.]"];
  for (const n of notes) {
    const time = formatTimestamp(new Date(n.at), tz).slice(11, 16);
    const t = n.text.length > 600 ? n.text.slice(0, 599) + "…" : n.text;
    lines.push(`- ${time} — ${n.label}: ${t}`);
  }
  lines.push("", "Treat this as already-seen context. Do NOT re-post or echo it. Reference it only if relevant.");
  return lines.join("\n");
}

// ── system prompt fragments ────────────────────────────────────────────────
export const BRAND_PROMPT = "You are running inside UniQlaw, a multi-channel agent daemon. Messages reach you from chat platforms (Telegram, Discord, …), scheduled jobs, and other agent sessions; each user message is prefixed with its timestamp and source.";

export function dirScopePrompt(projectDir: string): string {
  return [
    `CRITICAL SECURITY CONSTRAINT: You are scoped to the project directory: ${projectDir}`,
    "You MUST NOT read, write, edit, or delete any file outside this directory.",
    "You MUST NOT run bash commands that modify anything outside this directory (no cd /, no /etc, no ~/, no ../.. escapes).",
    "If a request requires accessing files outside the project, refuse and explain why.",
  ].join("\n");
}

/** For sessions that can call worker_start: where workers may run and with which profiles. */
export function workersPrompt(roots: string[], profiles: { name: string; provider: string; model?: string }[]): string {
  return [
    "## Workers",
    "`worker_start` runs another coding agent on this machine, in its own directory, and hands it a task. Delegating there is allowed even "
      + "when the directory is outside your own scope: the worker runs in that directory under its own profile and permissions, and UniQlaw enforces the allowed list below.",
    `Allowed worker directories (and their subdirectories): ${roots.map((r) => `\`${r}\``).join(", ")}.`,
    `Worker profiles: ${profiles.map((p) => `\`${p.name}\` (${p.provider}${p.model ? ` ${p.model}` : ""})`).join(", ")}.`,
    "Use one worker per task and directory, give it a self-contained task, and use agent_ask to `worker:<name>` for follow-ups. A human may take a worker over; then it refuses your messages until they detach.",
  ].join("\n");
}

export const SILENT_REPLY_PROMPT = [
  "## Silent Replies", "",
  "You are in a multi-party channel. Not every message needs a reply from you — e.g. two other people are talking to each other, the message is not addressed to you, it is an off-topic aside, or you genuinely have nothing meaningful to add.", "",
  "In those cases, output exactly this and nothing else:", "", "NO_REPLY", "",
  "Strict rules:",
  "- Output must be those 8 characters alone. No backticks, no quotes, no bold, no code fence, no trailing period, no emoji, no leading or trailing text.",
  "- Never embed NO_REPLY inside a sentence or explanation. If you want to say anything at all, just reply normally and do NOT include the token.",
  "- When unsure whether to chime in, prefer silence.",
].join("\n");

export const REACTION_PROMPT = "To react to the user's message with an emoji, include `[react:<emoji>]` anywhere in your reply (it is removed from the text and applied as a native reaction). A reply consisting only of reaction tags sends just the reaction.";

/** For sessions with no chat of their own (heartbeat, cron jobs, "global"…). */
export function internalSessionPrompt(channelKey: string): string {
  return [
    "## Internal session",
    `You are the internal session \`${channelKey}\`. You have no chat of your own and no human is reading this session directly.`,
    "- To tell a human something, use `notify` with a chat target (e.g. \"telegram:<chatId>\"); `agents_list` shows each chat session's target.",
    "- To have a chat session talk to its own human (with its own context), use `agent_trigger`.",
    "- To get information from another session without a human seeing it, use `agent_ask`.",
    "- Your final reply is only delivered where the job/heartbeat config says (replyTo); if it says none, nothing you write is shown unless you send it with a tool.",
  ].join("\n");
}

export function busToolsPrompt(toolNames: string[]): string {
  return [
    "## UniQlaw tools",
    `You have these UniQlaw MCP tools (server "uniqlaw"): ${toolNames.map((n) => `\`${n}\``).join(", ")}. Use them directly — do not search for them.`,
    "- `agents_list`: discover other agent sessions you can reach.",
    "- `agent_ask`: ask another session something; its answer comes back to YOU (no human sees it).",
    "- `agent_trigger`: make another session answer ITS OWN human on its own chat.",
    "- `notify`: send text you wrote to a chat target (a human sees it verbatim).",
    ...(toolNames.includes("worker_start") ? ["- `worker_start` / `worker_stop`: run another coding agent (a profile) in a directory on this machine and hand it work; follow up with `agent_ask` to `worker:<name>`."] : []),
    ...(toolNames.includes("cron_save") ? ["- `cron_list` / `cron_save` / `cron_delete`: manage your scheduled jobs (validated cron; prefer these over editing job files)."] : []),
    "When you receive a message from another agent session, answer once and stop; do not reply to replies unless asked a question.",
  ].join("\n");
}

/** Extra system prompt for worker sessions (started by another session via worker_start). */
export function workerSessionPrompt(channelKey: string, cwd: string, owner?: string): string {
  return [
    "## Worker session",
    `You are \`${channelKey}\`, a coding agent working in \`${cwd}\`. Follow that directory's own project instructions (CLAUDE.md, AGENTS.md, …).`,
    `Tasks come from ${owner ? `the agent session \`${owner}\`` : "another agent session"}; your final reply to each task is returned to it, not to a human. `
      + "End each task with a short report: what you changed (files), how you checked it, and anything left open.",
    "A human may attach to this session and talk to you directly; then you are answering them, and their instructions win.",
  ].join("\n");
}
