// Test MCP gateway (moved from spikes/common). Stand-in for the real gateway (docs §8.3): Streamable HTTP,
// per-session token in the URL path, caller identity derived from the token.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

export type GatewayCall = { token: string; tool: string; args: unknown; at: number };

export function startTestGateway(port = 0) {
  const calls: GatewayCall[] = [];
  const build = (token: string) => {
    const s = new McpServer({ name: "uniqlaw-test-gateway", version: "0.0.0" });
    s.tool("uniqlaw_ping", "Connectivity test tool for uniqlaw. Returns a pong containing the caller identity.",
      { note: z.string().optional() },
      async (args) => {
        calls.push({ token, tool: "uniqlaw_ping", args, at: Date.now() });
        return { content: [{ type: "text", text: `pong (caller=${token}, note=${args.note ?? ""})` }] };
      });
    return s;
  };
  const server = Bun.serve({
    port, hostname: "127.0.0.1", idleTimeout: 255,
    async fetch(req) {
      const m = new URL(req.url).pathname.match(/^\/mcp\/([\w-]+)$/);
      if (!m) return new Response("not found", { status: 404 });
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await build(m[1]).connect(transport);
      return transport.handleRequest(req);
    },
  });
  return {
    calls,
    url: (token: string) => `http://127.0.0.1:${server.port}/mcp/${token}`,
    stop: () => server.stop(true),
  };
}

if (import.meta.main) {
  const gw = startTestGateway(Number(process.env.PORT ?? 0));
  console.log(gw.url("demo"));
}
