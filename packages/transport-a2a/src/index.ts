// A2A v1.0 transport (docs §9): exposes selected profiles as A2A agents (one Agent Card
// per profile) and makes configured remote A2A agents reachable as `a2a:<name>`.
import { z } from "zod";
import {
  DefaultRequestHandler, InMemoryTaskStore, JsonRpcTransportHandler, defaultServerCallContextBuilder, validateVersion,
  type AgentExecutor, type ExecutionEventBus, type RequestContext,
} from "@a2a-js/sdk/server";
import { ClientFactory, DefaultAgentCardResolver, JsonRpcTransportFactory, RestTransportFactory, type TransportFactory } from "@a2a-js/sdk/client";
import { handleRest } from "./rest.ts";
import { startGrpcServer } from "./grpc.ts";
import { definePlugin, resolveSecret, type Logger, type RemoteAgent, type SecretRef, type Transport, type TransportApi } from "@uniqlaw/core";

// Enum values from the A2A v1.0 proto (TaskState / Role).
const STATE = { SUBMITTED: 1, WORKING: 2, COMPLETED: 3, FAILED: 4, CANCELED: 5, INPUT_REQUIRED: 6, REJECTED: 7 } as const;
const TERMINAL = new Set<number>([STATE.COMPLETED, STATE.FAILED, STATE.CANCELED, STATE.REJECTED]);
const ROLE_USER = 1, ROLE_AGENT = 2;
const A2A_VERSION_HEADER = "A2A-Version";
const SSE_HEADERS = { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" };

const secretRef = z.union([z.object({ env: z.string() }), z.object({ file: z.string() }), z.object({ command: z.string() })]);
const skill = z.object({ id: z.string(), name: z.string(), description: z.string().default(""), tags: z.array(z.string()).default([]), examples: z.array(z.string()).default([]) });

export const a2aConfigSchema = z.object({
  host: z.string().default("127.0.0.1"),
  port: z.number().int().nonnegative().default(0),
  /** Externally reachable base URL (behind a proxy); default http://host:port. */
  publicUrl: z.string().url().optional(),
  /** Profiles exposed as A2A agents (only these get an Agent Card). */
  expose: z.record(z.object({ description: z.string().default(""), name: z.string().optional(), skills: z.array(skill).default([]) })).default({}),
  auth: z.object({
    /** Accepted bearer tokens; the caller is identified as `token#<index>` (or the entry's name). */
    bearerTokens: z.array(z.union([secretRef, z.object({ name: z.string(), token: secretRef })])).default([]),
  }).default({}),
  remotes: z.record(z.object({
    url: z.string().url(), bearer: secretRef.optional(), description: z.string().optional(),
    /** Transport preference when the remote card offers several (default: the card's own order). */
    preferredTransports: z.array(z.enum(["JSONRPC", "HTTP+JSON", "GRPC"])).optional(),
  })).default({}),
  /** Bindings served for exposed profiles, in card preference order. */
  transports: z.array(z.enum(["JSONRPC", "HTTP+JSON", "GRPC"])).min(1).default(["JSONRPC"]),
  /** gRPC port when "GRPC" is enabled (0 = auto). */
  grpcPort: z.number().int().nonnegative().default(0),
  /** Host advertised for the gRPC endpoint (default: host). */
  grpcPublicHost: z.string().optional(),
});
export type A2AConfig = z.infer<typeof a2aConfigSchema>;

const isLoopback = (h: string) => h === "127.0.0.1" || h === "::1" || h === "localhost";
const textPart = (text: string) => ({ content: { $case: "text" as const, value: text }, metadata: undefined, filename: "", mediaType: "text/plain" });
type AnyPart = { content?: { $case: string; value: unknown } };
const partsText = (parts: AnyPart[] | undefined) => (parts ?? []).filter((p) => p.content?.$case === "text").map((p) => String(p.content!.value)).join("\n");

// ── server side ────────────────────────────────────────────────────────────

class UniqlawExecutor implements AgentExecutor {
  private contexts = new Map<string, string>(); // taskId → contextId
  private canceled = new Set<string>();
  constructor(private profile: string, private api: () => TransportApi, private log: Logger) {}

  async execute(ctx: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const { taskId, contextId } = ctx;
    this.contexts.set(taskId, contextId);
    const now = () => new Date().toISOString();
    const status = (state: number, msg?: string) => ({ state, message: msg ? agentMessage(msg, contextId, taskId) : undefined, timestamp: now() });
    bus.publish({ kind: "task", data: { id: taskId, contextId, status: status(STATE.SUBMITTED), artifacts: [], history: [ctx.userMessage], metadata: {} } as never });
    bus.publish({ kind: "statusUpdate", data: { taskId, contextId, status: status(STATE.WORKING), metadata: {} } as never });

    const meta = { ...(ctx.request.metadata ?? {}), ...(ctx.userMessage.metadata ?? {}) } as Record<string, unknown>;
    const hop = Number(meta["uniqlaw.hop"] ?? 1) || 1;
    const user = ctx.context.user;
    const remote = user?.isAuthenticated ? user.userName : `anonymous${meta["uniqlaw.from"] ? `(${String(meta["uniqlaw.from"])})` : ""}`;
    let r: { ok: boolean; text: string };
    try {
      r = await this.api().runInbound({ profile: this.profile, remote, contextId, taskId, text: partsText(ctx.userMessage.parts as AnyPart[]), hop });
    } catch (e) {
      r = { ok: false, text: e instanceof Error ? e.message : String(e) };
    }
    if (this.canceled.has(taskId)) { bus.finished(); return; }
    if (r.ok) {
      bus.publish({ kind: "artifactUpdate", data: { taskId, contextId, append: false, lastChunk: true, metadata: {},
        artifact: { artifactId: crypto.randomUUID(), name: "answer", description: "", parts: [textPart(r.text)], metadata: {}, extensions: [] } } as never });
      bus.publish({ kind: "statusUpdate", data: { taskId, contextId, status: status(STATE.COMPLETED), metadata: {} } as never });
    } else {
      this.log.warn("inbound A2A task failed", { profile: this.profile, taskId, error: r.text });
      bus.publish({ kind: "statusUpdate", data: { taskId, contextId, status: status(STATE.FAILED, r.text), metadata: {} } as never });
    }
    bus.finished();
  }

  async cancelTask(taskId: string, bus: ExecutionEventBus): Promise<void> {
    this.canceled.add(taskId);
    const contextId = this.contexts.get(taskId) ?? "";
    bus.publish({ kind: "statusUpdate", data: { taskId, contextId, status: { state: STATE.CANCELED, message: undefined, timestamp: new Date().toISOString() }, metadata: {} } as never });
    bus.finished();
  }
}

function agentMessage(text: string, contextId: string, taskId: string) {
  return { messageId: crypto.randomUUID(), contextId, taskId, role: ROLE_AGENT, parts: [textPart(text)], metadata: undefined, extensions: [], referenceTaskIds: [] };
}

interface Exposed { profile: string; card: Record<string, unknown>; rpc: JsonRpcTransportHandler; handler: DefaultRequestHandler }
type Binding = "JSONRPC" | "HTTP+JSON" | "GRPC";

// ── client side ────────────────────────────────────────────────────────────

class A2ARemote implements RemoteAgent {
  readonly name: string;
  private client?: Promise<Awaited<ReturnType<ClientFactory["createFromAgentCard"]>>>;
  private contexts = new Map<string, string>(); // calling session → contextId (conversation continuity)
  constructor(private short: string, private cfg: A2AConfig["remotes"][string], private log: Logger) {
    this.name = `a2a:${short}`;
  }
  get description() { return this.cfg.description; }

  private async fetchImpl(): Promise<typeof fetch> {
    const token = this.cfg.bearer ? await resolveSecret(this.cfg.bearer as SecretRef) : undefined;
    if (!token) return fetch;
    return ((input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      headers.set("Authorization", `Bearer ${token}`);
      return fetch(input, { ...init, headers });
    }) as typeof fetch;
  }

  private bearer?: string;

  private getClient() {
    this.client ??= (async () => {
      this.bearer = this.cfg.bearer ? await resolveSecret(this.cfg.bearer as SecretRef) : undefined;
      const fetchImpl = await this.fetchImpl();
      const resolver = new DefaultAgentCardResolver({ fetchImpl });
      const card = this.cfg.url.endsWith(".json") ? await resolver.resolve(this.cfg.url, "") : await resolver.resolve(this.cfg.url);
      const transports: TransportFactory[] = [new JsonRpcTransportFactory({ fetchImpl }), new RestTransportFactory({ fetchImpl })];
      const offersGrpc = ((card as { supportedInterfaces?: { protocolBinding: string }[] }).supportedInterfaces ?? []).some((i) => i.protocolBinding === "GRPC");
      if (offersGrpc) {
        // Loaded lazily: grpc-js is only needed when a remote actually offers gRPC.
        const { GrpcTransportFactory } = await import("@a2a-js/sdk/client/grpc");
        transports.push(new GrpcTransportFactory());
      }
      const factory = new ClientFactory({ transports, cardResolver: resolver, ...(this.cfg.preferredTransports ? { preferredTransports: this.cfg.preferredTransports } : {}) });
      return factory.createFromAgentCard(card);
    })().catch((e) => { this.client = undefined; throw e; });
    return this.client;
  }

  /** Per-call options: bearer as a service parameter (HTTP header / gRPC metadata). */
  private callOptions(signal?: AbortSignal) {
    return { signal, ...(this.bearer ? { serviceParameters: { authorization: `Bearer ${this.bearer}` } } : {}) };
  }

  /** Protocol actually selected for this remote (for diagnostics/tests). */
  async protocol(): Promise<string> { return (await this.getClient() as unknown as { transport?: { protocolName?: string } }).transport?.protocolName ?? "?"; }

  async ask(o: { from: string; message: string; hop: number; signal?: AbortSignal }): Promise<{ ok: boolean; text: string }> {
    try {
      const client = await this.getClient();
      let contextId = this.contexts.get(o.from) ?? "";
      const meta = { "uniqlaw.hop": o.hop, "uniqlaw.from": o.from };
      const res = await client.sendMessage({
        tenant: "",
        message: { messageId: crypto.randomUUID(), contextId, taskId: "", role: ROLE_USER, parts: [textPart(o.message)], metadata: meta, extensions: [], referenceTaskIds: [] },
        configuration: { acceptedOutputModes: ["text/plain"], taskPushNotificationConfig: undefined, returnImmediately: false },
        metadata: meta,
      } as never, this.callOptions(o.signal));
      const r = res as unknown as { role?: number; parts?: AnyPart[]; id?: string; contextId?: string; status?: { state: number; message?: { parts?: AnyPart[] } }; artifacts?: { parts?: AnyPart[] }[] };
      if (r.contextId) { contextId = r.contextId; this.contexts.set(o.from, contextId); }
      if (r.role !== undefined && !r.status) return { ok: true, text: partsText(r.parts) }; // direct Message
      let task = r;
      // Non-blocking servers may return a working task: poll until terminal.
      for (let i = 0; task.status && !TERMINAL.has(task.status.state) && i < 600; i++) {
        if (o.signal?.aborted) return { ok: false, text: "aborted" };
        await Bun.sleep(1000);
        task = (await client.getTask({ tenant: "", id: r.id!, historyLength: 0 } as never, this.callOptions(o.signal))) as never;
      }
      const state = task.status?.state;
      const answer = (task.artifacts ?? []).map((a) => partsText(a.parts)).filter(Boolean).join("\n\n");
      if (state === STATE.COMPLETED) return { ok: true, text: answer || partsText(task.status?.message?.parts) };
      return { ok: false, text: partsText(task.status?.message?.parts) || `remote task ended in state ${state}` };
    } catch (e) {
      this.log.warn("A2A ask failed", { remote: this.short, e: e instanceof Error ? e.message : String(e) });
      return { ok: false, text: e instanceof Error ? e.message : String(e) };
    }
  }
}

// ── transport ──────────────────────────────────────────────────────────────

export class A2ATransport implements Transport {
  private server?: ReturnType<typeof Bun.serve>;
  private grpc?: { port: number; stop: () => void };
  private api?: TransportApi;
  private exposed = new Map<string, Exposed>();
  private tokens: { name: string; token: string }[] = [];
  private remotes: A2ARemote[];
  constructor(private cfg: A2AConfig, private log: Logger) {
    this.remotes = Object.entries(cfg.remotes).map(([n, r]) => new A2ARemote(n, r, log.child(`remote:${n}`)));
  }

  get port() { return this.server?.port; }
  get grpcPort() { return this.grpc?.port; }
  /** Actual listening ports, published by the daemon in runtime.json. */
  ports(): Record<string, number> {
    const out: Record<string, number> = {};
    if (this.server?.port) out.a2a = this.server.port;
    if (this.grpc?.port) out["a2a-grpc"] = this.grpc.port;
    return out;
  }
  get baseUrl() { return this.cfg.publicUrl?.replace(/\/$/, "") ?? `http://${this.cfg.host}:${this.server?.port}`; }
  remoteAgents(): RemoteAgent[] { return this.remotes; }

  async start(api: TransportApi) {
    this.api = api;
    this.tokens = await Promise.all(this.cfg.auth.bearerTokens.map(async (t, i) =>
      "token" in t ? { name: t.name, token: await resolveSecret(t.token as SecretRef) } : { name: `token#${i}`, token: await resolveSecret(t as SecretRef) }));
    if (!this.tokens.length && !isLoopback(this.cfg.host) && Object.keys(this.cfg.expose).length) {
      throw new Error("a2a: auth.bearerTokens is required when exposing profiles on a non-loopback host");
    }
    const known = new Set(api.profiles().map((p) => p.name));
    for (const name of Object.keys(this.cfg.expose)) if (!known.has(name)) throw new Error(`a2a.expose: unknown profile "${name}"`);

    this.server = Bun.serve({ hostname: this.cfg.host, port: this.cfg.port, idleTimeout: 255, fetch: (req) => this.handle(req) });
    const grpcProfiles = new Map<string, { handler: DefaultRequestHandler; card: unknown }>();
    if (this.cfg.transports.includes("GRPC") && Object.keys(this.cfg.expose).length) {
      this.grpc = await startGrpcServer({ host: this.cfg.host, port: this.cfg.grpcPort, profiles: grpcProfiles,
        auth: { check: (a) => this.checkBearer(a) } });
    }
    for (const [profile, e] of Object.entries(this.cfg.expose)) {
      const card = {
        name: e.name ?? profile, description: e.description, version: "1.0.0", provider: { organization: "UniQlaw", url: "" },
        supportedInterfaces: this.cfg.transports.map((b) => this.interfaceFor(b, profile)),
        capabilities: { streaming: true, pushNotifications: false, extensions: [], extendedAgentCard: false },
        securitySchemes: this.tokens.length ? { bearer: { scheme: { $case: "httpAuthSecurityScheme", value: { description: "UniQlaw bearer token", scheme: "Bearer", bearerFormat: "" } } } } : {},
        securityRequirements: this.tokens.length ? [{ schemes: { bearer: { list: [] } } }] : [],
        defaultInputModes: ["text/plain"], defaultOutputModes: ["text/plain"],
        skills: e.skills.map((s) => ({ ...s, inputModes: ["text/plain"], outputModes: ["text/plain"], securityRequirements: [] })),
        signatures: [],
      };
      const handler = new DefaultRequestHandler(card as never, new InMemoryTaskStore(), new UniqlawExecutor(profile, () => this.api!, this.log.child(profile)));
      this.exposed.set(profile, { profile, card, handler, rpc: new JsonRpcTransportHandler(handler) });
      grpcProfiles.set(profile, { handler, card });
    }
    this.log.info("a2a listening", { url: this.baseUrl, grpcPort: this.grpc?.port, transports: this.cfg.transports, exposed: [...this.exposed.keys()], remotes: this.remotes.map((r) => r.name) });
  }

  stop() { this.server?.stop(true); this.grpc?.stop(); }

  private interfaceFor(b: Binding, profile: string) {
    const p = encodeURIComponent(profile);
    if (b === "JSONRPC") return { url: `${this.baseUrl}/${p}`, protocolBinding: "JSONRPC", tenant: "", protocolVersion: "1.0" };
    if (b === "HTTP+JSON") return { url: `${this.baseUrl}/${p}/rest`, protocolBinding: "HTTP+JSON", tenant: "", protocolVersion: "1.0" };
    const host = this.cfg.grpcPublicHost ?? this.cfg.host;
    return { url: `${host.includes(":") ? `[${host}]` : host}:${this.grpc?.port ?? this.cfg.grpcPort}`, protocolBinding: "GRPC", tenant: profile, protocolVersion: "1.0" };
  }

  private checkBearer(authorization: string | null | undefined): { ok: boolean; name?: string } {
    if (!this.tokens.length) return { ok: true };
    const m = authorization?.match(/^Bearer\s+(.+)$/i);
    const hit = m ? this.tokens.find((t) => timingSafeEqual(t.token, m[1]!.trim())) : undefined;
    return hit ? { ok: true, name: hit.name } : { ok: false };
  }

  private auth(req: Request): { ok: boolean; name?: string } { return this.checkBearer(req.headers.get("authorization")); }

  private context(req: Request, who: { name?: string }) {
    return defaultServerCallContextBuilder({
      extensions: undefined,
      user: who.name ? { isAuthenticated: true, userName: who.name } : undefined,
      headers: Object.fromEntries(req.headers),
      requestedVersion: req.headers.get(A2A_VERSION_HEADER) ?? undefined,
    });
  }

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    // Agent cards are public discovery documents.
    if (req.method === "GET" && url.pathname.endsWith("/.well-known/agent-card.json")) {
      const profile = parts.length === 3 ? parts[0] : [...this.exposed.keys()][0];
      const e = profile ? this.exposed.get(profile) : undefined;
      return e ? Response.json(e.card, { headers: { "Cache-Control": "no-cache" } }) : new Response("not found", { status: 404 });
    }
    // REST binding: /<profile>/rest/...
    if (parts.length >= 2 && parts[1] === "rest" && this.cfg.transports.includes("HTTP+JSON")) {
      const ex = this.exposed.get(parts[0]!);
      if (!ex) return new Response("not found", { status: 404 });
      const who = this.auth(req);
      if (!who.ok) return new Response("unauthorized", { status: 401, headers: { "WWW-Authenticate": "Bearer" } });
      const sub = url.pathname.slice(url.pathname.indexOf("/rest") + "/rest".length) || "/";
      return handleRest(ex.handler, ex.card, sub, req, this.context(req, who));
    }
    const e = parts.length === 1 && req.method === "POST" && this.cfg.transports.includes("JSONRPC") ? this.exposed.get(parts[0]!) : undefined;
    if (!e) return new Response("not found", { status: 404 });
    const who = this.auth(req);
    if (!who.ok) return new Response("unauthorized", { status: 401, headers: { "WWW-Authenticate": "Bearer" } });

    let body: Record<string, unknown>;
    try { body = (await req.json()) as Record<string, unknown>; }
    catch { return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); }
    try {
      const context = this.context(req, who);
      validateVersion(context.requestedVersion, e.card as never, "JSONRPC");
      const out = await e.rpc.handle(body, context);
      if (out && typeof (out as AsyncGenerator)[Symbol.asyncIterator] === "function") {
        const gen = out as AsyncGenerator<unknown>;
        const enc = new TextEncoder();
        const stream = new ReadableStream({
          async pull(ctrl) {
            try {
              const { value, done } = await gen.next();
              if (done) return ctrl.close();
              ctrl.enqueue(enc.encode(`data: ${JSON.stringify(value)}\n\n`));
            } catch (err) {
              ctrl.enqueue(enc.encode(`event: error\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id ?? null, error: JsonRpcTransportHandler.mapToJSONRPCError(err) })}\n\n`));
              ctrl.close();
            }
          },
          cancel() { void gen.return?.(undefined); },
        });
        return new Response(stream, { headers: SSE_HEADERS });
      }
      return Response.json(out);
    } catch (err) {
      return Response.json({ jsonrpc: "2.0", id: body.id ?? null, error: JsonRpcTransportHandler.mapToJSONRPCError(err) });
    }
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export default definePlugin({
  kind: "transport", name: "a2a", configSchema: a2aConfigSchema,
  create: (ctx, cfg) => new A2ATransport(cfg, ctx.log),
});
