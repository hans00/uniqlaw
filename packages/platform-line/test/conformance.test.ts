// Conformance against LINE's official OpenAPI specs (github.com/line/line-openapi, see test/spec/SOURCE.md):
//  • every Messaging API call: documented route + method, request body valid (discriminators resolved,
//    unknown fields rejected — test/spec/openapi-to-ajv.ts);
//  • every webhook fixture: valid CallbackRequest (webhook.yml);
//  • X-Line-Signature: base64(HMAC-SHA256(channelSecret, raw body)) as documented
//    (developers.line.biz/en/reference/messaging-api/#signature-validation).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { silentLogger, type InboundMessage } from "@uniqlaw/core";
import plugin, { LineAdapter } from "../src/index.ts";
import { startFakeLine, type ApiCall } from "./fake-line.ts";
import { toAjvSchemas } from "./spec/openapi-to-ajv.ts";

const SPEC = join(import.meta.dir, "spec");
const msgSpec = Bun.YAML.parse(await Bun.file(join(SPEC, "messaging-api.yml")).text()) as any;
const hookSpec = Bun.YAML.parse(await Bun.file(join(SPEC, "webhook.yml")).text()) as any;
const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
ajv.addSchema({ $id: "https://uniqlaw.invalid/line-m", $defs: toAjvSchemas(msgSpec.components.schemas, "https://uniqlaw.invalid/line-m") });
ajv.addSchema({ $id: "https://uniqlaw.invalid/line-w", $defs: toAjvSchemas(hookSpec.components.schemas, "https://uniqlaw.invalid/line-w") });

function operation(c: ApiCall): { key: string; op: any } | undefined {
  for (const [p, ops] of Object.entries(msgSpec.paths as Record<string, any>)) {
    const re = new RegExp("^" + p.replace(/\{[^}]+\}/g, "[^/]+") + "$");
    if (re.test(c.path) && ops[c.method.toLowerCase()]) return { key: `${c.method} ${p}`, op: ops[c.method.toLowerCase()] };
  }
  return undefined;
}
function checkCall(c: ApiCall) {
  const o = operation(c);
  if (!o) throw new Error(`not a documented LINE endpoint: ${c.method} ${c.path}`);
  const ref: string | undefined = o.op.requestBody?.content?.["application/json"]?.schema?.$ref;
  if (!ref) { expect(c.body, `${o.key} takes no JSON body`).toBeUndefined(); return o.key; }
  const v = ajv.getSchema(`https://uniqlaw.invalid/line-m#/$defs/${ref.split("/").pop()}`)!;
  if (!v(c.body)) throw new Error(`${o.key} body does not conform:\n${JSON.stringify(c.body)}\n${ajv.errorsText(v.errors, { separator: "\n" })}`);
  return o.key;
}
function checkWebhook(body: unknown) {
  const v = ajv.getSchema("https://uniqlaw.invalid/line-w#/$defs/CallbackRequest")!;
  if (!v(body)) throw new Error(`webhook body does not conform:\n${JSON.stringify(body)}\n${ajv.errorsText(v.errors, { separator: "\n" })}`);
}

const SECRET = "conformance-secret", OWNER = "U00000000000000000000000000000001", GROUP = "C00000000000000000000000000000001";
let fake: ReturnType<typeof startFakeLine>;
let adapter: LineAdapter;
let dir: string;
const inbox: InboundMessage[] = [];
const bodies: unknown[] = [];
const waitFor = async (c: () => boolean, ms = 4000) => { const e = Date.now() + ms; while (!c()) { if (Date.now() > e) throw new Error("timeout"); await Bun.sleep(10); } };
const sign = (raw: string) => createHmac("sha256", SECRET).update(raw).digest("base64");
async function deliver(events: unknown[]) {
  const body = { destination: "U" + "f".repeat(32), events };
  bodies.push(body);
  const raw = JSON.stringify(body);
  const r = await fetch(adapter.webhookUrl!, { method: "POST", headers: { "x-line-signature": sign(raw), "content-type": "application/json" }, body: raw });
  expect(r.status).toBe(200);
}
let n = 0;
const common = () => ({ timestamp: 1_700_000_000_000 + n, mode: "active", webhookEventId: `01HX${String(++n).padStart(22, "0")}`, deliveryContext: { isRedelivery: false } });

beforeAll(async () => {
  fake = startFakeLine({ botUserId: "Ubot" });
  dir = mkdtempSync(join(tmpdir(), "uq-line-conf-"));
  adapter = (await plugin.create({ log: silentLogger, instanceId: "t", projectDir: dir, stateDir: dir, timezone: "UTC" },
    plugin.configSchema.parse({ channelAccessToken: "LINE-TOKEN", channelSecret: SECRET, webhookPort: 0, webhookHost: "127.0.0.1",
      apiBase: fake.apiBase, dataApiBase: fake.dataApiBase, allowedUserIds: [OWNER], operatorUserIds: [OWNER] }))) as LineAdapter;
  await adapter.start({ message: (m) => inbox.push(m) });

  await deliver([
    { type: "message", ...common(), replyToken: "rt-1", source: { type: "user", userId: OWNER },
      message: { id: "100001", type: "text", text: "hello", quoteToken: "q1" } },
    { type: "message", ...common(), replyToken: "rt-2", source: { type: "group", groupId: GROUP, userId: OWNER },
      message: { id: "100002", type: "text", text: "@bot hi", quoteToken: "q2", mention: { mentionees: [{ index: 0, length: 4, type: "user", userId: "Ubot", isSelf: true }] } } },
    { type: "message", ...common(), replyToken: "rt-3", source: { type: "user", userId: OWNER },
      message: { id: "100003", type: "image", quoteToken: "q3", contentProvider: { type: "line" } } },
    { type: "message", ...common(), replyToken: "rt-4", source: { type: "user", userId: OWNER },
      message: { id: "100004", type: "sticker", packageId: "1", stickerId: "2", stickerResourceType: "STATIC", keywords: ["happy"], quoteToken: "q4" } },
  ]);
  await waitFor(() => inbox.length === 4);

  await adapter.send({ platform: "line", chatId: OWNER, replyToMessageId: "100001" }, "**reply** via token");   // reply API
  await adapter.send({ platform: "line", chatId: OWNER }, "push " + "x".repeat(20));                         // push API
  await adapter.typing({ platform: "line", chatId: OWNER });                                                 // loading animation
  const choice = adapter.askChoice({ platform: "line", chatId: OWNER }, { title: "Run?", body: "ls", options: ["Allow", "Deny"], approverIds: [], timeoutMs: 5000 });
  await waitFor(() => fake.calls.some((c) => c.body?.messages?.[0]?.quickReply));
  const qr = fake.calls.find((c) => c.body?.messages?.[0]?.quickReply)!.body.messages[0].quickReply.items[0].action;
  await deliver([{ type: "postback", ...common(), replyToken: "rt-5", source: { type: "user", userId: OWNER }, postback: { data: qr.data } }]);
  expect(await choice).toBe(0);
});

afterAll(async () => { await adapter.stop(); fake.stop(); rmSync(dir, { recursive: true, force: true }); });

describe("line ↔ official OpenAPI (messaging-api.yml, webhook.yml)", () => {
  test("negative control: rejects bad bodies, unknown fields, undocumented endpoints", () => {
    expect(() => checkCall({ method: "POST", path: "/v2/bot/message/push", body: { to: OWNER, messages: [{ type: "text", text: 1 }] } })).toThrow();
    expect(() => checkCall({ method: "POST", path: "/v2/bot/message/push", body: { to: OWNER, messages: [{ type: "text", text: "x", bogus: 1 }] } })).toThrow();
    expect(() => checkCall({ method: "POST", path: "/v2/bot/chat/loading/start", body: { chatId: OWNER, loadingSeconds: 90 } })).toThrow(); // max 60
    expect(() => checkCall({ method: "POST", path: "/v2/bot/message/55/reaction", body: {} })).toThrow(/not a documented/);
    expect(() => checkWebhook({ destination: "U", events: [{ type: "message", source: { type: "user", userId: OWNER } }] })).toThrow(); // missing common fields
  });

  test("every Messaging API call hits a documented endpoint with a valid body", () => {
    const keys = new Set(fake.calls.map(checkCall));
    expect([...keys].sort()).toEqual([
      "GET /v2/bot/group/{groupId}/member/{userId}", "GET /v2/bot/info", "GET /v2/bot/message/{messageId}/content",
      "GET /v2/bot/profile/{userId}", "POST /v2/bot/chat/loading/start", "POST /v2/bot/message/push", "POST /v2/bot/message/reply",
    ]);
  });

  test("every webhook body is a valid CallbackRequest", () => {
    for (const b of bodies) checkWebhook(b);
  });

  test("signature = base64(HMAC-SHA256(channelSecret, raw body)); tampering is rejected", () => {
    const raw = JSON.stringify({ destination: "U" + "f".repeat(32), events: [] });
    const doc = createHmac("sha256", SECRET).update(raw).digest("base64"); // algorithm from LINE's docs
    expect(adapter.verifySignature(raw, doc)).toBe(true);
    expect(adapter.verifySignature(raw + " ", doc)).toBe(false);
    expect(adapter.verifySignature(raw, createHmac("sha256", "other").update(raw).digest("base64"))).toBe(false);
  });

  test("message limits: ≤5 messages per reply/push, text ≤5000 chars, quick reply ≤13 items, label ≤20", () => {
    for (const c of fake.calls.filter((x) => x.body?.messages)) {
      expect(c.body.messages.length).toBeLessThanOrEqual(5);
      for (const m of c.body.messages) {
        if (m.type === "text") expect(m.text.length).toBeLessThanOrEqual(5000);
        const items = m.quickReply?.items ?? [];
        expect(items.length).toBeLessThanOrEqual(13);
        for (const it of items) expect(it.action.label.length).toBeLessThanOrEqual(20);
      }
    }
  });
});
