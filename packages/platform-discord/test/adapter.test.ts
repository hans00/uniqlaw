import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { silentLogger, type InboundMessage } from "@uniqlaw/core";
import plugin, { DiscordAdapter } from "../src/index.ts";
import { startFakeDiscord } from "./fake-discord.ts";

const OWNER = "111", FRIEND = "222", STRANGER = "333", BOT_FRIEND = "444";
const CH = "1001", MENTION_CH = "1002", OFF_CH = "1003";
let fake: ReturnType<typeof startFakeDiscord>;
let adapter: DiscordAdapter;
let inbox: InboundMessage[];
let dir: string;

const waitFor = async <T>(fn: () => T | undefined | false, ms = 3000): Promise<T> => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await Bun.sleep(10); }
  throw new Error("waitFor timed out");
};
let mid = 1;
const msg = (author: string, content: string, extra: Record<string, unknown> = {}) =>
  ({ id: String(mid++), channel_id: CH, guild_id: "g1", author: { id: author, username: `u${author}`, global_name: `User ${author}` }, content, mentions: [], ...extra });

beforeEach(async () => {
  fake = startFakeDiscord();
  dir = mkdtempSync(join(tmpdir(), "uq-dc-"));
  adapter = (await plugin.create({ log: silentLogger, instanceId: "t", projectDir: dir, stateDir: dir, timezone: "UTC" },
    plugin.configSchema.parse({
      token: "TEST-DC", apiBase: fake.apiBase, gatewayUrl: fake.gatewayUrl, cdnBase: fake.cdnBase,
      allowedUserIds: [OWNER, FRIEND], allowedBotIds: [BOT_FRIEND], operatorUserIds: [OWNER],
      channels: { [CH]: { enabled: true, requireMention: false, ignoreOtherMentions: true }, [MENTION_CH]: { enabled: true, requireMention: true, ignoreOtherMentions: false }, [OFF_CH]: { enabled: false, requireMention: false, ignoreOtherMentions: false } },
      messageStream: { mode: "off" }, // v2 key, must be tolerated
    }))) as DiscordAdapter;
  inbox = [];
  await adapter.start({ message: (m) => inbox.push(m) });
});
afterEach(async () => { await adapter.stop(); fake.stop(); rmSync(dir, { recursive: true, force: true }); });

describe("gateway + routing", () => {
  test("identifies with intents and becomes READY", () => {
    expect(fake.identifies[0]).toMatchObject({ token: "TEST-DC" });
    expect(fake.identifies[0].intents & (1 << 15)).toBeTruthy(); // MESSAGE_CONTENT
    expect(adapter.botUser).toBe(fake.botId);
  });

  test("DM → discord:dm:<userId>; guild channel → discord:<id>; multiparty/trusted/addressed", async () => {
    fake.dispatch("MESSAGE_CREATE", { ...msg(OWNER, "hello dm"), guild_id: undefined, channel_id: "555" });
    fake.dispatch("MESSAGE_CREATE", msg(FRIEND, "hi channel"));
    await waitFor(() => inbox.length === 2);
    expect(inbox[0]).toMatchObject({ channelKey: `discord:dm:${OWNER}`, multiparty: false, trusted: true, addressed: true, text: "hello dm",
      replyTarget: { platform: "discord", chatId: "555" }, sender: { id: OWNER, name: "User 111", username: "u111" } });
    expect(inbox[1]).toMatchObject({ channelKey: `discord:${CH}`, multiparty: true, trusted: false, addressed: false });
    expect(adapter.channelKeyForTarget({ platform: "discord", chatId: "555" })).toBe(`discord:dm:${OWNER}`);
    expect(adapter.channelKeyForTarget(adapter.parseTarget(`discord:dm:${OWNER}`)!)).toBe(`discord:dm:${OWNER}`);
    expect(adapter.channelKeyForTarget({ platform: "discord", chatId: CH })).toBe(`discord:${CH}`);
  });

  test("allowlists, disabled/unlisted channels, requireMention, ignoreOtherMentions, own messages", async () => {
    fake.dispatch("MESSAGE_CREATE", msg(STRANGER, "nope"));
    fake.dispatch("MESSAGE_CREATE", msg("999", "unknown bot", { author: { id: "999", bot: true } }));
    fake.dispatch("MESSAGE_CREATE", msg(fake.botId, "myself"));
    fake.dispatch("MESSAGE_CREATE", msg(OWNER, "off", { channel_id: OFF_CH }));
    fake.dispatch("MESSAGE_CREATE", msg(OWNER, "unlisted", { channel_id: "1999" }));
    fake.dispatch("MESSAGE_CREATE", msg(OWNER, "no mention", { channel_id: MENTION_CH }));
    fake.dispatch("MESSAGE_CREATE", msg(OWNER, "hey <@222>", { mentions: [{ id: FRIEND }] }));
    fake.dispatch("MESSAGE_CREATE", msg(OWNER, `<@${fake.botId}> do it`, { channel_id: MENTION_CH, mentions: [{ id: fake.botId }] }));
    fake.dispatch("MESSAGE_CREATE", msg(BOT_FRIEND, "allowed bot", { author: { id: BOT_FRIEND, bot: true, username: "b" } }));
    await waitFor(() => inbox.length === 2);
    await Bun.sleep(50);
    expect(inbox.map((m) => m.text)).toEqual(["do it", "allowed bot"]);
    expect(inbox[0]!.addressed).toBe(true);
    expect(inbox[1]!.sender.isBot).toBe(true);
  });

  test("attachments (voice flag) and stickers are downloaded", async () => {
    fake.addFile("v.ogg", new Uint8Array([9, 9]));
    fake.dispatch("MESSAGE_CREATE", msg(OWNER, "", { flags: 1 << 13,
      attachments: [{ url: `${fake.fileBase}/v.ogg`, filename: "voice.ogg", content_type: "audio/ogg", duration_secs: 3 }],
      sticker_items: [{ id: "77", name: "wave" }] }));
    const m = await waitFor(() => inbox[0]);
    expect(m.attachments.map((a) => a.kind)).toEqual(["voice", "sticker"]);
    expect(m.attachments[0]!.durationSec).toBe(3);
    expect(existsSync(m.attachments[0]!.path)).toBe(true);
  });
});

describe("outbound", () => {
  test("send chunks at the limit, replies to the first chunk; edit/delete/react/typing", async () => {
    const ref = await adapter.send({ platform: "discord", chatId: CH, replyToMessageId: "42" }, "a".repeat(2500));
    const posts = fake.callsTo("POST", /\/channels\/1001\/messages$/);
    expect(posts).toHaveLength(2);
    expect(posts[0]!.body.message_reference).toMatchObject({ message_id: "42" });
    expect(posts[1]!.body.message_reference).toBeUndefined();
    expect(ref).toMatchObject({ platform: "discord", chatId: CH });
    expect(await adapter.edit(ref!, "edited")).toBe(true);
    expect(fake.callsTo("PATCH", /messages\/\d+$/)[0]!.body).toEqual({ content: "edited" });
    expect(await adapter.edit(ref!, "x".repeat(3000))).toBe(false);
    expect(await adapter.delete(ref!)).toBe(true);
    await adapter.react(ref!, ["👍", ":fire:"]);
    expect(fake.callsTo("PUT", /reactions\//).map((c) => decodeURIComponent(c.path.split("/")[6]!))).toEqual(["👍", "fire"]);
    await adapter.typing({ platform: "discord", chatId: CH });
    expect(fake.callsTo("POST", /\/typing$/)).toHaveLength(1);
  });

  test("operator targets open a DM lazily; parseTarget", async () => {
    const [t] = adapter.operatorTargets();
    expect(t).toEqual({ platform: "discord", chatId: `dm:${OWNER}` });
    await adapter.send(t!, "ping");
    expect(fake.callsTo("POST", /^\/users\/@me\/channels$/)[0]!.body).toEqual({ recipient_id: OWNER });
    expect(fake.callsTo("POST", new RegExp(`/channels/77${OWNER}/messages`))).toHaveLength(1);
    expect(adapter.parseTarget("discord:123")).toEqual({ platform: "discord", chatId: "123" });
    expect(adapter.parseTarget("telegram:1")).toBeUndefined();
    expect(adapter.channelKeyForTarget(t!)).toBe(`discord:dm:${OWNER}`);
  });

  test("setCommands registers global commands with an args option", async () => {
    await adapter.setCommands([{ name: "stop", description: "Stop" }, { name: "Model", description: "m" }, { name: "stop", description: "dup" }]);
    const put = fake.callsTo("PUT", /^\/applications\/app1\/commands$/)[0]!;
    expect(put.body.map((c: { name: string }) => c.name)).toEqual(["stop", "model"]);
    expect(put.body[0].options[0]).toMatchObject({ name: "args", type: 3 });
  });

  test("slash command interaction → inbound text + ack", async () => {
    fake.dispatch("INTERACTION_CREATE", { id: "i1", token: "tok", type: 2, channel_id: CH, guild_id: "g1", member: { user: { id: OWNER, username: "o" } },
      data: { name: "model", options: [{ name: "args", type: 3, value: "opus" }] } });
    const m = await waitFor(() => inbox[0]);
    expect(m).toMatchObject({ text: "/model opus", channelKey: `discord:${CH}`, trusted: true });
    expect(fake.callsTo("POST", /^\/interactions\/i1\/tok\/callback$/)[0]!.body.type).toBe(4);
  });
});

describe("askChoice", () => {
  const press = (user: string, customId: string, id = String(mid++)) =>
    fake.dispatch("INTERACTION_CREATE", { id, token: "t", type: 3, channel_id: CH, member: { user: { id: user, username: `u${user}` } }, data: { custom_id: customId } });

  test("operators answer (empty approverIds); strangers are refused; message updated", async () => {
    const p = adapter.askChoice({ platform: "discord", chatId: CH }, { title: "Run?", body: "rm x", options: ["Allow", "Deny"], approverIds: [], timeoutMs: 5000 });
    const sent = await waitFor(() => fake.callsTo("POST", /\/channels\/1001\/messages$/).find((c) => c.body.components));
    const buttons = sent.body.components[0].components;
    expect(buttons.map((b: { label: string; style: number }) => [b.label, b.style])).toEqual([["Allow", 3], ["Deny", 4]]);
    press(FRIEND, buttons[0].custom_id, "x1");
    await waitFor(() => fake.callsTo("POST", /interactions\/x1\//)[0]);
    expect(fake.callsTo("POST", /interactions\/x1\//)[0]!.body.data.flags).toBe(64);
    press(OWNER, buttons[1].custom_id, "x2");
    expect(await p).toBe(1);
    const upd = fake.callsTo("POST", /interactions\/x2\//)[0]!.body;
    expect(upd.type).toBe(7);
    expect(upd.data.components).toEqual([]);
    expect(upd.data.content).toContain("✅ Deny");
  });

  test("explicit approverIds and timeout", async () => {
    const r = await adapter.askChoice({ platform: "discord", chatId: CH }, { title: "Q", options: ["a"], approverIds: [FRIEND], timeoutMs: 80 });
    expect(r).toBeNull();
    const patch = fake.callsTo("PATCH", /messages\/\d+$/).at(-1)!;
    expect(patch.body.components).toEqual([]);
    expect(patch.body.content).toContain("Timed out");
  });
});
