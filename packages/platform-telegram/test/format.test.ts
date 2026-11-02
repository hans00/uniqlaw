import { expect, test } from "bun:test";
import { chunkHtml, markdownToTelegramHtml } from "../src/format.ts";

test("markdown subset → Telegram HTML", () => {
  expect(markdownToTelegramHtml("## Title\n**bold** <x> & `a<b`")).toBe("<b>Title</b>\n<b>bold</b> &lt;x&gt; &amp; <code>a&lt;b</code>");
  expect(markdownToTelegramHtml("```ts\nconst a = 1 < 2;\n```")).toBe("<pre>const a = 1 &lt; 2;</pre>");
});

test("tables render aligned inside <pre>, CJK counted double-width", () => {
  const html = markdownToTelegramHtml("| a | 名稱 |\n|---|---|\n| xx | y |\n");
  expect(html.startsWith("<pre>")).toBe(true);
  expect(html).toContain("a   名稱");
});

test("chunkHtml splits on paragraphs and never emits empty chunks", () => {
  const html = ["a".repeat(30), "b".repeat(30), "c".repeat(30)].join("\n\n");
  const chunks = chunkHtml(html, 40);
  expect(chunks).toEqual(["a".repeat(30), "b".repeat(30), "c".repeat(30)]);
  expect(chunkHtml("x".repeat(100), 40).every((c) => c.length > 0 && c.length <= 40)).toBe(true);
});
