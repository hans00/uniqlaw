// LINE renders plain text only: flatten Markdown.
export function markdownToPlain(md: string): string {
  return md
    .replace(/```[a-zA-Z0-9]*\n?([\s\S]*?)```/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "$1 ($2)")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/^(\s*)[-*]\s+/gm, "$1• ")
    .trim();
}
