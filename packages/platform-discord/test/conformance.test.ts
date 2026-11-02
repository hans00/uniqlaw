// Conformance against official / canonical Discord API definitions:
//  • REST request bodies + route params → Discord's official OpenAPI spec (github.com/discord/discord-api-spec),
//    subset in test/spec/discord-openapi.subset.json (see test/spec/extract.ts for source commit).
//  • Gateway payloads and inbound dispatch fixtures → discord-api-types v10 (maintained by the discord.js
//    team; the official OpenAPI covers REST only), test/spec/discord-gateway.schema.json.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import Ajv from "ajv";
import { GatewayIntentBits } from "discord-api-types/v10";
import { silentLogger, type InboundMessage } from "@uniqlaw/core";
import plugin, { DiscordAdapter } from "../src/index.ts";
import { startFakeDiscord, type RestCall } from "./fake-discord.ts";
import restSpecJson from "./spec/discord-openapi.subset.json";
import gatewayJson from "./spec/discord-gateway.schema.json";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const restSpec = restSpecJson as any, gatewaySchema = gatewayJson as any;
const rest = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
const DC = "https://uniqlaw.invalid/discord-openapi";
rest.addSchema({ $id: DC, components: restSpec.components });
const gw = new Ajv({ allErrors: true, strict: false });
gw.addSchema(gatewaySchema, "gw");

/** Map a concrete call (METHOD /channels/123/messages) to its spec operation key. */
function operationFor(c: RestCall): string | undefined {
  for (const key of Object.keys(restSpec.operations)) {
    const [m, p] = key.split(" ");
    if (m !== c.method) continue;
    const re = new RegExp("^" + p!.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\\\{[a-z_]+\\\}|\{[a-z_]+\}/g, "[^/]+") + "$");
    if (re.test(c.path)) return key;
  }
  return undefined;
}
function checkRest(c: RestCall) {
  const key = operationFor(c);
  if (!key) throw new Error(`route not in Discord's OpenAPI spec: ${c.method} ${c.path}`);
  const op = restSpec.operations[key];
  // route params: compile each documented path param schema and check the concrete segment
  const tmpl = key.split(" ")[1]!.split("/"), real = c.path.split("/");
  for (let i = 0; i < tmpl.length; i++) {
    const m = /^\{(.+)\}$/.exec(tmpl[i]!);
    if (!m) continue;
    const param = op.parameters.find((p: { name: string }) => p.name === m[1]);
    expect(param, `param ${m[1]} documented`).toBeDefined();
    const v = rest.compile(resolveRefs(param.schema));
    const value = decodeURIComponent(real[i]!);
    if (!v(value)) throw new Error(`${key}: path param ${m[1]}=${value} invalid: ${rest.errorsText(v.errors)}`);
  }
  if (op.requestBody) {
    const v = rest.compile(resolveRefs(op.requestBody));
    if (!v(c.body ?? null)) throw new Error(`${key} body does not conform:\n${JSON.stringify(c.body)}\n${rest.errorsText(v.errors, { separator: "\n" })}`);
  } else {
    expect(c.body, `${key} takes no JSON body`).toBeUndefined();
  }
}
const resolveRefs = (s: unknown): Record<string, unknown> => JSON.parse(JSON.stringify(s).replaceAll('"#/components/', `"${DC}#/components/`));
function checkGw(type: string, value: unknown) {
  const v = gw.getSchema(`gw#/definitions/${type}`)!;
  if (!v(value)) throw new Error(`${type} does not conform:\n${JSON.stringify(value)}\n${gw.errorsText(v.errors, { separator: "\n" })}`);
}

const OWNER = "111111111111111111", CH = "222222222222222222", GUILD = "333333333333333333";
let fake: ReturnType<typeof startFakeDiscord>;
let adapter: DiscordAdapter;
let dir: string;
const inbox: InboundMessage[] = [];
const fixtures: [string, unknown][] = [];
const dispatch = (t: string, type: string, d: unknown) => { fixtures.push([type, d]); fake.dispatch(t, d); };
const waitFor = async (c: () => boolean, ms = 4000) => { const e = Date.now() + ms; while (!c()) { if (Date.now() > e) throw new Error("timeout"); await Bun.sleep(10); } };
const author = { id: OWNER, username: "owner", discriminator: "0", global_name: "Owner", avatar: null };
const message = (id: string, content: string, extra: Record<string, unknown> = {}) => ({
  id, channel_id: CH, guild_id: GUILD, author, content, timestamp: "2026-11-02T00:00:00.000000+00:00", edited_timestamp: null,
  tts: false, mention_everyone: false, mentions: [], mention_roles: [], attachments: [], embeds: [], pinned: false, type: 0,
  member: { roles: [], joined_at: "2026-01-01T00:00:00.000000+00:00", deaf: false, mute: false, flags: 0 }, ...extra,
});

beforeAll(async () => {
  fake = startFakeDiscord({ botId: "900000000000000000", appId: "910000000000000000" });
  dir = mkdtempSync(join(tmpdir(), "uq-dc-conf-"));
  adapter = (await plugin.create({ log: silentLogger, instanceId: "t", projectDir: dir, stateDir: dir, timezone: "UTC" },
    plugin.configSchema.parse({ token: "TEST-DC", apiBase: fake.apiBase, gatewayUrl: fake.gatewayUrl, cdnBase: fake.cdnBase,
      allowedUserIds: [OWNER], operatorUserIds: [OWNER], channels: { [CH]: { enabled: true, requireMention: false, ignoreOtherMentions: false } } }))) as DiscordAdapter;
  await adapter.start({ message: (m) => inbox.push(m) });
  await waitFor(() => !!adapter.botUser);

  dispatch("MESSAGE_CREATE", "MessageCreate", message("400000000000000001", "hello"));
  dispatch("MESSAGE_CREATE", "MessageCreate", message("400000000000000002", "with file", {
    attachments: [{ id: "500000000000000001", filename: "a.png", size: 3, url: `${fake.fileBase}/a.png`, proxy_url: `${fake.fileBase}/a.png`, content_type: "image/png" }] }));
  fake.addFile("a.png", new Uint8Array([1, 2, 3]));
  dispatch("INTERACTION_CREATE", "SlashInteraction", {
    id: "600000000000000001", application_id: "910000000000000000", type: 2, token: "itok", version: 1, channel_id: CH, guild_id: GUILD,
    channel: { id: CH, type: 0 }, app_permissions: "0", locale: "en-US", entitlements: [], authorizing_integration_owners: {}, attachment_size_limit: 8388608,
    member: { user: author, roles: [], joined_at: "2026-01-01T00:00:00.000000+00:00", deaf: false, mute: false, flags: 0, permissions: "0" },
    data: { id: "700000000000000001", name: "model", type: 1, options: [{ name: "args", type: 3, value: "opus" }] } });
  await waitFor(() => inbox.length === 3);

  const target = { platform: "discord", chatId: CH, replyToMessageId: "400000000000000001" };
  const ref = (await adapter.send(target, "**hi**"))!;
  await adapter.edit(ref, "edited");
  await adapter.react(ref, ["👍", "❤️"]);
  await adapter.delete(ref);
  await adapter.typing({ platform: "discord", chatId: CH });
  await adapter.send({ platform: "discord", chatId: `dm:${OWNER}` }, "dm via REST-opened channel");
  await adapter.setCommands([{ name: "stop", description: "Interrupt" }, { name: "Model Switch", description: "x".repeat(300) }]);
  const choice = adapter.askChoice({ platform: "discord", chatId: CH }, { title: "Run?", body: "ls", options: ["Allow", "Deny"], approverIds: [], timeoutMs: 5000 });
  await waitFor(() => fake.calls.some((c) => c.body?.components));
  const btn = fake.calls.find((c) => c.body?.components)!.body.components[0].components[0];
  dispatch("INTERACTION_CREATE", "ButtonInteraction", {
    id: "600000000000000002", application_id: "910000000000000000", type: 3, token: "btok", version: 1, channel_id: CH, guild_id: GUILD,
    channel: { id: CH, type: 0 }, app_permissions: "0", locale: "en-US", entitlements: [], authorizing_integration_owners: {}, attachment_size_limit: 8388608,
    member: { user: author, roles: [], joined_at: "2026-01-01T00:00:00.000000+00:00", deaf: false, mute: false, flags: 0, permissions: "0" },
    message: (({ guild_id: _g, member: _m, ...m }) => m)(message("800000000000000001", "Run?")), data: { custom_id: btn.custom_id, component_type: 2 } });
  expect(await choice).toBe(0);

  fake.sendOp(1);                 // server requests a heartbeat → client must send op 1
  await waitFor(() => fake.frames.some((f) => f.op === 1));
  fake.sendOp(7);                 // RECONNECT → client must RESUME (op 6)
  await waitFor(() => fake.frames.some((f) => f.op === 6), 8000);
});

afterAll(async () => { await adapter.stop(); fake.stop(); rmSync(dir, { recursive: true, force: true }); });

describe("discord ↔ official OpenAPI (REST) + discord-api-types (Gateway)", () => {
  test("negative control: validators reject non-conforming payloads", () => {
    expect(() => checkRest({ method: "POST", path: `/channels/${CH}/messages`, body: { content: 5 } })).toThrow();
    expect(() => checkRest({ method: "POST", path: `/channels/${CH}/messages`, body: { components: [{ type: 1, components: [{ type: 2, style: 3, custom_id: "x".repeat(101), label: "a" }] }] } })).toThrow();
    expect(() => checkRest({ method: "POST", path: `/channels/not-a-snowflake/messages`, body: { content: "x" } })).toThrow();
    expect(() => checkRest({ method: "GET", path: `/channels/${CH}/nope`, body: undefined })).toThrow();
    expect(() => checkGw("Identify", { op: 2, d: { token: "t", properties: { os: "l", browser: "b", device: "d" } } })).toThrow(); // missing intents
  });

  test("every REST call matches a documented route, valid path params and request body", () => {
    const ops = new Set<string>();
    for (const c of fake.calls) { checkRest(c); ops.add(operationFor(c)!); }
    expect([...ops].sort()).toEqual(Object.keys(restSpec.operations).sort());
  });

  test("gateway frames: IDENTIFY, HEARTBEAT, RESUME conform; intents are documented bits", () => {
    const byOp = (op: number) => fake.frames.filter((f) => f.op === op);
    for (const f of byOp(2)) checkGw("Identify", f);
    for (const f of byOp(1)) checkGw("Heartbeat", f);
    for (const f of byOp(6)) checkGw("Resume", f);
    expect(byOp(2).length && byOp(1).length && byOp(6).length).toBeTruthy();
    const allBits = Object.values(GatewayIntentBits).filter((v): v is number => typeof v === "number").reduce((a, b) => a | b, 0);
    const intents = byOp(2)[0].d.intents as number;
    expect(intents & ~allBits).toBe(0);
    expect(intents & GatewayIntentBits.MessageContent).toBeTruthy();
    expect(intents & GatewayIntentBits.DirectMessages).toBeTruthy();
  });

  test("inbound fixtures conform to the dispatch data types the adapter parses", () => {
    for (const [type, d] of fixtures) checkGw(type, d);
  });

  test("reaction route uses URL-encoded unicode emoji", () => {
    const paths = fake.calls.filter((c) => c.method === "PUT" && c.path.includes("/reactions/")).map((c) => decodeURIComponent(c.path.split("/")[6]!));
    expect(paths).toEqual(["👍", "❤️"]);
  });
});
