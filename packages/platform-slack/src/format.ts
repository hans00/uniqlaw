// Markdown → Slack mrkdwn, and emoji → Slack reaction shortcodes.

/** Minimal Markdown → mrkdwn: bold, strike, links, headings, bullet stars. Code spans/blocks untouched. */
export function markdownToMrkdwn(md: string): string {
  const parts = md.split(/(```[\s\S]*?```|`[^`\n]+`)/g);
  return parts.map((p, i) => {
    if (i % 2 === 1) return p; // code
    return p
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "<$2|$1>")
      .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
      .replace(/\*\*(.+?)\*\*/g, "*$1*")
      .replace(/__(.+?)__/g, "*$1*")
      .replace(/~~(.+?)~~/g, "~$1~")
      .replace(/^(\s*)[-*]\s+/gm, "$1• ");
  }).join("");
}

const EMOJI_NAMES: Record<string, string> = {
  "👍": "+1", "👎": "-1", "❤️": "heart", "❤": "heart", "🔥": "fire", "🎉": "tada", "👀": "eyes", "✅": "white_check_mark",
  "❌": "x", "😂": "joy", "🙏": "pray", "👏": "clap", "🤔": "thinking_face", "😊": "blush", "😄": "smile", "🌸": "cherry_blossom",
  "💯": "100", "🚀": "rocket", "⭐": "star", "😢": "cry", "😮": "open_mouth", "🙌": "raised_hands", "👌": "ok_hand", "💪": "muscle",
  "⚠️": "warning", "✨": "sparkles", "🤖": "robot_face", "📝": "memo", "🆗": "ok", "😅": "sweat_smile",
};

/** "👍" → "+1", ":fire:" → "fire", "fire" → "fire"; unknown unicode → undefined. */
export function slackReactionName(emoji: string): string | undefined {
  const e = emoji.trim();
  if (EMOJI_NAMES[e]) return EMOJI_NAMES[e];
  const m = /^:?([a-z0-9_+\-']+):?$/i.exec(e);
  return m ? m[1]!.toLowerCase() : undefined;
}
