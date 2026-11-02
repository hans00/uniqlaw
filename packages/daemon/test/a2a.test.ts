// Two UniQlaw daemons talking A2A: B's agent_ask("a2a:alpha") reaches A's "main" profile.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRuntime, startDaemon, type Daemon } from "../src/index.ts";

const FIX = join(import.meta.dir, "fixtures");
const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });
process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "uq-a2a-xdg-"));

function project(token: string, a2a: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "uq-a2a-proj-"));
  mkdirSync(join(dir, ".uniqlaw"), { recursive: true });
  writeFileSync(join(dir, ".uniqlaw", "settings.json"), JSON.stringify({
    profiles: { main: { provider: "fake" } }, queue: { debounceMs: 0 },
    plugins: { fake: { module: join(FIX, "fake-provider.ts") }, tg: { module: join(FIX, "fake-platform.ts"), token }, a2a },
  }));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function start(dir: string): Promise<Daemon> {
  const d = await startDaemon(dir);
  cleanups.push(() => d.stop());
  return d;
}

test("daemon B asks daemon A over A2A and gets A's agent answer; ports come from runtime.json", async () => {
  process.env.UQ_A2A_TOKEN = "tok-123";
  const dirA = project("tok-a", { port: 0, expose: { main: { description: "alpha agent" } }, auth: { bearerTokens: [{ env: "UQ_A2A_TOKEN" }] } });
  const a = await start(dirA);
  const aPort = readRuntime(dirA)!.transportPorts!.a2a!;
  expect(aPort).toBeGreaterThan(0);
  const card = await (await fetch(`http://127.0.0.1:${aPort}/main/.well-known/agent-card.json`)).json() as { description: string };
  expect(card.description).toBe("alpha agent");
  const b = await start(project("tok-b", { remotes: { alpha: { url: `http://127.0.0.1:${aPort}/main`, bearer: { env: "UQ_A2A_TOKEN" }, description: "alpha" } } }));
  expect(b.manager.listAgents().map((x) => x.name)).toContain("a2a:alpha");
  const r = await b.manager.ask("global", "a2a:alpha", "ping over a2a", true);
  // fake provider echoes the last line of the prompt it received
  expect(r.result).toEqual({ ok: true, text: "echo: ping over a2a" });
  // A ran it in an isolated a2a session on its "main" profile
  expect(a.manager.listAgents().some((x) => x.name.startsWith("a2a:main:"))).toBe(true);
});

test("daemon-to-daemon over gRPC (remote prefers GRPC); gRPC port published", async () => {
  process.env.UQ_A2A_TOKEN = "tok-123";
  const dirA = project("tok-ga", { expose: { main: {} }, transports: ["JSONRPC", "GRPC"], auth: { bearerTokens: [{ env: "UQ_A2A_TOKEN" }] } });
  await start(dirA);
  const ports = readRuntime(dirA)!.transportPorts!;
  expect(ports["a2a-grpc"]).toBeGreaterThan(0);
  const b = await start(project("tok-gb", { remotes: { alpha: { url: `http://127.0.0.1:${ports.a2a}/main`, bearer: { env: "UQ_A2A_TOKEN" }, preferredTransports: ["GRPC"] } } }));
  const r = await b.manager.ask("global", "a2a:alpha", "ping over grpc", true);
  expect(r.result).toEqual({ ok: true, text: "echo: ping over grpc" });
});
