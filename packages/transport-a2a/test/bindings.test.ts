// HTTP+JSON (REST) and gRPC bindings: round trips, streaming, auth, client transport selection.
import { afterEach, expect, test } from "bun:test";
import { silentLogger, type TransportApi } from "@uniqlaw/core";
import { A2ATransport, a2aConfigSchema } from "../src/index.ts";

const stops: (() => void)[] = [];
afterEach(() => { for (const s of stops.splice(0)) s(); });

type Inbound = Parameters<TransportApi["runInbound"]>[0];
async function server(cfg: Record<string, unknown>) {
  process.env.A2A_BIND_TOKEN = "t0ken";
  const calls: Inbound[] = [];
  const api: TransportApi = { runInbound: async (o) => { calls.push(o); return { ok: true, text: `answer[${o.profile}]: ${o.text}` }; },
    profiles: () => [{ name: "main", provider: "fake" }, { name: "other", provider: "fake" }], maxHops: 4 };
  const t = new A2ATransport(a2aConfigSchema.parse(cfg), silentLogger);
  await t.start(api);
  stops.push(() => t.stop());
  return { t, calls, base: t.baseUrl };
}

const msg = (text: string, metadata: Record<string, unknown> = {}) => ({ message: { messageId: crypto.randomUUID(), role: "ROLE_USER", parts: [{ text }], metadata } });
const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json", "A2A-Version": "1.0", ...headers }, body: JSON.stringify(body) });

async function sse(res: Response): Promise<Record<string, unknown>[]> {
  const text = await res.text();
  return text.split("\n\n").filter((b) => b.startsWith("data: ")).map((b) => JSON.parse(b.slice(6)));
}

test("card advertises every enabled binding in order; gRPC uses tenant = profile", async () => {
  const { t, base } = await server({ expose: { main: {} }, transports: ["HTTP+JSON", "JSONRPC", "GRPC"] });
  const card = await (await fetch(`${base}/main/.well-known/agent-card.json`)).json() as { supportedInterfaces: { url: string; protocolBinding: string; tenant: string }[] };
  expect(card.supportedInterfaces.map((i) => i.protocolBinding)).toEqual(["HTTP+JSON", "JSONRPC", "GRPC"]);
  expect(card.supportedInterfaces[0]!.url).toBe(`${base}/main/rest`);
  expect(card.supportedInterfaces[2]).toMatchObject({ url: `127.0.0.1:${t.grpcPort}`, tenant: "main" });
  expect(t.ports()).toEqual({ a2a: t.port!, "a2a-grpc": t.grpcPort! });
});

test("REST: message:send → task; GET tasks/{id}; cancel of a finished task errors as REST JSON", async () => {
  const { base, calls } = await server({ expose: { main: {} }, transports: ["HTTP+JSON"] });
  const res = await post(`${base}/main/rest/message:send`, msg("ping", { "uniqlaw.hop": 3 }));
  expect(res.status).toBe(200);
  const body = await res.json() as { task: { id: string; status: { state: string }; artifacts: { parts: { text: string }[] }[] } };
  expect(body.task.status.state).toBe("TASK_STATE_COMPLETED");
  expect(body.task.artifacts[0]!.parts[0]!.text).toBe("answer[main]: ping");
  expect(calls[0]).toMatchObject({ profile: "main", text: "ping", hop: 3 });
  const got = await (await fetch(`${base}/main/rest/tasks/${body.task.id}`, { headers: { "A2A-Version": "1.0" } })).json() as { id: string };
  expect(got.id).toBe(body.task.id);
  const missing = await fetch(`${base}/main/rest/tasks/nope`, { headers: { "A2A-Version": "1.0" } });
  expect(missing.status).toBe(404);
  expect(((await missing.json()) as { error: { status: string } }).error.status).toBe("NOT_FOUND");
  // JSON-RPC is not enabled on this server
  expect((await post(`${base}/main`, { jsonrpc: "2.0", id: 1, method: "SendMessage", params: msg("x") })).status).toBe(404);
});

test("REST: message:stream is SSE ending in a completed status", async () => {
  const { base } = await server({ expose: { main: {} }, transports: ["HTTP+JSON"] });
  const res = await post(`${base}/main/rest/message:stream`, msg("stream me"), { accept: "text/event-stream" });
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  const events = await sse(res);
  expect(events.length).toBeGreaterThanOrEqual(3);
  const last = events.at(-1) as { statusUpdate?: { status: { state: string } } };
  expect(last.statusUpdate?.status.state).toBe("TASK_STATE_COMPLETED");
  expect(JSON.stringify(events)).toContain("answer[main]: stream me");
});

test("REST: bearer auth enforced; malformed body → 400", async () => {
  const { base, calls } = await server({ expose: { main: {} }, transports: ["HTTP+JSON"], auth: { bearerTokens: [{ name: "gamma", token: { env: "A2A_BIND_TOKEN" } }] } });
  expect((await post(`${base}/main/rest/message:send`, msg("x"))).status).toBe(401);
  expect((await post(`${base}/main/rest/message:send`, { message: {} }, { authorization: "Bearer t0ken" })).status).toBe(400);
  expect((await post(`${base}/main/rest/message:send`, msg("ok"), { authorization: "Bearer t0ken" })).status).toBe(200);
  expect(calls[0]!.remote).toBe("gamma");
});

test("client prefers each transport in turn and gets the same answer", async () => {
  const { base, calls } = await server({ expose: { main: {} }, transports: ["JSONRPC", "HTTP+JSON", "GRPC"],
    auth: { bearerTokens: [{ name: "delta", token: { env: "A2A_BIND_TOKEN" } }] } });
  for (const pref of ["JSONRPC", "HTTP+JSON", "GRPC"] as const) {
    const c = new A2ATransport(a2aConfigSchema.parse({ remotes: { alpha: { url: base + "/main", bearer: { env: "A2A_BIND_TOKEN" }, preferredTransports: [pref] } } }), silentLogger);
    await c.start({ runInbound: async () => ({ ok: false, text: "" }), profiles: () => [], maxHops: 4 });
    stops.push(() => c.stop());
    const remote = c.remoteAgents()[0] as unknown as { ask: (o: { from: string; message: string; hop: number }) => Promise<{ ok: boolean; text: string }>; protocol: () => Promise<string> };
    const r = await remote.ask({ from: "global", message: `via ${pref}`, hop: 2 });
    expect(r).toEqual({ ok: true, text: `answer[main]: via ${pref}` });
    expect(await remote.protocol()).toBe(pref);
  }
  expect(calls.map((c) => c.remote)).toEqual(["delta", "delta", "delta"]);
  expect(calls.every((c) => c.hop === 2)).toBe(true);
});

test("gRPC: tenant routes to the right profile; streaming; missing token rejected", async () => {
  const { t, calls } = await server({ expose: { main: {}, other: {} }, transports: ["GRPC"], auth: { bearerTokens: [{ env: "A2A_BIND_TOKEN" }] } });
  const { GrpcTransportFactory } = await import("@a2a-js/sdk/client/grpc");
  const { ClientFactory } = await import("@a2a-js/sdk/client");
  const card = (profile: string) => ({ name: profile, description: "", version: "1", provider: undefined, capabilities: { streaming: true, pushNotifications: false, extensions: [] },
    supportedInterfaces: [{ url: `127.0.0.1:${t.grpcPort}`, protocolBinding: "GRPC", tenant: profile, protocolVersion: "1.0" }],
    securitySchemes: {}, securityRequirements: [], defaultInputModes: ["text/plain"], defaultOutputModes: ["text/plain"], skills: [], signatures: [] });
  const factory = new ClientFactory({ transports: [new GrpcTransportFactory()] } as never);
  const auth = { serviceParameters: { authorization: "Bearer t0ken" } };
  const message = (text: string) => ({ tenant: "", message: { messageId: crypto.randomUUID(), contextId: "", taskId: "", role: 1,
    parts: [{ content: { $case: "text", value: text }, metadata: undefined, filename: "", mediaType: "text/plain" }], metadata: undefined, extensions: [], referenceTaskIds: [] },
    configuration: undefined, metadata: undefined });

  const other = await factory.createFromAgentCard(card("other") as never);
  const res = await other.sendMessage(message("hello other") as never, auth as never) as unknown as { artifacts: { parts: { content: { value: string } }[] }[] };
  expect(res.artifacts[0]!.parts[0]!.content.value).toBe("answer[other]: hello other");
  expect(calls.at(-1)).toMatchObject({ profile: "other", remote: "token#0" });

  const main = await factory.createFromAgentCard(card("main") as never);
  const events: unknown[] = [];
  for await (const ev of main.sendMessageStream(message("stream main") as never, auth as never)) events.push(ev);
  expect(events.length).toBeGreaterThanOrEqual(3);
  expect(JSON.stringify(events)).toContain("answer[main]: stream main");

  // Not `expect(...).rejects`: with Bun 1.4.4 that matcher hangs on this rejection (cause not pinned down).
  const noToken = await main.sendMessage(message("no token") as never).then(() => undefined, (e: unknown) => e);
  expect(String(noToken)).toContain("unauthorized");
  expect(calls.filter((c) => c.text === "no token")).toHaveLength(0);
});
