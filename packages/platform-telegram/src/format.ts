// Markdown → Telegram HTML + chunking. Ported from claudeclaw-v2 platforms/telegram.ts.

/**
 * Convert a markdown subset to Telegram-flavoured HTML (`parse_mode: "HTML"`).
 *   - fenced code → <pre>, tables → aligned <pre>, `inline` → <code>,
 *     `# heading` → <b>, **bold** → <b>, everything else HTML-escaped.
 * Lists, italics and links stay as escaped literal text; they read fine and
 * never break the HTML parser.
 */
export function markdownToTelegramHtml(md: string): string {
  const blocks: string[] = [];
  const stash = (html: string): string => {
    blocks.push(html);
    return `\x00BLOCK${blocks.length - 1}\x00`;
  };

  let s = md.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, _lang, code: string) => {
    const trimmed = code.replace(/\n$/, "");
    return stash(`<pre>${escapeHtml(trimmed)}</pre>`);
  });

  s = s.replace(
    /(^\|[^\n]+\|[ \t]*\n\|[-:\s|]+\|[ \t]*\n(?:\|[^\n]+\|[ \t]*\n?)+)/gm,
    (block) => {
      const lines = block.trimEnd().split("\n");
      if (lines.length < 2) return block;
      const rows: string[][] = [];
      for (let i = 0; i < lines.length; i++) {
        if (i === 1) continue;
        rows.push(parseTableRow(lines[i]!));
      }
      const trailingNl = block.endsWith("\n") ? "\n" : "";
      return stash(`<pre>${escapeHtml(formatTableAligned(rows))}</pre>`) + trailingNl;
    },
  );

  const inlines: string[] = [];
  s = s.replace(/`([^`\n]+)`/g, (_m, code: string) => {
    inlines.push(`<code>${escapeHtml(code)}</code>`);
    return `\x00INLINE${inlines.length - 1}\x00`;
  });

  s = escapeHtml(s);
  s = s.replace(/^(#{1,6})\s+(.+)$/gm, (_m, _h, txt: string) => `<b>${txt}</b>`);
  s = s.replace(/\*\*([^\n]+?)\*\*/g, "<b>$1</b>");

  s = s.replace(/\x00INLINE(\d+)\x00/g, (_m, n: string) => inlines[Number(n)] ?? "");
  s = s.replace(/\x00BLOCK(\d+)\x00/g, (_m, n: string) => blocks[Number(n)] ?? "");
  return s;
}

function parseTableRow(line: string): string[] {
  const inner = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return inner.split("|").map((c) => c.trim());
}

function formatTableAligned(rows: string[][]): string {
  if (rows.length === 0) return "";
  const cols = Math.max(...rows.map((r) => r.length));
  const widths = new Array<number>(cols).fill(0);
  for (const row of rows) {
    for (let j = 0; j < row.length; j++) {
      const w = visibleWidth(row[j]!);
      if (w > widths[j]!) widths[j] = w;
    }
  }
  const sep = "  ";
  const out: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    out.push(rows[i]!.map((cell, j) => padToWidth(cell, widths[j]!)).join(sep));
    if (i === 0) out.push(widths.map((w) => "─".repeat(w)).join(sep));
  }
  return out.join("\n");
}

/** Width counting CJK chars as 2 so monospace alignment looks right. */
export function visibleWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += isWide(ch.codePointAt(0) ?? 0) ? 2 : 1;
  return w;
}

function padToWidth(s: string, target: number): string {
  const w = visibleWidth(s);
  return w >= target ? s : s + " ".repeat(target - w);
}

function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0x303e) ||
    (code >= 0x3041 && code <= 0x33ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xa000 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x20000 && code <= 0x2fffd) ||
    (code >= 0x30000 && code <= 0x3fffd)
  );
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Strip tags + unescape, for the plain-text fallback when Telegram rejects our HTML. */
export function htmlToPlain(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

export const TG_MSG_LIMIT = 4000;
/** Telegram caps at 4096; leave headroom for entities. */
export const TG_HTML_LIMIT = 3800;

/**
 * Split converted HTML into chunks at safe boundaries: paragraph breaks first,
 * then single newlines. Never splits inside a tag, so each chunk is well-formed.
 */
export function chunkHtml(html: string, max: number = TG_HTML_LIMIT): string[] {
  if (!html) return [];
  if (html.length <= max) return [html];
  const out: string[] = [];
  let buf = "";
  for (const p of html.split(/\n\n+/)) {
    if (p.length > max) {
      if (buf) { out.push(buf); buf = ""; }
      let inner = "";
      for (const line of p.split("\n")) {
        if (inner.length + 1 + line.length > max) {
          if (inner) out.push(inner);
          inner = line;
          // A single line longer than the limit is hard-split (v2 silently truncated it).
          while (inner.length > max) {
            const cut = safeCut(inner, max);
            out.push(inner.slice(0, cut));
            inner = inner.slice(cut);
          }
        } else {
          inner = inner ? `${inner}\n${line}` : line;
        }
      }
      if (inner) out.push(inner);
      continue;
    }
    if (buf && buf.length + 2 + p.length > max) {
      out.push(buf);
      buf = p;
    } else {
      buf = buf ? `${buf}\n\n${p}` : p;
    }
  }
  if (buf) out.push(buf);
  return out;
}

/** Cut index ≤ max that does not land inside an HTML tag or entity. */
function safeCut(s: string, max: number): number {
  const lt = s.lastIndexOf("<", max - 1);
  if (lt > 0 && s.indexOf(">", lt) >= max) return lt;
  const amp = s.lastIndexOf("&", max - 1);
  if (amp > 0 && amp > max - 8 && !s.slice(amp, max).includes(";")) return amp;
  return max;
}

/** Plain-text chunking (used by the plain fallback path). */
export function chunkText(text: string, max: number = TG_MSG_LIMIT): string[] {
  if (text.length <= max) return text ? [text] : [];
  const result: string[] = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + max, text.length);
    if (end < text.length) {
      const nl = text.lastIndexOf("\n", end);
      if (nl > i + max / 2) end = nl;
    }
    result.push(text.slice(i, end));
    i = end;
    if (text[i] === "\n") i++;
  }
  return result;
}

/** Telegram's bot-reaction allowlist. Anything else returns REACTION_INVALID
 *  and trashes the whole batch, so unsupported emojis are dropped up front. */
export const TG_REACTION_EMOJIS = new Set([
  "👍","👎","❤","🔥","🥰","👏","😁","🤔","🤯","😱","🤬","😢","🎉","🤩",
  "🤮","💩","🙏","👌","🕊","🤡","🥱","🥴","😍","🐳","❤‍🔥","🌚","🌭","💯",
  "🤣","⚡","🍌","🏆","💔","🤨","😐","🍓","🍾","💋","🖕","😈","😴","😭",
  "🤓","👻","👨‍💻","👀","🎃","🙈","😇","😨","🤝","✍","🤗","🫡","🎅","🎄",
  "☃","💅","🤪","🗿","🆒","💘","🙉","🦄","😘","💊","🙊","😎","👾","🤷‍♂",
  "🤷","🤷‍♀","😡",
]);

/** Strip variation selector U+FE0F so ❤️ and ❤ compare equal. */
export function normalizeEmoji(s: string): string {
  return s.replace(/️/g, "");
}

/** Telegram command names: [a-z0-9_]{1,32}. */
export function normalizeCommandName(raw: string): string {
  return raw
    .replace(/^\//, "")
    .replace(/[^a-z0-9_]/gi, "_")
    .toLowerCase()
    .replace(/__+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 32);
}
