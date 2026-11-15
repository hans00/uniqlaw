// reply_to_message → InboundMessage.replyTo (author, time, snippet / partial quote / media label).
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { silentLogger, type InboundMessage } from "@uniqlaw/core";
import { TelegramAdapter } from "../src/index.ts";

const dir = mkdtempSync(join(tmpdir(), "uq-tg-reply-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

const OWNER = 111;
function adapter() {
  const a = new TelegramAdapter({ token: "T:T", apiBase: "http://127.0.0.1:9", allowedUserIds: [String(OWNER)], allowedGroupIds: [], operatorUserIds: [String(OWNER)],
    pollSeconds: 0, attachmentsDir: dir, log: silentLogger });
  const inbox: InboundMessage[] = [];
  (a as any).sink = { message: (m: InboundMessage) => inbox.push(m) };
  (a as any).bot = { id: 999, is_bot: true, first_name: "Uniq", username: "uniq_bot" };
  return { a, inbox };
}
const me = { id: OWNER, first_name: "Hans" };
const replied = (extra: Record<string, unknown>) => ({ message_id: 77, chat: { id: OWNER, type: "private" }, date: 1_794_700_000, ...extra });
const update = (text: string, extra: Record<string, unknown> = {}) =>
  ({ update_id: 1, message: { message_id: 80, from: me, chat: { id: OWNER, type: "private" }, date: 1_794_700_100, text, ...extra } }) as any;

test("reply to the bot's own message: author 'you', its text, id and time kept", async () => {
  const { a, inbox } = adapter();
  await a.handleUpdate(update("yes", { reply_to_message: replied({ from: { id: 999, is_bot: true, first_name: "Uniq" }, text: "Shall I merge the branch?" }) }));
  expect(inbox[0]!.replyTo).toEqual({ messageId: "77", author: "Uniq", fromBot: true, sentAt: 1_794_700_000_000, snippet: "Shall I merge the branch?" });
});

test("reply to a user's message: their display name; caption counts as text", async () => {
  const { a, inbox } = adapter();
  await a.handleUpdate(update("agreed", { reply_to_message: replied({ from: { id: 222, first_name: "Amy", last_name: "Lee" }, caption: "line one\nline two", photo: [{ file_id: "p", width: 1, height: 1 }] }) }));
  expect(inbox[0]!.replyTo).toMatchObject({ author: "Amy Lee", fromBot: false, snippet: "line one line two" });
});

test("partial quote: the quoted part, not the message start", async () => {
  const { a, inbox } = adapter();
  const long = "First the intro. " + "Then a lot of detail. ".repeat(20) + "The key point is HERE.";
  await a.handleUpdate(update("why?", { quote: { text: "The key point is HERE.", position: 400 }, reply_to_message: replied({ from: { id: 999, is_bot: true }, text: long }) }));
  expect(inbox[0]!.replyTo!.snippet).toBe("The key point is HERE.");
});

test("long CJK text: cut at a full stop within 100 characters, with …", async () => {
  const { a, inbox } = adapter();
  const cjk = "部署已經完成，所有服務都正常運作。" + "我們接下來會觀察一段時間的監控數據，確認沒有異常之後再通知大家。".repeat(4);
  await a.handleUpdate(update("好", { reply_to_message: replied({ from: { id: 999, is_bot: true }, text: cjk }) }));
  const sn = inbox[0]!.replyTo!.snippet;
  expect(sn.endsWith("。…")).toBe(true);
  expect([...sn].length).toBeLessThanOrEqual(101);
});

test("media-only replies: [photo], [voice], [document: name]", async () => {
  const { a, inbox } = adapter();
  const from = { id: 222, first_name: "Amy" };
  await a.handleUpdate(update("nice", { reply_to_message: replied({ from, photo: [{ file_id: "p", width: 1, height: 1 }] }) }));
  await a.handleUpdate(update("heard", { reply_to_message: replied({ from, voice: { file_id: "v", duration: 3 } }) }));
  await a.handleUpdate(update("read it", { reply_to_message: replied({ from, document: { file_id: "d", file_name: "report.pdf" } }) }));
  expect(inbox.map((m) => m.replyTo!.snippet)).toEqual(["[photo]", "[voice]", "[document: report.pdf]"]);
});

test("no reply → no replyTo", async () => {
  const { a, inbox } = adapter();
  await a.handleUpdate(update("hello"));
  expect(inbox[0]!.replyTo).toBeUndefined();
});
