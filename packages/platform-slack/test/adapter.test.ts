import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { silentLogger, type InboundMessage } from "@uniqlaw/core";
import plugin, { SlackAdapter, markdownToMrkdwn, slackReactionName } from "../src/index.ts";
import { startFakeSlack } from "./fake-slack.ts";

const OWNER = "U111", FRIEND = "U222", STRANGER = "U333";
let fake: ReturnType<typeof startFakeSlack>;
let adapter: SlackAdapter;
let inbox: InboundMessage[];
let dir: string;
const waitFor = async <T>(fn: () => T | undefined | false, ms = 3000): Promise<T> => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await Bun.sleep(10); }
  throw new Error("waitFor timed out");
};
let n = 1;
const ev = (user: string, text: string, extra: Record<string, unknown> = {}) =>
  ({ type: "message", user, text, channel: "C1", channel_type: "channel", ts: `1700000${n++}.000200`, ...extra });

beforeEach(async () => {
  fake = startFakeSlack();
  dir = mkdtempSync(join(tmpdir(), "uq-sl-"));
  adapter = (await plugin.create({ log: silentLogger, instanceId: "t", projectDir: dir, stateDir: dir, timezone: "UTC" },
    plugin.configSchema.parse({ appToken: "xapp-test", botToken: "xoxb-test", webApiBase: fake.webApiBase,
      allowedUserIds: [OWNER, FRIEND], allowedBotIds: ["BOK"], operatorUserIds: [OWNER], defaultMode: "channel",
      channels: { CT: { mode: "thread-per-message" } }, messageStream: { mode: "replace" } }))) as SlackAdapter;
  inbox = [];
  await adapter.start({ message: (m) => inbox.push(m) });
});
afterEach(async () => { await adapter.stop(); fake.stop(); rmSync(dir, { recursive: true, force: true }); });

describe("routing", () => {
  test("auth + socket; IM → slack:dm:<userId>; channel → slack:<ch>; envelopes acked; names looked up", async () => {
    expect(adapter.botUser).toBe("UBOT");
    const id = fake.event(ev(OWNER, "hello", { channel: "D9", channel_type: "im" }));
    fake.event(ev(FRIEND, `<@UBOT> look`));
    await waitFor(() => inbox.length === 2);
    expect(fake.acks).toContain(id);
    expect(inbox[0]).toMatchObject({ channelKey: `slack:dm:${OWNER}`, multiparty: false, trusted: true, addressed: true, sender: { id: OWNER, name: `Real ${OWNER}`, username: `n${OWNER}` } });
    expect(inbox[1]).toMatchObject({ channelKey: "slack:C1", multiparty: true, addressed: true, text: "look" });
    expect(adapter.channelKeyForTarget({ platform: "slack", chatId: "D9" })).toBe(`slack:dm:${OWNER}`);
    expect(adapter.channelKeyForTarget(adapter.parseTarget(`slack:dm:${OWNER}`)!)).toBe(`slack:dm:${OWNER}`);
  });

  test("thread-per-message: top-level anchors on its ts, replies join; channel mode threads collapse", async () => {
    fake.event(ev(OWNER, "task A", { channel: "CT", ts: "1700000100.000001" }));
    fake.event(ev(OWNER, "more A", { channel: "CT", ts: "1700000101.000001", thread_ts: "1700000100.000001" }));
    fake.event(ev(OWNER, "in thread", { thread_ts: "1700000050.000001" }));
    await waitFor(() => inbox.length === 3);
    expect(inbox[0]!.channelKey).toBe("slack:CT:1700000100.000001");
    expect(inbox[0]!.replyTarget.threadId).toBe("1700000100.000001");
    expect(inbox[1]!.channelKey).toBe("slack:CT:1700000100.000001");
    expect(inbox[2]).toMatchObject({ channelKey: "slack:C1", replyTarget: { threadId: "1700000050.000001" } });
    expect(adapter.channelKeyForTarget({ platform: "slack", chatId: "CT", threadId: "1700000100.000001" })).toBe("slack:CT:1700000100.000001");
    expect(adapter.channelKeyForTarget({ platform: "slack", chatId: "C1", threadId: "1.2" })).toBe("slack:C1");
    expect(adapter.channelKeyForTarget({ platform: "slack", chatId: "D7" })).toBe("slack:D7"); // unknown DM channel: plain channel key
  });

  test("allowlists, own/edited messages, bots, file_share attachments", async () => {
    fake.event(ev(STRANGER, "no"));
    fake.event(ev(OWNER, "edit", { subtype: "message_changed" }));
    fake.event({ ...ev("", "self"), user: undefined, bot_id: "BBOT", subtype: "bot_message" });
    fake.event({ ...ev("", "other bot"), user: undefined, bot_id: "BX", subtype: "bot_message" });
    fake.event({ ...ev("", "ok bot"), user: undefined, bot_id: "BOK", subtype: "bot_message", username: "helper" });
    fake.addFile("a.png", new Uint8Array([1]));
    fake.event(ev(OWNER, "", { subtype: "file_share", files: [{ url_private_download: `${fake.fileBase}/a.png`, mimetype: "image/png", name: "a.png" }] }));
    await waitFor(() => inbox.length === 2);
    await Bun.sleep(50);
    expect(inbox[0]).toMatchObject({ text: "ok bot", sender: { id: "BOK", isBot: true, name: "helper" } });
    expect(inbox[1]!.attachments[0]!.kind).toBe("image");
    expect(existsSync(inbox[1]!.attachments[0]!.path)).toBe(true);
  });
});

describe("outbound", () => {
  test("send (mrkdwn, chunked, threaded), edit, delete, react with shortcodes", async () => {
    const ref = await adapter.send({ platform: "slack", chatId: "C1", threadId: "1.5" }, `**bold** [x](https://e.com)\n${"a".repeat(4000)}`);
    const posts = fake.callsOf("chat.postMessage");
    expect(posts).toHaveLength(2);
    expect(posts[0]!.body).toMatchObject({ channel: "C1", thread_ts: "1.5" });
    expect(posts[0]!.body.text.startsWith("*bold* <https://e.com|x>")).toBe(true);
    expect(await adapter.edit(ref!, "new")).toBe(true);
    expect(fake.callsOf("chat.update")[0]!.body).toMatchObject({ channel: "C1", ts: ref!.messageId, text: "new" });
    expect(await adapter.delete(ref!)).toBe(true);
    await adapter.react(ref!, ["👍", ":fire:", "🦄"]);
    expect(fake.callsOf("reactions.add").map((c) => c.body.name)).toEqual(["+1", "fire"]);
  });

  test("operator DM via conversations.open; parseTarget", async () => {
    const [t] = adapter.operatorTargets();
    await adapter.send(t!, "hi");
    expect(fake.callsOf("conversations.open")[0]!.body).toEqual({ users: OWNER });
    expect(fake.callsOf("chat.postMessage")[0]!.body.channel).toBe(`D${OWNER}`);
    expect(adapter.parseTarget("slack:C1:1700000000.000100")).toEqual({ platform: "slack", chatId: "C1", threadId: "1700000000.000100" });
    expect(adapter.parseTarget("slack:dm:U1")).toEqual({ platform: "slack", chatId: "dm:U1" });
    expect(adapter.parseTarget("discord:1")).toBeUndefined();
  });

  test("format helpers", () => {
    expect(markdownToMrkdwn("# Title\n- item\n`**code**`")).toBe("*Title*\n• item\n`**code**`");
    expect(slackReactionName("thumbsup")).toBe("thumbsup");
  });
});

describe("askChoice", () => {
  test("operators answer via block_actions; strangers get an ephemeral; message updated", async () => {
    const p = adapter.askChoice({ platform: "slack", chatId: "C1" }, { title: "Run?", body: "rm x", options: ["Allow", "Deny"], approverIds: [], timeoutMs: 5000 });
    const post = await waitFor(() => fake.callsOf("chat.postMessage").find((c) => c.body.blocks));
    const btns = post.body.blocks[1].elements;
    expect(btns.map((b: { style?: string }) => b.style)).toEqual(["primary", "danger"]);
    fake.interactive({ type: "block_actions", user: { id: FRIEND }, channel: { id: "C1" }, actions: [{ action_id: btns[0].action_id }] });
    await waitFor(() => fake.callsOf("chat.postEphemeral")[0]);
    const id = fake.interactive({ type: "block_actions", user: { id: OWNER }, channel: { id: "C1" }, actions: [{ action_id: btns[0].action_id }] });
    expect(await p).toBe(0);
    expect(fake.acks).toContain(id);
    expect(fake.callsOf("chat.update").at(-1)!.body.text).toContain("✅ Allow");
  });

  test("timeout resolves null and updates the message", async () => {
    expect(await adapter.askChoice({ platform: "slack", chatId: "C1" }, { title: "Q", options: ["a"], approverIds: [FRIEND], timeoutMs: 80 })).toBeNull();
    expect(fake.callsOf("chat.update").at(-1)!.body.text).toContain("Timed out");
  });
});
