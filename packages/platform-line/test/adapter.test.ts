import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { silentLogger, type InboundMessage } from "@uniqlaw/core";
import plugin, { LineAdapter, markdownToPlain } from "../src/index.ts";
import { startFakeLine } from "./fake-line.ts";

const OWNER = "U" + "1".repeat(32), FRIEND = "U" + "2".repeat(32), STRANGER = "U" + "3".repeat(32);
const GROUP = "C" + "a".repeat(32), OPEN_GROUP = "C" + "b".repeat(32);
const SECRET = "line-secret";
let fake: ReturnType<typeof startFakeLine>;
let adapter: LineAdapter;
let inbox: InboundMessage[];
let dir: string;
const waitFor = async <T>(fn: () => T | undefined | false, ms = 3000): Promise<T> => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await Bun.sleep(10); }
  throw new Error("waitFor timed out");
};
let mid = 100;
const userSrc = (u: string) => ({ type: "user", userId: u });
const groupSrc = (g: string, u: string) => ({ type: "group", groupId: g, userId: u });
const textEv = (source: object, text: string, extra: Record<string, unknown> = {}) =>
  ({ type: "message", replyToken: `rt${mid}`, source, message: { id: String(mid++), type: "text", text, ...extra } });
async function post(events: unknown[], secret = SECRET) {
  const body = JSON.stringify({ events });
  const sig = createHmac("sha256", secret).update(body).digest("base64");
  return fetch(adapter.webhookUrl!, { method: "POST", headers: { "x-line-signature": sig, "content-type": "application/json" }, body });
}

beforeEach(async () => {
  fake = startFakeLine();
  dir = mkdtempSync(join(tmpdir(), "uq-line-"));
  adapter = (await plugin.create({ log: silentLogger, instanceId: "t", projectDir: dir, stateDir: dir, timezone: "UTC" },
    plugin.configSchema.parse({ channelAccessToken: "LINE-TOKEN", channelSecret: SECRET, webhookPort: 0, webhookHost: "127.0.0.1",
      apiBase: fake.apiBase, dataApiBase: fake.dataApiBase, allowedUserIds: [OWNER, FRIEND], allowedGroupIds: [OPEN_GROUP], operatorUserIds: [OWNER] }))) as LineAdapter;
  inbox = [];
  await adapter.start({ message: (m) => inbox.push(m) });
});
afterEach(async () => { await adapter.stop(); fake.stop(); rmSync(dir, { recursive: true, force: true }); });

describe("webhook + routing", () => {
  test("signature is enforced", async () => {
    expect((await post([textEv(userSrc(OWNER), "x")], "wrong")).status).toBe(401);
    expect((await post([textEv(userSrc(OWNER), "hello")])).status).toBe(200);
    await waitFor(() => inbox.length === 1);
    expect(inbox[0]).toMatchObject({ channelKey: `line:${OWNER}`, multiparty: false, trusted: true, addressed: true, text: "hello",
      sender: { id: OWNER, name: `Name ${OWNER}` }, replyTarget: { platform: "line", chatId: OWNER } });
  });

  test("groups → line:<id>; allowlist by user or open group; mentions; stickers/location", async () => {
    await post([
      textEv(userSrc(STRANGER), "no"),
      textEv(groupSrc(GROUP, STRANGER), "no either"),
      textEv(groupSrc(GROUP, FRIEND), "hi all"),
      textEv(groupSrc(OPEN_GROUP, STRANGER), "@bot hey", { mention: { mentionees: [{ isSelf: true, userId: "Ubot" }] } }),
      { type: "message", replyToken: "r", source: userSrc(OWNER), message: { id: "s1", type: "sticker", packageId: "1", stickerId: "2", keywords: ["happy"] } },
    ]);
    await waitFor(() => inbox.length === 3);
    expect(inbox.map((m) => [m.channelKey, m.addressed, m.text])).toEqual([
      [`line:${GROUP}`, false, "hi all"], [`line:${OPEN_GROUP}`, true, "@bot hey"], [`line:${OWNER}`, true, "[sticker pkg=1 id=2 (happy)]"]]);
    expect(fake.callsTo(`/v2/bot/group/${GROUP}/member/${FRIEND}`)).toHaveLength(1);
  });

  test("media is downloaded from the data API", async () => {
    await post([{ type: "message", replyToken: "r", source: userSrc(OWNER), message: { id: "777", type: "audio", duration: 4200 } }]);
    const m = await waitFor(() => inbox[0]);
    expect(m.attachments[0]).toMatchObject({ kind: "audio", durationSec: 4 });
    expect(existsSync(m.attachments[0]!.path)).toBe(true);
  });
});

describe("outbound", () => {
  test("reply token used once (free), then push; chunks; markdown flattened", async () => {
    await post([textEv(userSrc(OWNER), "q")]);
    const m = await waitFor(() => inbox[0]);
    const ref = await adapter.send(m.replyTarget, "**bold** [x](https://e.com)");
    expect(fake.callsTo("/v2/bot/message/reply")[0]!.body).toMatchObject({ replyToken: m.replyTarget.replyToMessageId ? expect.any(String) : "", messages: [{ type: "text", text: "bold x (https://e.com)" }] });
    expect(ref?.messageId).toMatch(/^\d+$/);
    await adapter.send(m.replyTarget, "second");
    expect(fake.callsTo("/v2/bot/message/push")[0]!.body).toMatchObject({ to: OWNER, messages: [{ text: "second" }] });
    await adapter.send({ platform: "line", chatId: GROUP }, "x".repeat(10_000));
    expect(fake.callsTo("/v2/bot/message/push").at(-1)!.body.messages).toHaveLength(3);
  });

  test("no edit/delete/react; typing only in 1:1; targets", async () => {
    expect(adapter.capabilities.edit).toBe(false);
    expect((adapter as unknown as { edit?: unknown }).edit).toBeUndefined();
    await adapter.typing({ platform: "line", chatId: OWNER });
    await adapter.typing({ platform: "line", chatId: GROUP });
    expect(fake.callsTo("/v2/bot/chat/loading/start")).toHaveLength(1);
    // LINE has no bot reaction API (official OpenAPI) → no react(), capability off.
    expect((adapter as { react?: unknown }).react).toBeUndefined();
    expect(adapter.capabilities.reactions).toBe(false);
    expect(adapter.operatorTargets()).toEqual([{ platform: "line", chatId: OWNER }]);
    expect(adapter.parseTarget(`line:${GROUP}`)).toEqual({ platform: "line", chatId: GROUP });
    expect(adapter.channelKeyForTarget({ platform: "line", chatId: OWNER })).toBe(`line:${OWNER}`);
    expect(adapter.channelKeyForTarget({ platform: "line", chatId: GROUP })).toBe(`line:${GROUP}`);
    expect(markdownToPlain("# T\n- a\n```js\ncode\n```")).toBe("T\n• a\ncode");
  });
});

describe("askChoice", () => {
  test("quick-reply postbacks; strangers refused; operator answers", async () => {
    const p = adapter.askChoice({ platform: "line", chatId: OWNER }, { title: "Run?", body: "rm x", options: ["Allow", "Deny"], approverIds: [], timeoutMs: 5000 });
    const push = await waitFor(() => fake.callsTo("/v2/bot/message/push")[0]);
    const items = push.body.messages[0].quickReply.items;
    expect(items.map((i: { action: { label: string } }) => i.action.label)).toEqual(["Allow", "Deny"]);
    await post([{ type: "postback", replyToken: "pb1", source: userSrc(FRIEND), postback: { data: items[0].action.data } }]);
    await waitFor(() => fake.callsTo("/v2/bot/message/reply").find((c) => c.body.replyToken === "pb1"));
    await post([{ type: "postback", replyToken: "pb2", source: userSrc(OWNER), postback: { data: items[1].action.data } }]);
    expect(await p).toBe(1);
    expect(fake.callsTo("/v2/bot/message/reply").find((c) => c.body.replyToken === "pb2")!.body.messages[0].text).toContain("✅ Deny");
  });

  test("timeout → null + push notice", async () => {
    expect(await adapter.askChoice({ platform: "line", chatId: OWNER }, { title: "Q", options: ["a"], approverIds: [], timeoutMs: 80 })).toBeNull();
    expect(fake.callsTo("/v2/bot/message/push").at(-1)!.body.messages[0].text).toContain("Timed out");
  });

  test("timeoutMs 0 (approval.timeoutSec 0) never times out", async () => {
    let settled = false;
    const p = adapter.askChoice({ platform: "line", chatId: OWNER }, { title: "Q", options: ["a"], approverIds: [], timeoutMs: 0 });
    void p.then(() => { settled = true; });
    await Bun.sleep(150);
    expect(settled).toBe(false);
    expect(fake.callsTo("/v2/bot/message/push").some((c) => /Timed out/.test(String(c.body?.messages?.[0]?.text)))).toBe(false);
    await adapter.stop();
    expect(await p).toBeNull();
  });
});
