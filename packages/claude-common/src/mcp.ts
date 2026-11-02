// Write a per-session --mcp-config file for the UniQlaw MCP Gateway.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { MCP_SERVER_NAME } from "./prompt.ts";

export function mcpConfigObject(url: string) {
  // alwaysLoad: never defer the gateway tools behind ToolSearch (M0 finding).
  return { mcpServers: { [MCP_SERVER_NAME]: { type: "http", url, alwaysLoad: true } } };
}

export function writeMcpConfig(path: string, url: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(mcpConfigObject(url), null, 2), { mode: 0o600 });
  return path;
}
