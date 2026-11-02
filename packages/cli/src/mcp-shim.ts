// `uniqlaw mcp-shim`: stdio MCP server that relays every JSON-RPC message to the UniQlaw MCP
// Gateway over Streamable HTTP. For providers that can only load MCP servers from a config file
// (agy): the file is static, identity comes from env the provider process passes down:
//   UNIQLAW_MCP_URL  gateway base URL incl. token path, or the gateway origin
//   UNIQLAW_TOKEN    session token (appended as /mcp/<token> when the URL has no token path)
// Nothing but MCP frames may be written to stdout.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export function gatewayUrl(env: Record<string, string | undefined> = process.env): URL {
  const base = env.UNIQLAW_MCP_URL;
  if (!base) throw new Error("UNIQLAW_MCP_URL is not set");
  const u = new URL(base);
  if (!/\/mcp\/[^/]+$/.test(u.pathname)) {
    if (!env.UNIQLAW_TOKEN) throw new Error("UNIQLAW_TOKEN is not set");
    u.pathname = `${u.pathname.replace(/\/$/, "")}/mcp/${env.UNIQLAW_TOKEN}`;
  }
  return u;
}

export async function runMcpShim(env: Record<string, string | undefined> = process.env) {
  const upstream = new StreamableHTTPClientTransport(gatewayUrl(env));
  const local = new StdioServerTransport();
  const fail = (where: string) => (e: unknown) => process.stderr.write(`[uniqlaw mcp-shim] ${where}: ${e instanceof Error ? e.message : String(e)}\n`);
  local.onmessage = (m) => { upstream.send(m).catch(fail("upstream send")); };
  upstream.onmessage = (m) => { local.send(m).catch(fail("local send")); };
  upstream.onerror = fail("upstream");
  local.onerror = fail("stdio");
  local.onclose = () => { void upstream.close().finally(() => process.exit(0)); };
  await upstream.start();
  await local.start();
}

if (import.meta.main) await runMcpShim();
