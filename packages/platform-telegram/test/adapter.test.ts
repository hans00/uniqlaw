import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { silentLogger, type InboundMessage, type UnknownSender } from "@uniqlaw/core";
import plugin, { TelegramAdapter } from "../src/index.ts";
import { startFakeBotApi } from "./fake-api.ts";

const OWNER = 111;
const FRIEND = 222;
const STRANGER = 333;
const GROUP = -100500;

let api: ReturnType<typeof startFakeBotApi>;
let adapter: TelegramAdapter;
let inbox: InboundMessage[];
let dir: string;

async function waitFor<T>(fn: () => T | undefined | false, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await Bun.sleep(10);
  }
  throw new Error("waitFor timed out");
}

const user = (id: number, extra: Record<string, unknown> = {}) => ({ id, first_name: `U${id}`, username: `u${id}`, ...extra });
const dm = (from: number, text: string, extra: Record<string, unknown> = {}) =>
  ({ message: { message_id: Math.floor(Math.random() * 1e6), from: user(from), chat: { id: from, type: "private" }, date: 1_700_000_000, text, ...extra } as any });
const grp = (from: number, text: string, extra: Record<string, unknown> = {}) =>
  ({ message: { message_id: Math.floor(Math.random() * 1e6), from: user(from), chat: { id: GROUP, type: "supergroup" }, date: 1_700_000_000, text, ...extra } as any });

beforeEach(async () => {
  api = startFakeBotApi({ botUsername: "uniq_test_bot", botId: 999 });
  dir = mkdtempSync(join(tmpdir(), "uq-tg-"));
  adapter = (await plugin.create(
    { log: silentLogger, instanceId: "t", projectDir: dir, stateDir: dir, timezone: "UTC" },
    plugin.configSchema.parse({ token: api.token, apiBase: api.apiBase, allowedUserIds: [OWNER, FRIEND], operatorUserIds: [OWNER], pollSeconds: 1 }),
  )) as TelegramAdapter;
  inbox = [];
  await adapter.start({ message: (m) => inbox.push(m) });
});

afterEach(async () => {
  await adapter.stop();
  api.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe("inbound routing", () => {
  test("stop confirms the handled offset, so a restarted daemon doesn't get the last message again", async () => {
    api.pushUpdate(dm(OWNER, "first"));
    await waitFor(() => inbox.length === 1);
    await adapter.stop();
    const last = api.callsOf("getUpdates").at(-1)!.body;
    expect(last).toMatchObject({ timeout: 0, limit: 1 });
    expect(Number(last.offset)).toBeGreaterThan(0);
  });

  test("DM is its own session (telegram:<userId>), single-party, trusted operator", async () => {
    api.pushUpdate(dm(OWNER, "hello"));
    const m = await waitFor(() => inbox[0]);
    expect(m.channelKey).toBe(`telegram:${OWNER}`);
    expect(m.multiparty).toBe(false);
    expect(m.trusted).toBe(true);
    expect(m.addressed).toBe(true);
    expect(m.replyTarget).toMatchObject({ platform: "telegram", chatId: String(OWNER) });
    expect(m.replyTarget.replyToMessageId).toBe(m.ref.messageId);
    expect(m.sender).toMatchObject({ id: String(OWNER), username: `u${OWNER}` });
  });

  test("group gets telegram:<chatId>, multiparty; non-operator is untrusted", async () => {
    api.pushUpdate(grp(FRIEND, "hi all"));
    const m = await waitFor(() => inbox[0]);
    expect(m.channelKey).toBe(`telegram:${GROUP}`);
    expect(m.multiparty).toBe(true);
    expect(m.trusted).toBe(false);
    expect(m.addressed).toBe(false);
  });

  test("allowlist rejects strangers and bots", async () => {
    api.pushUpdate(dm(STRANGER, "let me in"));
    api.pushUpdate({ message: { message_id: 5, from: user(OWNER, { is_bot: true }), chat: { id: OWNER, type: "private" }, date: 0, text: "bot" } as any });
    api.pushUpdate(dm(OWNER, "marker"));
    await waitFor(() => inbox.find((m) => m.text === "marker"));
    expect(inbox.map((m) => m.text)).toEqual(["marker"]);
  });

  test("a stranger's DM is reported for pairing (groups are not); paired users are accepted but untrusted", async () => {
    const strangers: UnknownSender[] = [];
    const a = new TelegramAdapter({ token: api.token, apiBase: api.apiBase, allowedUserIds: [String(OWNER)], allowedGroupIds: [],
      operatorUserIds: [String(OWNER)], pollSeconds: 0, attachmentsDir: dir, log: silentLogger });
    const got: InboundMessage[] = [];
    const sink = { message: (m: InboundMessage) => got.push(m), unknownSender: (u: UnknownSender) => strangers.push(u) };
    (a as any).sink = sink; // no start(): drive handleUpdate directly
    await a.handleUpdate({ update_id: 3, ...dm(STRANGER, "let me in") } as any);
    await a.handleUpdate({ update_id: 4, ...grp(STRANGER, "group hi") } as any);
    expect(got).toHaveLength(0);
    expect(strangers).toEqual([{ platform: "telegram", userId: String(STRANGER), name: expect.any(String), username: `u${STRANGER}`,
      replyTarget: { platform: "telegram", chatId: String(STRANGER) } }]);
    a.setPairedUsers([String(STRANGER)]);
    await a.handleUpdate({ update_id: 5, ...dm(STRANGER, "thanks") } as any);
    expect(got.map((m) => [m.text, m.trusted])).toEqual([["thanks", false]]);
    expect(strangers).toHaveLength(1);
  });

  test("allowedGroupIds restricts groups", async () => {
    const restricted = new TelegramAdapter({
      token: api.token, apiBase: api.apiBase, allowedUserIds: [String(OWNER)], allowedGroupIds: ["-1"],
      operatorUserIds: [String(OWNER)], pollSeconds: 0, attachmentsDir: dir, log: silentLogger,
    });
    const got: InboundMessage[] = [];
    await (restricted as any).start({ message: (m: InboundMessage) => got.push(m) }).catch(() => {});
    await restricted.handleUpdate({ update_id: 0, ...grp(OWNER, "x") });
    await restricted.handleUpdate({ update_id: 0, ...dm(OWNER, "dm still ok") });
    await restricted.stop();
    expect(got.map((m) => m.text)).toEqual(["dm still ok"]);
  });

  test("addressed: @mention, reply-to-bot, text_mention; /cmd@bot suffix stripped", async () => {
    api.pushUpdate(grp(OWNER, "hey @uniq_test_bot look"));
    api.pushUpdate(grp(OWNER, "replying", { reply_to_message: { message_id: 1, from: { id: 999, is_bot: true }, chat: { id: GROUP, type: "supergroup" }, date: 0 } }));
    api.pushUpdate(grp(OWNER, "Bot pls", { entities: [{ type: "text_mention", offset: 0, length: 3, user: { id: 999 } }] }));
    api.pushUpdate(grp(OWNER, "/status@uniq_test_bot now"));
    api.pushUpdate(grp(OWNER, "unrelated chatter"));
    await waitFor(() => inbox.length === 5);
    expect(inbox.map((m) => m.addressed)).toEqual([true, true, true, true, false]);
    expect(inbox[3]!.text).toBe("/status now");
  });

  test("forum topic: threadId flows into replyTarget", async () => {
    api.pushUpdate(grp(OWNER, "in topic", { message_thread_id: 42, is_topic_message: true }));
    const m = await waitFor(() => inbox[0]);
    expect(m.replyTarget.threadId).toBe("42");
    expect(m.channelKey).toBe(`telegram:${GROUP}`);
  });

  test("attachments: photo (largest) + voice downloaded to stateDir/attachments", async () => {
    api.addFile("small", "photos/s.jpg", new Uint8Array([1]));
    api.addFile("big", "photos/b.jpg", new Uint8Array([1, 2, 3]));
    api.addFile("v1", "voice/a.oga", new Uint8Array([9, 9]));
    api.pushUpdate(dm(OWNER, "", {
      text: undefined, caption: "look",
      photo: [{ file_id: "small", width: 1, height: 1 }, { file_id: "big", width: 9, height: 9 }],
      voice: { file_id: "v1", duration: 3, mime_type: "audio/ogg" },
    }));
    const m = await waitFor(() => inbox[0]);
    expect(m.text).toBe("look");
    expect(m.attachments.map((a) => a.kind)).toEqual(["image", "voice"]);
    expect(m.attachments[0]!.path.startsWith(join(dir, "attachments", "telegram"))).toBe(true);
    expect([...readFileSync(m.attachments[0]!.path)]).toEqual([1, 2, 3]);
    expect(m.attachments[1]).toMatchObject({ mime: "audio/ogg", durationSec: 3 });
  });

  test("failed attachment download is skipped, message still delivered", async () => {
    api.pushUpdate(dm(OWNER, "", { text: undefined, caption: "doc", document: { file_id: "missing", file_name: "x.pdf" } }));
    const m = await waitFor(() => inbox[0]);
    expect(m.text).toBe("doc");
    expect(m.attachments).toEqual([]);
  });
});

describe("outbound", () => {
  const target = { platform: "telegram", chatId: String(OWNER), replyToMessageId: "77" };

  test("sendFile picks the upload method by kind, falls back to sendDocument", async () => {
    const f = join(dir, "note.ogg");
    await Bun.write(f, new Uint8Array([1, 2, 3]));
    const ref = await adapter.sendFile(target, { path: f, name: "note.ogg", kind: "voice", caption: "listen" });
    expect(ref).toMatchObject({ platform: "telegram", chatId: String(OWNER) });
    const v = api.callsOf("sendVoice")[0]!.body;
    expect(v).toMatchObject({ chat_id: String(OWNER), caption: "listen", voice: { name: "note.ogg", size: 3 } });
    expect(JSON.parse(v.reply_parameters)).toMatchObject({ message_id: 77 });

    const api2 = startFakeBotApi({ rejectUpload: ["sendPhoto"] });
    const a2 = (await plugin.create({ log: silentLogger, instanceId: "t", projectDir: dir, stateDir: dir, timezone: "UTC" },
      plugin.configSchema.parse({ token: api2.token, apiBase: api2.apiBase, allowedUserIds: [OWNER] }))) as TelegramAdapter;
    expect(await a2.sendFile(target, { path: f, name: "big.png", kind: "image" })).toBeDefined();
    expect(api2.callsOf("sendDocument")[0]!.body.document).toMatchObject({ name: "big.png" });
    api2.stop();
  });

  test("send converts markdown to HTML and quotes only the first chunk", async () => {
    const long = Array.from({ length: 30 }, (_, i) => `**para ${i}** ${"x".repeat(200)}`).join("\n\n");
    const ref = await adapter.send(target, long);
    const sends = api.callsOf("sendMessage");
    expect(sends.length).toBeGreaterThan(1);
    expect(sends.every((c) => c.body.text.length <= 3800)).toBe(true);
    expect(sends[0]!.body.parse_mode).toBe("HTML");
    expect(sends[0]!.body.text).toContain("<b>para 0</b>");
    expect(sends[0]!.body.reply_parameters).toEqual({ message_id: 77, allow_sending_without_reply: true });
    expect(sends[1]!.body.reply_parameters).toBeUndefined();
    expect(ref).toMatchObject({ platform: "telegram", chatId: String(OWNER) });
  });

  test("HTML rejected → plain-text fallback", async () => {
    api.setRejectHtml(true);
    const ref = await adapter.send(target, "a <b> & `code`");
    const sends = api.callsOf("sendMessage");
    expect(sends.length).toBe(2);
    expect(sends[1]!.body.parse_mode).toBeUndefined();
    expect(sends[1]!.body.text).toBe("a <b> & code");
    expect(ref).toBeDefined();
  });

  test("edit single chunk; multi-chunk edit refused", async () => {
    const ref = { platform: "telegram", chatId: String(OWNER), messageId: "5" };
    expect(await adapter.edit(ref, "**new**")).toBe(true);
    expect(api.callsOf("editMessageText")[0]!.body).toMatchObject({ message_id: 5, text: "<b>new</b>", parse_mode: "HTML" });
    expect(await adapter.edit(ref, "y".repeat(5000))).toBe(false);
  });

  test("a single over-long line is split, not truncated", async () => {
    await adapter.send(target, "z".repeat(9000));
    const sends = api.callsOf("sendMessage");
    expect(sends.length).toBe(3);
    expect(sends.map((c) => c.body.text).join("")).toBe("z".repeat(9000));
  });

  test("react drops unsupported emojis and normalizes variation selectors", async () => {
    await adapter.react({ platform: "telegram", chatId: String(OWNER), messageId: "5" }, ["❤️", "🌸", "👍"]);
    const r = api.callsOf("setMessageReaction")[0]!.body;
    expect(r.reaction).toEqual([{ type: "emoji", emoji: "❤" }, { type: "emoji", emoji: "👍" }]);
    await adapter.react({ platform: "telegram", chatId: String(OWNER), messageId: "5" }, ["🌸"]);
    expect(api.callsOf("setMessageReaction").length).toBe(1); // all unsupported → no call
  });

  test("setCommands normalizes, dedupes, caps at 100", async () => {
    const cmds = [{ name: "/claudeclaw2:status", description: "s" }, { name: "claudeclaw2_status", description: "dup" },
      { name: "Model", description: "" }, ...Array.from({ length: 150 }, (_, i) => ({ name: `c${i}`, description: "d" }))];
    await adapter.setCommands(cmds);
    const body = api.callsOf("setMyCommands")[0]!.body;
    expect(body.commands[0]).toEqual({ command: "claudeclaw2_status", description: "s" });
    expect(body.commands[1]).toEqual({ command: "model", description: "-" });
    expect(body.commands.length).toBe(100);
  });

  test("typing / delete / targets", async () => {
    await adapter.typing({ platform: "telegram", chatId: String(GROUP), threadId: "42" });
    expect(api.callsOf("sendChatAction")[0]!.body).toEqual({ chat_id: String(GROUP), action: "typing", message_thread_id: 42 });
    expect(await adapter.delete({ platform: "telegram", chatId: "1", messageId: "2" })).toBe(true);
    expect(adapter.operatorTargets()).toEqual([{ platform: "telegram", chatId: String(OWNER) }]);
    expect(adapter.parseTarget("telegram:-100500:7")).toEqual({ platform: "telegram", chatId: "-100500", threadId: "7" });
    expect(adapter.parseTarget("discord:1")).toBeUndefined();
    expect(adapter.channelKeyForTarget({ platform: "telegram", chatId: "111" })).toBe("telegram:111");
    expect(adapter.channelKeyForTarget({ platform: "telegram", chatId: "-100500" })).toBe("telegram:-100500");
  });
});

describe("askChoice", () => {
  const target = { platform: "telegram", chatId: String(OWNER) };
  const req = (timeoutMs = 3000) => ({ title: "Allow Bash?", body: "`rm -rf work/`", options: ["Yes", "No"], approverIds: [String(OWNER)], timeoutMs });
  const press = (from: number, data: string) => api.pushUpdate({ callback_query: { id: `cb${Math.random()}`, from: user(from), data } } as any);
  const tokenOf = () => (api.callsOf("sendMessage").at(-1)!.body.reply_markup.inline_keyboard[1][0].callback_data as string).split(":")[1];

  test("approver presses → index, keyboard replaced with outcome", async () => {
    const p = adapter.askChoice(target, req());
    await waitFor(() => api.callsOf("sendMessage").length);
    const tok = tokenOf();
    press(OWNER, `c:${tok}:1`);
    expect(await p).toBe(1);
    const edit = api.callsOf("editMessageText").at(-1)!.body;
    expect(edit.text).toContain("✅ No — U111");
    expect(edit.reply_markup).toBeUndefined();
  });

  test("unauthorized presser is refused; approver still decides", async () => {
    const p = adapter.askChoice(target, req());
    await waitFor(() => api.callsOf("sendMessage").length);
    const tok = tokenOf();
    press(FRIEND, `c:${tok}:0`);
    await waitFor(() => api.callsOf("answerCallbackQuery").find((c) => /not allowed/.test(c.body.text)));
    press(OWNER, `c:${tok}:0`);
    expect(await p).toBe(0);
  });

  test("empty approverIds = configured operators only", async () => {
    const p = adapter.askChoice(target, { ...req(), approverIds: [] });
    await waitFor(() => api.callsOf("sendMessage").length);
    const tok = tokenOf();
    press(FRIEND, `c:${tok}:0`); // allowed user, but not an operator
    await waitFor(() => api.callsOf("answerCallbackQuery").find((c) => /not allowed/.test(c.body.text)));
    press(OWNER, `c:${tok}:1`);
    expect(await p).toBe(1);
  });

  test("timeout → null and message updated; late press says Expired", async () => {
    const p = adapter.askChoice(target, req(150));
    await waitFor(() => api.callsOf("sendMessage").length);
    const tok = tokenOf();
    expect(await p).toBeNull();
    expect(api.callsOf("editMessageText").at(-1)!.body.text).toContain("Timed out");
    press(OWNER, `c:${tok}:0`);
    await waitFor(() => api.callsOf("answerCallbackQuery").find((c) => c.body.text === "Expired"));
  });

  test("timeoutMs 0 (approval.timeoutSec 0) waits until answered", async () => {
    const p = adapter.askChoice(target, req(0));
    await waitFor(() => api.callsOf("sendMessage").length);
    const tok = tokenOf();
    let settled = false;
    void p.then(() => { settled = true; });
    await Bun.sleep(100);
    expect(settled).toBe(false);
    expect(api.callsOf("editMessageText").some((c) => /Timed out/.test(c.body.text))).toBe(false);
    press(OWNER, `c:${tok}:0`);
    expect(await p).toBe(0);
  });

  test("signal abort (settled elsewhere): resolves null, message says cancelled, a late press says Expired", async () => {
    const ac = new AbortController();
    const p = adapter.askChoice(target, { ...req(0), signal: ac.signal });
    await waitFor(() => api.callsOf("sendMessage").length);
    const tok = tokenOf();
    ac.abort();
    expect(await p).toBeNull();
    expect(api.callsOf("editMessageText").at(-1)!.body.text).toContain("Cancelled — resolved elsewhere");
    press(OWNER, `c:${tok}:0`);
    await waitFor(() => api.callsOf("answerCallbackQuery").find((c) => c.body.text === "Expired"));
  });

  test("stop() resolves pending choices with null", async () => {
    const p = adapter.askChoice(target, req(60_000));
    await waitFor(() => api.callsOf("sendMessage").length);
    await adapter.stop();
    expect(await p).toBeNull();
  });
});
