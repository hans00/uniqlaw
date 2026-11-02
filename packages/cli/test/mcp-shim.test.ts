import { expect, test } from "bun:test";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startTestGateway } from "@uniqlaw/testkit";
import { gatewayUrl } from "../src/mcp-shim.ts";

const MAIN = join(import.meta.dir, "..", "src", "main.ts");

test("gatewayUrl: full token URL or origin + UNIQLAW_TOKEN", () => {
  expect(gatewayUrl({ UNIQLAW_MCP_URL: "http://127.0.0.1:1/mcp/abc" }).href).toBe("http://127.0.0.1:1/mcp/abc");
  expect(gatewayUrl({ UNIQLAW_MCP_URL: "http://127.0.0.1:1", UNIQLAW_TOKEN: "t1" }).href).toBe("http://127.0.0.1:1/mcp/t1");
  expect(() => gatewayUrl({})).toThrow(/UNIQLAW_MCP_URL/);
});

test("`uniqlaw mcp-shim` bridges stdio to the gateway; identity = env token", async () => {
  const gw = startTestGateway();
  try {
    for (const token of ["tok-one", "tok-two"]) {
      const c = new Client({ name: "t", version: "0" });
      await c.connect(new StdioClientTransport({ command: process.execPath, args: [MAIN, "mcp-shim"],
        env: { PATH: process.env.PATH!, UNIQLAW_MCP_URL: gw.url(token) } }));
      expect((await c.listTools()).tools.map((t) => t.name)).toContain("uniqlaw_ping");
      const r = await c.callTool({ name: "uniqlaw_ping", arguments: { note: "hi" } }) as { content: { text: string }[] };
      expect(r.content[0]!.text).toBe(`pong (caller=${token}, note=hi)`);
      await c.close();
    }
    expect(gw.calls.map((x) => x.token)).toEqual(["tok-one", "tok-two"]);
  } finally { gw.stop(); }
}, 30_000);
