import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpGateway } from "../src/gateway.ts";
import type { ChannelManager } from "../src/manager.ts";

const log = { debug() {}, info() {}, warn() {}, error() {}, child() { return log; } } as never;

test("MCP URL survives a daemon restart (claude-tmux sessions are reattached with it)", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "uq-gw-")), "gateway.json");
  const mgr = () => ({}) as ChannelManager;

  const a = new McpGateway(mgr, log, file);
  a.start("127.0.0.1", 0);
  const before = a.endpointFor("telegram:1")!.url;
  a.stop();

  const b = new McpGateway(mgr, log, file);
  b.start("127.0.0.1", 0);
  expect(b.endpointFor("telegram:1")!.url).toBe(before);
  // The old URL is accepted (not "unknown token").
  const res = await fetch(before, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) });
  expect(res.status).not.toBe(401);
  b.stop();
});
