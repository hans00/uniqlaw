// Inbound reply context: which message a human replies to, shown as one line before "Message:".
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ChannelManager, REPLY_QUOTE_MAX, StateStore, formatPromptBody, mergeQueued, parseSettings, renderReplyLine, replySnippet, silentLogger,
  type InboundMessage, type Origin, type Profile,
} from "../src/index.ts";
import { FakePlatform, FakeProvider } from "./fakes.ts";

const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

test("snippet: short text as is, newlines collapsed", () => {
  expect(replySnippet("hello\n\nthere  ")).toBe("hello there");
});

test("snippet: long text cut at the last sentence end within 100 chars, with …", () => {
  const s = "The deploy finished without errors. Then the cache warmed up and everything looked fine. After that the monitoring alerts started firing again.";
  expect(replySnippet(s)).toBe("The deploy finished without errors. Then the cache warmed up and everything looked fine.…");
  // No boundary inside the cap: hard cut at 100.
  const w = "x".repeat(150);
  expect(replySnippet(w)).toBe(`${"x".repeat(100)}…`);
  // A dot inside a number is not a sentence end; a line end is a boundary.
  expect(replySnippet(`version 3.14 is out and ${"y".repeat(40)}\n${"z".repeat(80)}`)).toBe(`version 3.14 is out and ${"y".repeat(40)}…`);
});

test("snippet: long CJK text is cut at a full stop by code points (no split characters)", () => {
  const s = "今天下午我們把部署流程整理了一遍，發現快取設定有問題。" + "接著重新跑了整套測試，全部通過之後才合併到主線。".repeat(3) + "最後通知大家可以開始驗收了。";
  const out = replySnippet(s);
  expect(out.endsWith("。…")).toBe(true);
  expect([...out].length).toBeLessThanOrEqual(101);
  expect(s.startsWith(out.slice(0, -1))).toBe(true);
  // No punctuation: 100 code points, emoji intact.
  const e = "😀".repeat(120);
  expect(replySnippet(e)).toBe(`${"😀".repeat(100)}…`);
});

test("snippet: a partial quote is kept up to 300 chars", () => {
  const q = "q".repeat(250);
  expect(replySnippet(q, { quote: true })).toBe(q);
  expect(replySnippet("w".repeat(400), { quote: true })).toBe(`${"w".repeat(REPLY_QUOTE_MAX)}…`);
});

test("reply line: author, HH:MM in the daemon's timezone, the bot's own message is 'you'", () => {
  const sentAt = Date.UTC(2026, 10, 15, 5, 7, 0);
  expect(renderReplyLine({ author: "Hans", fromBot: false, sentAt, snippet: "hi" }, "Asia/Taipei")).toBe('[Replying to Hans 13:07: "hi"]');
  expect(renderReplyLine({ author: "Bot", fromBot: true, sentAt, snippet: "ok" }, "UTC")).toBe('[Replying to you 05:07: "ok"]');
  expect(renderReplyLine({ author: "Bot", fromBot: true, snippet: "ok" }, "UTC")).toBe('[Replying to you: "ok"]');
});

test("prompt: the reply line sits between the source line and Message:, also in a merged queue", () => {
  const item = { text: "yes, do that", receivedAt: 0, sourceLine: "[Telegram from Hans (@h · 1)]", context: ['[Replying to you 05:07: "Shall I merge?"]'] };
  expect(formatPromptBody(item, "UTC").split("\n").slice(1)).toEqual(["[Telegram from Hans (@h · 1)]", '[Replying to you 05:07: "Shall I merge?"]', "Message: yes, do that"]);
  expect(mergeQueued([item, { ...item, context: undefined, text: "and then deploy" }], "UTC")).toContain('[Telegram from Hans (@h · 1)]\n[Replying to you 05:07: "Shall I merge?"]\nMessage: yes, do that');
});

test("manager: replyTo becomes the context line and replyToMessageId on the origin; no reply → no line", async () => {
  const dir = mkdtempSync(join(tmpdir(), "uq-reply-"));
  const store = new StateStore(join(dir, "state.db"));
  const settings = parseSettings({ profiles: { main: { provider: "fake" } }, queue: { debounceMs: 0 }, timezone: "UTC" });
  const seen: { text: string }[] = [];
  const origins: (Origin | undefined)[] = [];
  let mgr!: ChannelManager;
  const provider = new FakeProvider((input, s) => {
    seen.push(input);
    origins.push(mgr.runtimes.get("tg:1")!.inflightInputs()[0]?.origin);
    s.emit({ type: "turn_end", turnId: s.turnId(), reason: "done" });
  });
  const profile: Profile = { name: "main", provider: "fake", permissions: settings.profiles.main!.permissions, options: {} };
  mgr = new ChannelManager({ log: silentLogger, settings, store, projectDir: dir, instanceId: "t", providers: new Map([["fake", provider]]),
    platforms: new Map([["tg", new FakePlatform()]]), profiles: new Map([["main", profile]]), gatewayFor: () => undefined,
    systemPrompt: async () => ({ fragments: [] }), providerEnv: async () => ({}) });
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }), () => store.close(), () => mgr.stop());
  const base: InboundMessage = { platform: "tg", channelKey: "tg:1", replyTarget: { platform: "tg", chatId: "1" }, ref: { platform: "tg", chatId: "1", messageId: "50" },
    sender: { id: "1", name: "Hans" }, trusted: true, multiparty: false, text: "yes", attachments: [], receivedAt: Date.now() };
  await mgr.handleInbound({ ...base, replyTo: { messageId: "42", author: "Bot", fromBot: true, sentAt: Date.UTC(2026, 0, 1, 9, 30), snippet: "Shall I merge?" } });
  for (let i = 0; i < 200 && !seen.length; i++) await Bun.sleep(5);
  expect(seen[0]!.text).toContain('[Tg from Hans (1)]\n[Replying to you 09:30: "Shall I merge?"]\nMessage: yes');
  expect(seen[0]!.text).not.toContain("42");
  expect((origins[0] as Extract<Origin, { kind: "human" }>).replyToMessageId).toBe("42");
  await mgr.handleInbound({ ...base, text: "plain", ref: { ...base.ref, messageId: "51" } });
  for (let i = 0; i < 200 && seen.length < 2; i++) await Bun.sleep(5);
  expect(seen[1]!.text).not.toContain("Replying to");
  expect((origins[1] as Extract<Origin, { kind: "human" }>).replyToMessageId).toBeUndefined();
});
