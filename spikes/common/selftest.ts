import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startTestGateway } from "./mcp-gateway.ts";
const gw = startTestGateway();
const c = new Client({ name: "t", version: "0" });
await c.connect(new StreamableHTTPClientTransport(new URL(gw.url("sess-A"))));
console.log((await c.listTools()).tools.map((t) => t.name));
console.log(JSON.stringify(await c.callTool({ name: "uniqlaw_ping", arguments: { note: "hi" } })));
console.log(gw.calls); await c.close(); gw.stop();
