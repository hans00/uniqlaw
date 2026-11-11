import { expect, test } from "bun:test";
import { DEFAULT_PERMISSIONS, silentLogger, type AgentEvent } from "@uniqlaw/core";
import { CodexSession, credentialSetup, errorCode, policyFor, processArgs, threadConfig, toolFromItem } from "../src/index.ts";
import type { AppServer } from "../src/rpc.ts";

test("policy mapping by level and approval mode", () => {
  expect(policyFor(DEFAULT_PERMISSIONS, "/w")).toMatchObject({ approvalPolicy: "untrusted", sandbox: "workspace-write", sandboxPolicy: { type: "workspaceWrite", writableRoots: ["/w"], networkAccess: true } });
  expect(policyFor({ ...DEFAULT_PERMISSIONS, level: "locked" }, "/w")).toMatchObject({ sandbox: "read-only" });
  expect(policyFor({ ...DEFAULT_PERMISSIONS, level: "strict" }, "/w").sandboxPolicy).toMatchObject({ networkAccess: false });
  expect(policyFor({ ...DEFAULT_PERMISSIONS, level: "unrestricted", approval: { mode: "auto-allow", timeoutSec: 1 } }, "/w"))
    .toMatchObject({ approvalPolicy: "never", sandbox: "danger-full-access" });
});

test("thread config disables cross-session features and wires the gateway", () => {
  const c = threadConfig({ url: "http://x/mcp/t" }, "moderate") as any;
  expect(c.features).toMatchObject({ memories: false, agent_message_board: false, wake_on_agent_messages: false });
  expect(c.mcp_servers.uniqlaw).toEqual({ url: "http://x/mcp/t", default_tools_approval_mode: "approve" });
  expect((threadConfig(undefined, "strict") as any).tools).toEqual({ web_search: false });
  expect(processArgs()).toContain("memories");
});

test("credential setup", async () => {
  process.env.UQ_TEST_KEY = "sk-test";
  const a = await credentialSetup({ kind: "openai-api-key", key: { env: "UQ_TEST_KEY" } });
  expect(a.env).toEqual({ UNIQLAW_OPENAI_API_KEY: "sk-test" });
  expect(a.modelProvider).toBe("uniqlaw");
  expect(a.configArgs[1]).toContain('env_key="UNIQLAW_OPENAI_API_KEY"');
  const z = await credentialSetup({ kind: "azure", endpoint: "https://r.openai.azure.com/", auth: { type: "api-key", key: { env: "UQ_TEST_KEY" } } });
  expect(z.configArgs[1]).toContain('base_url="https://r.openai.azure.com/openai"');
  expect(z.configArgs[1]).toContain('"api-version"=');
  expect((await credentialSetup({ kind: "provider-login", provider: "codex", home: "/h/codex" })).env).toEqual({ CODEX_HOME: "/h/codex" });
  await expect(credentialSetup({ kind: "aws", region: "us-east-1" })).rejects.toThrow(/not supported/);
  await expect(credentialSetup({ kind: "azure", endpoint: "e", auth: { type: "entra" } })).rejects.toThrow(/Entra/);
});

test("items and errors", () => {
  expect(toolFromItem({ type: "commandExecution", id: "i", command: "ls", cwd: "/w" })).toEqual({ name: "Bash", input: { command: "ls", cwd: "/w" } });
  expect(toolFromItem({ type: "mcpToolCall", server: "uniqlaw", tool: "notify", arguments: { a: 1 } })!.name).toBe("mcp__uniqlaw__notify");
  expect(toolFromItem({ type: "agentMessage" })).toBeUndefined();
  expect(errorCode({ message: "x", codexErrorInfo: "rateLimitExceeded", additionalDetails: null, misalignment: null })).toBe("rate_limit");
  expect(errorCode({ message: "x", codexErrorInfo: "usageLimitExceeded", additionalDetails: null, misalignment: null })).toBe("usage_limit");
  expect(errorCode({ message: "boom", codexErrorInfo: null, additionalDetails: null, misalignment: null })).toBe("boom");
});

function fakeSession() {
  const sent: { method: string; params: any }[] = [];
  const responses: { id: unknown; result: unknown }[] = [];
  let failSteer = false;
  const server = {
    exited: false,
    async request(method: string, params: any) {
      sent.push({ method, params });
      if (method === "turn/steer" && failSteer) { const { RpcError } = await import("../src/rpc.ts"); throw new RpcError(method, -32600, "no active turn to steer"); }
      if (method === "turn/start") return { turn: { id: `turn-${sent.length}` } };
      return {};
    },
    respond(id: unknown, result: unknown) { responses.push({ id, result }); },
    respondError() {},
  } as unknown as AppServer;
  const s = new CodexSession({ server, log: silentLogger, cwd: "/w", model: "m1", effort: "low", policy: policyFor(DEFAULT_PERMISSIONS, "/w"), onClose: () => {} });
  s.threadId = "th";
  const events: AgentEvent[] = [];
  void (async () => { for await (const e of s.events) events.push(e); })();
  return { s, sent, responses, events, setFailSteer: (v: boolean) => (failSteer = v) };
}

test("session maps notifications to AgentEvents and sends full settings each turn", async () => {
  const { s, sent, events } = fakeSession();
  await s.send({ text: "hi", attachments: [{ kind: "image", path: "/a.png" }] });
  expect(sent[0]!.params).toMatchObject({ threadId: "th", model: "m1", effort: "low", approvalPolicy: "untrusted", input: [{ type: "text", text: "hi" }, { type: "localImage", path: "/a.png" }] });
  s.onNotification("turn/started", { threadId: "th", turn: { id: "t1" } });
  s.onNotification("item/agentMessage/delta", { threadId: "th", itemId: "m", delta: "PO" });
  s.onNotification("item/started", { threadId: "th", item: { type: "commandExecution", id: "c", command: "ls" } });
  s.onNotification("item/completed", { threadId: "th", item: { type: "commandExecution", id: "c", status: "completed", exitCode: 0 } });
  s.onNotification("item/completed", { threadId: "th", item: { type: "agentMessage", id: "m", text: "PONG" } });
  s.onNotification("thread/tokenUsage/updated", { threadId: "th", tokenUsage: { last: { inputTokens: 5, outputTokens: 2 } } });
  s.onNotification("turn/completed", { threadId: "th", turn: { id: "t1", status: "completed", error: null } });
  await Bun.sleep(5);
  expect(events.map((e) => e.type)).toEqual(["turn_start", "text", "tool_start", "tool_end", "text", "turn_end"]);
  expect(events.at(-1)).toMatchObject({ reason: "done", usage: { inputTokens: 5, outputTokens: 2 } });
  await s.setModel("m2");
  await s.send({ text: "again", attachments: [] });
  expect(sent.at(-1)!.params.model).toBe("m2");
});

test("a command's tool_end carries its output excerpt (the approval judge's trace), else the status", async () => {
  const { s, events } = fakeSession();
  s.onNotification("turn/started", { threadId: "th", turn: { id: "t1" } });
  s.onNotification("item/started", { threadId: "th", item: { type: "commandExecution", id: "c", command: "df -h" } });
  s.onNotification("item/completed", { threadId: "th", item: { type: "commandExecution", id: "c", status: "completed", exitCode: 0, aggregatedOutput: "/dev/sda1 30G 30G 0 100% /" } });
  s.onNotification("item/started", { threadId: "th", item: { type: "commandExecution", id: "d", command: "true" } });
  s.onNotification("item/completed", { threadId: "th", item: { type: "commandExecution", id: "d", status: "completed", exitCode: 0, aggregatedOutput: "" } });
  await Bun.sleep(5);
  const ends = events.filter((e) => e.type === "tool_end") as Extract<AgentEvent, { type: "tool_end" }>[];
  expect(ends.map((e) => e.summary)).toEqual(["/dev/sda1 30G 30G 0 100% /", "completed"]);
});

test("unsolicited turn, approvals, steer fallback", async () => {
  const { s, sent, responses, events, setFailSteer } = fakeSession();
  s.onNotification("turn/started", { threadId: "th", turn: { id: "bg" } });
  await Bun.sleep(1);
  expect(events.slice(0, 2).map((e) => e.type)).toEqual(["unsolicited_turn", "turn_start"]);
  s.onServerRequest("item/commandExecution/requestApproval", { threadId: "th", command: "touch x" }, 42);
  await Bun.sleep(1);
  const pr = events.find((e) => e.type === "permission_request") as Extract<AgentEvent, { type: "permission_request" }>;
  expect(pr).toMatchObject({ tool: "Bash", title: "Run: touch x" });
  await s.respondPermission(pr.id, { behavior: "deny" });
  expect(responses[0]).toEqual({ id: 42, result: { decision: "decline" } });
  // active turn "bg" → steer; failure -32600 → falls back to turn/start
  setFailSteer(true);
  await s.steer({ text: "more", attachments: [] });
  expect(sent.map((x) => x.method)).toEqual(["turn/steer", "turn/start"]);
  s.onNotification("turn/completed", { threadId: "th", turn: { id: "bg", status: "failed", error: { message: "x", codexErrorInfo: "rateLimitExceeded" } } });
  await Bun.sleep(1);
  expect(events.find((e) => e.type === "turn_end")).toMatchObject({ reason: "error", error: "rate_limit" });
});
