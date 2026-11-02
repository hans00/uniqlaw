// Conformance: every request the adapter sends, and every inbound fixture it parses, is validated
// against JSON Schema generated from @grammyjs/types (tracks the official Telegram Bot API docs;
// Telegram publishes no OpenAPI) — see test/spec/generate.ts. Constraints that exist only in the
// docs' prose (callback_data ≤ 64 bytes, command name pattern, description length) are checked here.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv from "ajv";
import { silentLogger, type InboundMessage } from "@uniqlaw/core";
import plugin, { TelegramAdapter } from "../src/index.ts";
import { TG_REACTION_EMOJIS } from "../src/format.ts";
import { startFakeBotApi } from "./fake-api.ts";
import schemaJson from "./spec/telegram.schema.json";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const schema = schemaJson as any;

const ajv = new Ajv({ allErrors: true, strict: false });
ajv.addSchema(schema, "tg");
const METHOD_TYPE: Record<string, string> = {
  getMe: "GetMe", getUpdates: "GetUpdates", sendMessage: "SendMessage", editMessageText: "EditMessageText",
  deleteMessage: "DeleteMessage", setMessageReaction: "SetMessageReaction", sendChatAction: "SendChatAction",
  setMyCommands: "SetMyCommands", answerCallbackQuery: "AnswerCallbackQuery", getFile: "GetFile",
};
function check(type: string, value: unknown) {
  const v = ajv.getSchema(`tg#/definitions/${type}`)!;
  const ok = v(value);
  if (!ok) throw new Error(`${type} does not conform:\n${JSON.stringify(value)}\n${ajv.errorsText(v.errors, { separator: "\n" })}`);
}

const OWNER = 111;
let api: ReturnType<typeof startFakeBotApi>;
let adapter: TelegramAdapter;
let dir: string;
const inbox: InboundMessage[] = [];
const fixtures: unknown[] = [];
const push = (u: Record<string, unknown>) => { fixtures.push({ update_id: 1, ...u }); api.pushUpdate(u as never); };
const waitFor = async (c: () => boolean, ms = 3000) => { const e = Date.now() + ms; while (!c()) { if (Date.now() > e) throw new Error("timeout"); await Bun.sleep(10); } };
const from = { id: OWNER, is_bot: false, first_name: "Owner", username: "owner" };

beforeAll(async () => {
  api = startFakeBotApi({ botUsername: "uniq_test_bot", botId: 999 });
  dir = mkdtempSync(join(tmpdir(), "uq-tg-conf-"));
  adapter = (await plugin.create(
    { log: silentLogger, instanceId: "t", projectDir: dir, stateDir: dir, timezone: "UTC" },
    plugin.configSchema.parse({ token: api.token, apiBase: api.apiBase, allowedUserIds: [OWNER], pollSeconds: 1 }),
  )) as TelegramAdapter;
  await adapter.start({ message: (m) => inbox.push(m) });

  // Inbound: text DM, group mention, photo+caption, voice, document, callback_query.
  api.addFile("ph", "photos/p.jpg", new Uint8Array([1, 2]));
  api.addFile("vo", "voice/v.oga", new Uint8Array([3]));
  api.addFile("doc", "documents/d.pdf", new Uint8Array([4]));
  push({ message: { message_id: 1, date: 1_700_000_000, chat: { id: OWNER, type: "private", first_name: "Owner" }, from, text: "hello" } });
  push({ message: { message_id: 2, date: 1_700_000_000, chat: { id: -100500, type: "supergroup", title: "G" }, from, text: "@uniq_test_bot hi",
    entities: [{ type: "mention", offset: 0, length: 14 }] } });
  push({ message: { message_id: 3, date: 1_700_000_000, chat: { id: OWNER, type: "private", first_name: "Owner" }, from, caption: "pic",
    photo: [{ file_id: "ph", file_unique_id: "u1", width: 90, height: 90 }] } });
  push({ message: { message_id: 4, date: 1_700_000_000, chat: { id: OWNER, type: "private", first_name: "Owner" }, from,
    voice: { file_id: "vo", file_unique_id: "u2", duration: 2, mime_type: "audio/ogg" } } });
  push({ message: { message_id: 5, date: 1_700_000_000, chat: { id: OWNER, type: "private", first_name: "Owner" }, from,
    document: { file_id: "doc", file_unique_id: "u3", file_name: "d.pdf", mime_type: "application/pdf" } } });
  await waitFor(() => inbox.length === 5);

  // Outbound: every path.
  const target = { platform: "telegram", chatId: String(OWNER), replyToMessageId: "1" };
  await adapter.send(target, "**bold** and `code`");
  await adapter.send({ platform: "telegram", chatId: "-100500", threadId: "7" }, "in a topic");
  api.setRejectHtml(true);
  await adapter.send(target, "falls back to plain");
  api.setRejectHtml(false);
  const ref = (await adapter.send(target, "to edit"))!;
  await adapter.edit(ref, "edited _text_");
  await adapter.react(ref, ["👍", "❤️"]);
  await adapter.delete(ref);
  await adapter.typing({ platform: "telegram", chatId: "-100500", threadId: "7" });
  await adapter.setCommands([{ name: "stop", description: "Interrupt" }, { name: "Model-Switch!", description: "x".repeat(400) }]);
  const choice = adapter.askChoice(target, { title: "Allow?", body: "run `ls`", options: ["Allow", "Deny"], approverIds: [], timeoutMs: 5000 });
  await waitFor(() => api.callsOf("sendMessage").some((c) => c.body.reply_markup));
  const kb = api.callsOf("sendMessage").find((c) => c.body.reply_markup)!.body.reply_markup.inline_keyboard;
  push({ callback_query: { id: "cq1", from, chat_instance: "ci", data: kb[0][0].callback_data,
    message: { message_id: 9, date: 1_700_000_000, chat: { id: OWNER, type: "private", first_name: "Owner" }, text: "Allow?" } } });
  expect(await choice).toBe(0);
  await waitFor(() => api.callsOf("answerCallbackQuery").length > 0);
});

afterAll(async () => { await adapter.stop(); api.stop(); rmSync(dir, { recursive: true, force: true }); });

describe("telegram ↔ Bot API types (@grammyjs/types)", () => {
  test("negative control: the validator rejects non-conforming bodies", () => {
    expect(() => check("SendMessage", { chat_id: 1, text: "x", bogus: true })).toThrow();          // unknown field
    expect(() => check("SendMessage", { chat_id: 1, text: 5 })).toThrow();                         // wrong type
    expect(() => check("SendMessage", { text: "x" })).toThrow();                                   // missing chat_id
    expect(() => check("SetMessageReaction", { chat_id: 1, message_id: 1, reaction: ["👍"] })).toThrow(); // must be ReactionType objects
    expect(() => check("SetMessageReaction", { chat_id: 1, message_id: 1, reaction: [{ type: "emoji", emoji: "🍕" }] })).toThrow(); // not allowed
  });

  test("every outbound request body conforms to its method's parameter type", () => {
    const seen = new Set<string>();
    for (const c of api.calls) {
      const type = METHOD_TYPE[c.method];
      expect(type, `unexpected method ${c.method}`).toBeDefined();
      check(type!, c.body);
      seen.add(c.method);
    }
    expect([...seen].sort()).toEqual(["answerCallbackQuery", "deleteMessage", "editMessageText", "getFile", "getMe", "getUpdates",
      "sendChatAction", "sendMessage", "setMessageReaction", "setMyCommands"]);
  });

  test("every inbound fixture is a valid Update", () => {
    for (const f of fixtures) check("TgUpdate", f);
  });

  test("doc-only constraints: callback_data ≤ 64 bytes, commands [a-z0-9_]{1,32}, description 1–256", () => {
    for (const c of api.callsOf("sendMessage")) {
      for (const row of c.body.reply_markup?.inline_keyboard ?? []) for (const b of row) {
        expect(Buffer.byteLength(b.callback_data, "utf8")).toBeLessThanOrEqual(64);
        expect(b.text.length).toBeGreaterThan(0);
      }
      expect(String(c.body.text).length).toBeLessThanOrEqual(4096);
    }
    for (const c of api.callsOf("setMyCommands")) {
      expect(c.body.commands.length).toBeLessThanOrEqual(100);
      for (const cmd of c.body.commands) {
        expect(cmd.command).toMatch(/^[a-z0-9_]{1,32}$/);
        expect(cmd.description.length).toBeGreaterThanOrEqual(1);
        expect(cmd.description.length).toBeLessThanOrEqual(256);
      }
    }
  });

  test("getUpdates asks only for update kinds that exist", () => {
    const kinds = Object.keys(schema.definitions.TgUpdate?.properties ?? {});
    const asked = api.callsOf("getUpdates")[0]!.body.allowed_updates as string[];
    for (const k of asked) expect(kinds).toContain(k);
  });

  test("the adapter's reaction allowlist equals the official ReactionTypeEmoji set", () => {
    const official = schema.definitions.ReactionTypeEmoji!.properties.emoji.enum;
    expect([...TG_REACTION_EMOJIS].sort()).toEqual([...official].sort());
  });

  test("file download URL follows https://api.telegram.org/file/bot<token>/<file_path>", () => {
    const paths = api.callsOf("getFile").map((c) => c.body.file_id);
    expect(paths.sort()).toEqual(["doc", "ph", "vo"]);
    expect(inbox.flatMap((m) => m.attachments).length).toBe(3); // downloads succeeded via the documented URL shape
  });
});
