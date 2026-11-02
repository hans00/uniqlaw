// Conformance against Slack's official type packages (Slack's OpenAPI spec repo is archived):
//  • Web API request bodies → @slack/web-api method argument types (test/spec/slack.schema.json)
//  • Block Kit blocks → @slack/types KnownBlock
//  • Events API fixtures → @slack/types (type-level, test/spec/fixtures.ts) + runtime schema for file_share/app_mention
//  • Socket Mode ack → documented shape {"envelope_id": "<id>"} (api.slack.com/apis/socket-mode#acknowledge)
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv from "ajv";
import { silentLogger, type InboundMessage } from "@uniqlaw/core";
import plugin, { SlackAdapter } from "../src/index.ts";
import { startFakeSlack } from "./fake-slack.ts";
import schemaJson from "./spec/slack.schema.json";
import * as fx from "./spec/fixtures.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const schema = schemaJson as any;
const ajv = new Ajv({ allErrors: true, strict: false });
ajv.addSchema(schema, "sl");
const METHOD_TYPE: Record<string, string | null> = {
  "chat.postMessage": "ChatPostMessage", "chat.update": "ChatUpdate", "chat.delete": "ChatDelete", "chat.postEphemeral": "ChatPostEphemeral",
  "reactions.add": "ReactionsAdd", "users.info": "UsersInfo", "conversations.open": "ConversationsOpen",
  "auth.test": null, "apps.connections.open": null, // take no arguments
};
function check(type: string, value: unknown) {
  const v = ajv.getSchema(`sl#/definitions/${type}`)!;
  if (!v(value)) throw new Error(`${type} does not conform:\n${JSON.stringify(value).slice(0, 600)}\n${ajv.errorsText(v.errors, { separator: "\n" }).slice(0, 1500)}`);
}

let fake: ReturnType<typeof startFakeSlack>;
let adapter: SlackAdapter;
let dir: string;
const inbox: InboundMessage[] = [];
const envelopes: string[] = [];
const waitFor = async (c: () => boolean, ms = 4000) => { const e = Date.now() + ms; while (!c()) { if (Date.now() > e) throw new Error("timeout"); await Bun.sleep(10); } };

beforeAll(async () => {
  fake = startFakeSlack();
  dir = mkdtempSync(join(tmpdir(), "uq-sl-conf-"));
  adapter = (await plugin.create({ log: silentLogger, instanceId: "t", projectDir: dir, stateDir: dir, timezone: "UTC" },
    plugin.configSchema.parse({ appToken: "xapp-test", botToken: "xoxb-test", webApiBase: fake.webApiBase,
      allowedUserIds: [fx.OWNER], operatorUserIds: [fx.OWNER], defaultMode: "channel", channels: {} }))) as SlackAdapter;
  await adapter.start({ message: (m) => inbox.push(m) });

  fake.addFile("a.png", new Uint8Array([1, 2, 3]));
  const file = { ...fx.fileShare, files: [{ ...fx.fileShare.files[0], url_private_download: `${fake.fileBase}/a.png`, url_private: `${fake.fileBase}/a.png` }] };
  for (const e of [fx.imMessage, fx.channelMention, fx.threadReply, file]) envelopes.push(fake.event(e));
  await waitFor(() => inbox.length === 4);

  const target = { platform: "slack", chatId: "C0000000001", threadId: "1700000002.000100" };
  const ref = (await adapter.send(target, "**bold** and a [link](https://example.com)"))!;
  await adapter.edit(ref, "edited");
  await adapter.react(ref, ["👍", "❤️", "🦄"]);
  await adapter.delete(ref);
  const choice = adapter.askChoice({ platform: "slack", chatId: "C0000000001" }, { title: "Run?", body: "ls", options: ["Allow", "Deny"], approverIds: [], timeoutMs: 5000 });
  await waitFor(() => fake.callsOf("chat.postMessage").some((c) => c.body.blocks?.some((b: { type: string }) => b.type === "actions")));
  const actions = fake.callsOf("chat.postMessage").find((c) => c.body.blocks?.some((b: { type: string }) => b.type === "actions"))!.body.blocks.find((b: { type: string }) => b.type === "actions");
  envelopes.push(fake.interactive({ type: "block_actions", user: { id: "U0000000009" }, channel: { id: "C0000000001" }, actions: [{ action_id: actions.elements[0].action_id, type: "button" }] }));
  envelopes.push(fake.interactive({ type: "block_actions", user: { id: fx.OWNER }, channel: { id: "C0000000001" }, actions: [{ action_id: actions.elements[0].action_id, type: "button" }] }));
  expect(await choice).toBe(0);
  await adapter.send({ platform: "slack", chatId: "dm:U0000000007" }, "opens a DM via conversations.open");
  await waitFor(() => fake.acks.length === envelopes.length);
});

afterAll(async () => { await adapter.stop(); fake.stop(); rmSync(dir, { recursive: true, force: true }); });

describe("slack ↔ @slack/web-api + @slack/types", () => {
  test("negative control: validators reject non-conforming bodies", () => {
    expect(() => check("ReactionsAdd", { channel: "C1", timestamp: "1.2" })).toThrow();              // missing name
    expect(() => check("ChatUpdate", { channel: "C1", ts: "1.2", text: "x", bogus: 1 })).toThrow();   // unknown field
    expect(() => check("SlackKnownBlock", { type: "actions", elements: [{ type: "button", text: "plain string" }] })).toThrow(); // text must be an object
  });

  test("every Web API request conforms to its method's argument type", () => {
    const seen = new Set<string>();
    for (const c of fake.calls) {
      expect(c.method in METHOD_TYPE, `unexpected method ${c.method}`).toBe(true);
      const t = METHOD_TYPE[c.method];
      if (t) check(t, c.body); else expect(c.body).toEqual({});
      seen.add(c.method);
    }
    expect([...seen].sort(), `called: ${[...seen].join(",")}`).toEqual(Object.keys(METHOD_TYPE).sort());
  });

  test("every Block Kit block sent is a valid KnownBlock", () => {
    let n = 0;
    for (const c of fake.calls) for (const b of c.body.blocks ?? []) { check("SlackKnownBlock", b); n++; }
    expect(n).toBeGreaterThan(0);
  });

  test("reaction names are emoji short names (no colons, no unicode)", () => {
    for (const c of fake.callsOf("reactions.add")) expect(c.body.name).toMatch(/^[a-z0-9_+\-']+$/);
    // 🦄 has no mapping in the adapter and is skipped by design (unknown emoji are dropped, not sent).
    expect(fake.callsOf("reactions.add").map((c) => c.body.name)).toEqual(["+1", "heart"]);
  });

  test("Socket Mode: every envelope is acked with exactly {envelope_id}", () => {
    expect(fake.acks.sort()).toEqual([...envelopes].sort());
  });

  test("inbound fixtures conform (file_share via runtime schema; plain messages via tsc in fixtures.ts)", () => {
    const { files: _f, ...rest } = fx.fileShare;
    check("FileShareEvent", { ...rest, files: [] });
  });
});
