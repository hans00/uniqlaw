import { afterEach, expect, test } from "bun:test";
import { ClientFactory, JsonRpcTransportFactory } from "@a2a-js/sdk/client";
import { silentLogger, type TransportApi } from "@uniqlaw/core";
import { A2ATransport, a2aConfigSchema } from "../src/index.ts";

const stops: (() => void)[] = [];
afterEach(() => { for (const s of stops.splice(0)) s(); });

type Inbound = Parameters<TransportApi["runInbound"]>[0];
function fakeApi(answer: (o: Inbound) => { ok: boolean; text: string } | Promise<{ ok: boolean; text: string }>) {
  const calls: Inbound[] = [];
  const api: TransportApi = { runInbound: async (o) => { calls.push(o); return answer(o); }, profiles: () => [{ name: "main", provider: "fake" }, { name: "other", provider: "fake" }], maxHops: 4 };
  return { api, calls };
}

async function server(cfg: Record<string, unknown>, answer: Parameters<typeof fakeApi>[0] = (o) => ({ ok: true, text: `answer: ${o.text}` })) {
  process.env.A2A_TEST_TOKEN = "s3cret";
  const t = new A2ATransport(a2aConfigSchema.parse({ expose: { main: { description: "Main agent" } }, ...cfg }), silentLogger);
  const f = fakeApi(answer);
  await t.start(f.api);
  stops.push(() => t.stop());
  return { t, ...f, base: t.baseUrl };
}

const rpc = (base: string, method: string, params: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}/main`, { method: "POST", headers: { "content-type": "application/json", "A2A-Version": "1.0", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });

const msg = (text: string, metadata: Record<string, unknown> = {}) => ({
  message: { messageId: crypto.randomUUID(), role: "ROLE_USER", parts: [{ text }], metadata },
});

test("agent card served per profile and at the root; unknown profile 404", async () => {
  const { base } = await server({});
  const card = await (await fetch(`${base}/main/.well-known/agent-card.json`)).json() as { name: string; supportedInterfaces: { url: string; protocolBinding: string }[] };
  expect(card.name).toBe("main");
  expect(card.supportedInterfaces[0]).toMatchObject({ url: `${base}/main`, protocolBinding: "JSONRPC" });
  expect((await (await fetch(`${base}/.well-known/agent-card.json`)).json() as { name: string }).name).toBe("main");
  expect((await fetch(`${base}/nope/.well-known/agent-card.json`)).status).toBe(404);
});

test("bearer auth is enforced and identifies the caller", async () => {
  const { base, calls } = await server({ auth: { bearerTokens: [{ name: "beta", token: { env: "A2A_TEST_TOKEN" } }] } });
  expect((await rpc(base, "SendMessage", msg("hi"))).status).toBe(401);
  expect((await rpc(base, "SendMessage", msg("hi"), { authorization: "Bearer wrong" })).status).toBe(401);
  const ok = await rpc(base, "SendMessage", msg("hi"), { authorization: "Bearer s3cret" });
  expect(ok.status).toBe(200);
  expect(calls[0]!.remote).toBe("beta");
});

test("non-loopback exposure without tokens is refused", async () => {
  const t = new A2ATransport(a2aConfigSchema.parse({ host: "0.0.0.0", expose: { main: {} } }), silentLogger);
  await expect(t.start(fakeApi(() => ({ ok: true, text: "" })).api)).rejects.toThrow(/bearerTokens is required/);
});

test("SendMessage → runInbound (profile, text, hop, ids) → completed task with artifact; GetTask afterwards", async () => {
  const { base, calls } = await server({});
  const r = await (await rpc(base, "SendMessage", msg("what is 6x7?", { "uniqlaw.hop": 2, "uniqlaw.from": "telegram:-5" }))).json() as { result: { task: { id: string; contextId: string; status: { state: string }; artifacts: { parts: { text: string }[] }[] } } };
  const task = r.result.task;
  expect(task.status.state).toBe("TASK_STATE_COMPLETED");
  expect(task.artifacts[0]!.parts[0]!.text).toBe("answer: what is 6x7?");
  expect(calls[0]).toMatchObject({ profile: "main", text: "what is 6x7?", hop: 2, taskId: task.id, contextId: task.contextId });
  expect(calls[0]!.remote).toContain("anonymous");
  const got = await (await rpc(base, "GetTask", { id: task.id })).json() as { result: { status: { state: string } } };
  expect(got.result.status.state).toBe("TASK_STATE_COMPLETED");
});

test("failed inbound turn → failed task with the error message", async () => {
  const { base } = await server({}, () => ({ ok: false, text: "usage limit reached" }));
  const r = await (await rpc(base, "SendMessage", msg("x"))).json() as { result: { task: { status: { state: string; message: { parts: { text: string }[] } } } } };
  expect(r.result.task.status.state).toBe("TASK_STATE_FAILED");
  expect(r.result.task.status.message.parts[0]!.text).toBe("usage limit reached");
});

test("SendStreamingMessage streams task → working → artifact → completed (SDK client)", async () => {
  const { t } = await server({});
  const factory = new ClientFactory({ transports: [new JsonRpcTransportFactory()] });
  const card = await (await fetch(`${t.baseUrl}/main/.well-known/agent-card.json`)).json();
  const client = await factory.createFromAgentCard(card as never);
  const kinds: string[] = [];
  let text = "";
  for await (const ev of client.sendMessageStream({ tenant: "", message: { messageId: crypto.randomUUID(), contextId: "", taskId: "", role: 1,
    parts: [{ content: { $case: "text", value: "stream me" }, metadata: undefined, filename: "", mediaType: "text/plain" }], metadata: undefined, extensions: [], referenceTaskIds: [] },
    configuration: undefined, metadata: undefined } as never)) {
    const p = (ev as { payload?: { $case: string; value: Record<string, any> } }).payload!;
    kinds.push(p.$case === "statusUpdate" ? `status:${p.value.status.state}` : p.$case);
    if (p.$case === "artifactUpdate") text = p.value.artifact.parts[0].content.value;
  }
  expect(kinds[0]).toBe("task");
  expect(kinds).toContain("artifactUpdate");
  expect(kinds.at(-1)).toBe("status:3");
  expect(text).toBe("answer: stream me");
});

test("loopback: remote agent on B reaches A's profile; hop and from propagate; context reused per caller", async () => {
  const a = await server({ auth: { bearerTokens: [{ env: "A2A_TEST_TOKEN" }] } }, (o) => ({ ok: true, text: `A says hi to ${o.text}` }));
  const b = new A2ATransport(a2aConfigSchema.parse({ remotes: { alpha: { url: `${a.base}/main`, bearer: { env: "A2A_TEST_TOKEN" }, description: "A" } } }), silentLogger);
  await b.start(fakeApi(() => ({ ok: true, text: "" })).api);
  stops.push(() => b.stop());
  const remote = b.remoteAgents()[0]!;
  expect(remote.name).toBe("a2a:alpha");
  const r1 = await remote.ask({ from: "telegram:-5", message: "bob", hop: 3 });
  expect(r1).toEqual({ ok: true, text: "A says hi to bob" });
  expect(a.calls[0]).toMatchObject({ hop: 3, remote: "token#0", text: "bob" });
  await remote.ask({ from: "telegram:-5", message: "again", hop: 1 });
  expect(a.calls[1]!.contextId).toBe(a.calls[0]!.contextId);
  const other = await remote.ask({ from: "global", message: "x", hop: 1 });
  expect(other.ok).toBe(true);
  expect(a.calls[2]!.contextId).not.toBe(a.calls[0]!.contextId);
});

test("unreachable remote → ok:false, no throw", async () => {
  const b = new A2ATransport(a2aConfigSchema.parse({ remotes: { ghost: { url: "http://127.0.0.1:9/main" } } }), silentLogger);
  await b.start(fakeApi(() => ({ ok: true, text: "" })).api);
  stops.push(() => b.stop());
  const r = await b.remoteAgents()[0]!.ask({ from: "x", message: "hi", hop: 1 });
  expect(r.ok).toBe(false);
});
