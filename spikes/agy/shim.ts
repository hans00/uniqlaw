// stdio MCP shim: identity comes from the env the provider process inherited.
// In uniqlaw this would proxy to the MCP Gateway with UNIQLAW_TOKEN.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
const s = new McpServer({ name: "uniqlaw-shim", version: "0.0.0" });
s.tool("uniqlaw_ping", "Connectivity test tool for uniqlaw.", { note: z.string().optional() },
  async (a) => ({ content: [{ type: "text", text: `pong (caller=${process.env.UNIQLAW_TOKEN ?? "<unset>"}, note=${a.note ?? ""})` }] }));
await s.connect(new StdioServerTransport());
