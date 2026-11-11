// Caller isolation and authorization: session identity, task ownership, 403 for a profile a token may not use.
import { afterEach, expect, test } from "bun:test";
import { silentLogger, type TransportApi } from "@uniqlaw/core";
import { A2ATransport, a2aConfigSchema } from "../src/index.ts";

const stops: (() => void)[] = [];
afterEach(() => { for (const s of stops.splice(0)) s(); });

process.env.A2A_ALICE = "alice-token";
process.env.A2A_BOB = "bob-token";
const ALICE = { authorization: "Bearer alice-token" };
const BOB = { authorization: "Bearer bob-token" };

type Inbound = Parameters<TransportApi["runInbound"]>[0];
async function server(cfg: Record<string, unknown>) {
  const calls: Inbound[] = [];
  const api: TransportApi = { runInbound: async (o) => { calls.push(o); return { ok: true, text: `answer[${o.profile}]: ${o.text}` }; },
    profiles: () => [{ name: "main", provider: "fake" }, { name: "other", provider: "fake" }], maxHops: 4 };
  const t = new A2ATransport(a2aConfigSchema.parse({ expose: { main: {}, other: {} }, ...cfg }), silentLogger);
  await t.start(api);
  stops.push(() => t.stop());
  return { t, calls, base: t.baseUrl };
}
const twoTokens = (alice: Record<string, unknown> = {}) => ({ auth: { bearerTokens: [
  { name: "alice", token: { env: "A2A_ALICE" }, ...alice }, { name: "bob", token: { env: "A2A_BOB" } }] } });

const rpc = (base: string, profile: string, method: string, params: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}/${profile}`, { method: "POST", headers: { "content-type": "application/json", "A2A-Version": "1.0", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
const msg = (text: string, extra: Record<string, unknown> = {}) => ({ message: { messageId: crypto.randomUUID(), role: "ROLE_USER", parts: [{ text }], ...extra } });
type Rpc = { result?: { task?: { id: string; contextId: string }; id?: string }; error?: { code: number; message: string } };

test("runInbound gets the authenticated caller; a claimed uniqlaw.from never becomes the identity", async () => {
  const { base, calls } = await server(twoTokens());
  await rpc(base, "main", "SendMessage", msg("hi", { metadata: { "uniqlaw.from": "bob" } }), ALICE);
  expect(calls[0]).toMatchObject({ caller: "alice", remote: "alice" });

  const open = await server({});
  await rpc(open.base, "main", "SendMessage", msg("hi", { metadata: { "uniqlaw.from": "alice" } }));
  expect(open.calls[0]).toMatchObject({ caller: "anonymous", remote: "anonymous(alice)" });
});

test("another caller's task is not found: GetTask, CancelTask, SubscribeToTask, and continuing it by id", async () => {
  const { base, calls } = await server(twoTokens());
  const sent = await (await rpc(base, "main", "SendMessage", msg("alice's question"), ALICE)).json() as Rpc;
  const task = sent.result!.task!;
  expect((await (await rpc(base, "main", "GetTask", { id: task.id }, ALICE)).json() as Rpc).result!.id).toBe(task.id);

  for (const method of ["GetTask", "CancelTask"]) {
    const r = await (await rpc(base, "main", method, { id: task.id }, BOB)).json() as Rpc;
    expect(r.error?.code).toBe(-32001); // TaskNotFoundError
  }
  const sub = await (await rpc(base, "main", "SubscribeToTask", { id: task.id }, BOB)).text();
  expect(sub).toContain("-32001");
  const cont = await (await rpc(base, "main", "SendMessage", msg("continue it", { taskId: task.id, contextId: task.contextId }), BOB)).json() as Rpc;
  expect(cont.error?.code).toBe(-32001);
  expect(calls.map((c) => c.caller)).toEqual(["alice"]);

  // REST binding: the same store, so the same answer (404).
  const rest = await server({ ...twoTokens(), transports: ["HTTP+JSON"] });
  const created = await (await fetch(`${rest.base}/main/rest/message:send`, { method: "POST",
    headers: { "content-type": "application/json", "A2A-Version": "1.0", ...ALICE }, body: JSON.stringify(msg("q")) })).json() as { task: { id: string } };
  expect((await fetch(`${rest.base}/main/rest/tasks/${created.task.id}`, { headers: { "A2A-Version": "1.0", ...ALICE } })).status).toBe(200);
  expect((await fetch(`${rest.base}/main/rest/tasks/${created.task.id}`, { headers: { "A2A-Version": "1.0", ...BOB } })).status).toBe(404);
  expect((await fetch(`${rest.base}/main/rest/tasks/${created.task.id}:cancel`, { method: "POST", headers: { "A2A-Version": "1.0", ...BOB } })).status).toBe(404);
});

test("a valid token limited to some profiles gets 403 on the others (JSON-RPC, REST); bad token still 401", async () => {
  const { base, calls } = await server({ ...twoTokens({ profiles: ["other"] }), transports: ["JSONRPC", "HTTP+JSON"] });
  const denied = await rpc(base, "main", "SendMessage", msg("x"), ALICE);
  expect(denied.status).toBe(403);
  expect(denied.headers.get("www-authenticate")).toBeNull();
  expect((await fetch(`${base}/main/rest/message:send`, { method: "POST", headers: { "content-type": "application/json", "A2A-Version": "1.0", ...ALICE }, body: JSON.stringify(msg("x")) })).status).toBe(403);
  expect((await rpc(base, "other", "SendMessage", msg("allowed"), ALICE)).status).toBe(200);
  expect((await rpc(base, "main", "SendMessage", msg("unlimited"), BOB)).status).toBe(200); // no `profiles` = all
  const bad = await rpc(base, "main", "SendMessage", msg("x"), { authorization: "Bearer nope" });
  expect(bad.status).toBe(401);
  expect(bad.headers.get("www-authenticate")).toBe("Bearer");
  expect(calls.map((c) => `${c.caller}@${c.profile}`)).toEqual(["alice@other", "bob@main"]);
});

test("gRPC: a token limited to some profiles gets PERMISSION_DENIED on the others", async () => {
  const { t, calls } = await server({ ...twoTokens({ profiles: ["other"] }), transports: ["GRPC"] });
  const { GrpcTransportFactory } = await import("@a2a-js/sdk/client/grpc");
  const { ClientFactory } = await import("@a2a-js/sdk/client");
  const card = (profile: string) => ({ name: profile, description: "", version: "1", provider: undefined, capabilities: { streaming: true, pushNotifications: false, extensions: [] },
    supportedInterfaces: [{ url: `127.0.0.1:${t.grpcPort}`, protocolBinding: "GRPC", tenant: profile, protocolVersion: "1.0" }],
    securitySchemes: {}, securityRequirements: [], defaultInputModes: ["text/plain"], defaultOutputModes: ["text/plain"], skills: [], signatures: [] });
  const factory = new ClientFactory({ transports: [new GrpcTransportFactory()] } as never);
  const message = (text: string) => ({ tenant: "", message: { messageId: crypto.randomUUID(), contextId: "", taskId: "", role: 1,
    parts: [{ content: { $case: "text", value: text }, metadata: undefined, filename: "", mediaType: "text/plain" }], metadata: undefined, extensions: [], referenceTaskIds: [] },
    configuration: undefined, metadata: undefined });
  const opts = { serviceParameters: ALICE };
  const main = await factory.createFromAgentCard(card("main") as never);
  // Not `expect(...).rejects`: that matcher hangs on gRPC rejections under Bun (see bindings.test.ts).
  const err = await main.sendMessage(message("x") as never, opts as never).then(() => undefined, (e: unknown) => e) as { code?: number; message?: string } | undefined;
  expect(String(err?.message ?? err)).toContain("forbidden");
  const other = await factory.createFromAgentCard(card("other") as never);
  await other.sendMessage(message("ok") as never, opts as never);
  expect(calls.map((c) => `${c.caller}@${c.profile}`)).toEqual(["alice@other"]);
});

test("a token limited to a profile that is not exposed is a config error", async () => {
  const t = new A2ATransport(a2aConfigSchema.parse({ expose: { main: {} }, ...twoTokens({ profiles: ["ghost"] }) }), silentLogger);
  await expect(t.start({ runInbound: async () => ({ ok: true, text: "" }), profiles: () => [{ name: "main", provider: "fake" }], maxHops: 4 })).rejects.toThrow(/"ghost" is not exposed/);
});
