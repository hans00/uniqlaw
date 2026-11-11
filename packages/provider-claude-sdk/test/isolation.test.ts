// SessionSpec.isolated (inbound A2A) → Agent SDK query options: no built-in tools, no settings sources, strict MCP,
// native memory off, no operator extraArgs, path-free prompt. The SDK's query() is mocked to capture the options.
import { expect, mock, test } from "bun:test";
import { DEFAULT_PERMISSIONS, silentLogger, type SessionSpec } from "@uniqlaw/core";

const captured: Record<string, unknown>[] = [];
mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (a: { options: Record<string, unknown> }) => { captured.push(a.options); return (async function* () {})(); },
}));
const { ClaudeSdkSession } = await import("../src/session.ts");

async function start(isolated: boolean) {
  const spec: SessionSpec = { sessionId: "s", cwd: "/home/op/project", instanceId: "t", env: {}, nativeMemory: true,
    profile: { name: "main", provider: "claude-sdk", permissions: { ...DEFAULT_PERMISSIONS, level: "strict" }, options: {} },
    systemPrompt: { fragments: [{ id: "p", text: "PUBLIC PROMPT" }] }, ...(isolated ? { isolated: true } : {}) };
  await new ClaudeSdkSession(spec, { extraArgs: { "add-dir": "/home/op" } } as never, silentLogger).start();
  return captured.at(-1)! as { tools?: string[]; settingSources: string[]; strictMcpConfig?: boolean; settings?: unknown; extraArgs?: unknown; systemPrompt: { append: string } };
}

test("isolated session: tools [], settingSources [], strictMcpConfig, memory off, no extraArgs, no path", async () => {
  const o = await start(true);
  expect(o.tools).toEqual([]);
  expect(o.settingSources).toEqual([]);
  expect(o.strictMcpConfig).toBe(true);
  expect(o.settings).toEqual({ autoMemoryEnabled: false, autoDreamEnabled: false });
  expect(o.extraArgs).toBeUndefined();
  expect(o.systemPrompt.append).toContain("PUBLIC PROMPT");
  expect(o.systemPrompt.append).not.toContain("/home/op");
});

test("chat session keeps user settings sources and extraArgs", async () => {
  const o = await start(false);
  expect(o.settingSources).toEqual(["user", "project", "local"]);
  expect(o.tools).toBeUndefined();
  expect(o.strictMcpConfig).toBeUndefined();
  expect(o.extraArgs).toEqual({ "add-dir": "/home/op" });
});
