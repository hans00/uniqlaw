// Resilience (docs §11.4): channel supervisor (platforms start in the background, with a deadline and retry), the
// gateway's ready hold and MCP link tracking.
import { afterEach, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ChannelManager, ChannelSupervisor, McpGateway, PlatformStartError, StateStore, mcpLinkState, parseSettings, silentLogger,
  type InboundSink, type PlatformHealth, type Profile,
} from "../src/index.ts";
import { FakePlatform, FakeProvider } from "./fakes.ts";

const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });
const until = async (c: () => boolean, ms = 3000) => { const e = Date.now() + ms; while (!c()) { if (Date.now() > e) throw new Error("timeout"); await Bun.sleep(5); } };

/** A platform whose start() hangs / fails / works on demand. */
class FlakyPlatform extends FakePlatform {
  starts = 0;
  stops = 0;
  mode: "hang" | "fail" | "permanent" | "ok" = "ok";
  hangStop = false;
  h: PlatformHealth = { consecutiveFailures: 0 };
  sinkGot?: InboundSink;
  override async start(sink?: InboundSink, signal?: AbortSignal) {
    this.starts++;
    if (this.mode === "hang") await new Promise<void>((_, rej) => signal?.addEventListener("abort", () => rej(new Error("aborted")), { once: true }));
    if (this.mode === "fail") throw new Error("ECONNRESET");
    if (this.mode === "permanent") throw new PlatformStartError("telegram getMe failed (401): Unauthorized");
    this.sinkGot = sink;
  }
  override async stop() { this.stops++; if (this.hangStop) await new Promise(() => {}); }
  health() { return { ...this.h }; }
}

function supervisor(p: FlakyPlatform, opts = {}) {
  const s = new ChannelSupervisor(new Map([["tg", p]]), () => ({ message: () => {} }), silentLogger,
    { startTimeoutMs: 50, retryMinMs: 20, retryMaxMs: 80, stopTimeoutMs: 50, ...opts });
  cleanups.push(() => s.stop());
  return s;
}

test("supervisor: a start that hangs times out → degraded, retried with backoff, connected once the platform answers", async () => {
  const p = new FlakyPlatform();
  p.mode = "hang";
  const s = supervisor(p);
  s.start(); // returns at once
  expect(s.health()[0]!.state).toBe("starting");
  await until(() => s.health()[0]!.state === "degraded");
  const h = s.health()[0]!;
  expect(h.lastError).toContain("timed out");
  expect(h.consecutiveFailures).toBeGreaterThanOrEqual(1);
  expect(h.nextRetryAt).toBeGreaterThan(0);
  expect(p.stops).toBeGreaterThanOrEqual(1); // the timed-out start is stopped before the retry
  p.mode = "ok";
  await until(() => s.health()[0]!.state === "connected", 3000);
  expect(p.starts).toBeGreaterThanOrEqual(2);
  expect(s.health()[0]!.consecutiveFailures).toBe(0);
  expect(p.sinkGot).toBeDefined();
});

test("supervisor: a rejected token is failed (no retry); retry() tries again on request", async () => {
  const p = new FlakyPlatform();
  p.mode = "permanent";
  const s = supervisor(p);
  s.start();
  await until(() => s.health()[0]!.state === "failed");
  const starts = p.starts;
  await Bun.sleep(150);
  expect(p.starts).toBe(starts);
  expect(s.health()[0]!.lastError).toContain("401");
  p.mode = "ok";
  expect(s.retry("tg")).toBe(true);
  await until(() => s.health()[0]!.state === "connected");
});

test("supervisor: connected but API calls keep failing → degraded with the adapter's last error; stop() is bounded", async () => {
  const p = new FlakyPlatform();
  const s = supervisor(p);
  s.start();
  await until(() => s.health()[0]!.state === "connected");
  p.h = { consecutiveFailures: 5, lastError: "getUpdates: 502 Bad Gateway", lastErrorAt: Date.now(), lastPollAt: Date.now() - 60_000 };
  const h = s.health()[0]!;
  expect(h.state).toBe("degraded");
  expect(h.lastError).toBe("getUpdates: 502 Bad Gateway");
  expect(h.consecutiveFailures).toBe(5);
  expect(h.lastPollAt).toBeGreaterThan(0);
  p.hangStop = true;
  const t0 = Date.now();
  await s.stop();
  expect(Date.now() - t0).toBeLessThan(1000);
});

// ── gateway ──

function gwSetup(hold: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "uq-res-"));
  const store = new StateStore(join(dir, "state.db"));
  const settings = parseSettings({ profiles: { main: { provider: "fake" } }, queue: { debounceMs: 0 } });
  const profile: Profile = { name: "main", provider: "fake", permissions: settings.profiles.main!.permissions, options: {} };
  let mgr: ChannelManager | undefined;
  const gw = new McpGateway(() => mgr!, silentLogger);
  if (hold) gw.hold();
  gw.start("127.0.0.1", 0);
  const make = () => {
    mgr = new ChannelManager({ log: silentLogger, settings, store, projectDir: dir, instanceId: "t",
      providers: new Map([["fake", new FakeProvider(() => {})]]), platforms: new Map([["tg", new FakePlatform()]]), profiles: new Map([["main", profile]]),
      gatewayFor: (k) => gw.endpointFor(k), systemPrompt: async () => ({ fragments: [] }), providerEnv: async () => ({}) });
    cleanups.push(() => mgr!.stop());
  };
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }), () => store.close(), () => gw.stop());
  return { gw, make };
}

test("gateway: bound before the manager exists, requests wait for markReady instead of failing", async () => {
  const { gw, make } = gwSetup(true);
  make();
  const url = gw.endpointFor("tg:1")!.url;
  const c = new Client({ name: "t", version: "0" });
  let connected = false;
  const connecting = c.connect(new StreamableHTTPClientTransport(new URL(url))).then(() => { connected = true; });
  await Bun.sleep(150);
  expect(connected).toBe(false); // held, not refused
  gw.markReady();
  await connecting;
  cleanups.push(() => c.close());
  expect((await c.listTools()).tools.length).toBeGreaterThan(0);
});

test("gateway: tracks each session's MCP link — initialize, requests, open event-streams", async () => {
  const { gw, make } = gwSetup(false);
  make();
  const url = gw.endpointFor("tg:1")!.url;
  expect(mcpLinkState(gw.link("tg:1"))).toBe("unknown");
  const t0 = Date.now();
  const c = new Client({ name: "t", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(url)));
  const l = gw.link("tg:1")!;
  expect(l.lastInitializeAt).toBeGreaterThanOrEqual(t0);
  expect(l.lastRequestAt).toBeGreaterThanOrEqual(t0);
  // The SDK client opens a GET event-stream after initialize, as Claude Code does.
  await until(() => gw.link("tg:1")!.streams === 1);
  expect(mcpLinkState(gw.link("tg:1"))).toBe("connected");
  // Another one: counted while open, uncounted when the client goes away.
  const ac = new AbortController();
  // (Bun sends an event-stream's headers with its first event, so don't wait for the response.)
  void fetch(url, { headers: { accept: "text/event-stream" }, signal: ac.signal }).catch(() => {});
  await until(() => gw.link("tg:1")!.streams === 2);
  ac.abort();
  await until(() => gw.link("tg:1")!.streams === 1);
  expect(gw.link("tg:1")!.streamClosedAt).toBeGreaterThan(0);
  await c.close();
  await until(() => gw.link("tg:1")!.streams === 0);
  expect(mcpLinkState(gw.link("tg:1"))).toBe("seen");
  expect(gw.startedAt).toBeGreaterThan(0);
});

test("gateway: event-streams get keep-alive comments (headers at once; Bun would close an idle stream at 255 s)", async () => {
  const { gw, make } = gwSetup(false);
  make();
  const url = gw.endpointFor("tg:2")!.url;
  const ac = new AbortController();
  const res = await fetch(url, { headers: { accept: "text/event-stream" }, signal: ac.signal });
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  const first = await res.body!.getReader().read();
  expect(new TextDecoder().decode(first.value)).toBe(": keepalive\n\n");
  ac.abort();
  await until(() => gw.link("tg:2")!.streams === 0);
});
