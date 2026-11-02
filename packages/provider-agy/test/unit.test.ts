import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PERMISSIONS, silentLogger, type AgentEvent } from "@uniqlaw/core";
import { AgySession, credentialEnv, errorCodeFromStderr, permissionArgs, toAgyRule } from "../src/index.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

test("tool names → agy permission rules", () => {
  expect(toAgyRule("Bash")).toBe("command(*)");
  expect(toAgyRule("Bash(git status)")).toBe("command(git status)");
  expect(toAgyRule("Read")).toBe("read_file(*)");
  expect(toAgyRule("Edit")).toBe("write_file(*)");
  expect(toAgyRule("url(example.com)")).toBe("url(example.com)");
  expect(toAgyRule("Task")).toBeUndefined();
});

test("PermissionPolicy → --settings + flags", () => {
  const p = permissionArgs({ ...DEFAULT_PERMISSIONS, allowTools: ["Bash(ls)", "Task"], denyTools: ["WebFetch"] });
  expect(p.settings.permissions.allow).toEqual(["mcp(uniqlaw/*)", "command(ls)"]);
  expect(p.settings.permissions.deny).toEqual(["url(*)"]);
  expect(p.unmapped).toEqual(["Task"]);
  expect(p.flags).toEqual([]);
  expect(permissionArgs({ ...DEFAULT_PERMISSIONS, approval: { mode: "auto-allow", timeoutSec: 1 } }).flags).toContain("--dangerously-skip-permissions");
  expect(permissionArgs({ ...DEFAULT_PERMISSIONS, level: "locked" }).flags).toEqual(["--mode", "plan"]);
});

test("credential → env", () => {
  expect(credentialEnv({ kind: "gemini-api-key", key: "k" }).env).toEqual({ GEMINI_API_KEY: "k" });
  expect(credentialEnv({ kind: "provider-login", provider: "agy", home: "/h" }).env).toEqual({ HOME: "/h" });
  expect(credentialEnv(undefined, "/iso").env).toEqual({ HOME: "/iso" });
  // gcp → exactly agy's documented ADC sign-in variables (CONTRACT-NOTES.md quotes the CLI's own text)
  expect(credentialEnv({ kind: "gcp", project: "p", location: "us-central1", serviceAccountFile: "/sa.json" }).env)
    .toEqual({ AGY_ADC_AUTH: "1", GOOGLE_CLOUD_PROJECT: "p", GOOGLE_CLOUD_LOCATION: "us-central1", GOOGLE_APPLICATION_CREDENTIALS: "/sa.json" });
  // isolated HOME must not hide the default gcloud ADC file → point at the real one explicitly
  expect(credentialEnv({ kind: "gcp", project: "p", location: "l" }, "/iso", "/home/u").env)
    .toEqual({ AGY_ADC_AUTH: "1", GOOGLE_CLOUD_PROJECT: "p", GOOGLE_CLOUD_LOCATION: "l",
      GOOGLE_APPLICATION_CREDENTIALS: "/home/u/.config/gcloud/application_default_credentials.json", HOME: "/iso" });
  expect(() => credentialEnv({ kind: "gcp", project: "p", location: "l", impersonate: "sa@p" })).toThrow(/impersonat/);
  // api key → only GEMINI_API_KEY (no GOOGLE_API_KEY, no AGY_ADC_AUTH)
  const k = credentialEnv({ kind: "gemini-api-key", key: "k" }, "/iso").env;
  expect(k).toEqual({ GEMINI_API_KEY: "k", HOME: "/iso" });
  expect(() => credentialEnv({ kind: "anthropic-api-key", key: "x" })).toThrow(/does not support/);
});

test("AGY_ERROR stderr → typed codes", () => {
  expect(errorCodeFromStderr('AGY_ERROR: {"status":"RESOURCE_EXHAUSTED","code":429,"retryable":true}')).toBe("rate_limit");
  expect(errorCodeFromStderr('AGY_ERROR: {"status":"RESOURCE_EXHAUSTED","message":"exhausted daily quota","retryable":false}')).toBe("usage_limit");
  expect(errorCodeFromStderr('AGY_ERROR: {"status":"UNAUTHENTICATED"}')).toBe("auth");
  expect(errorCodeFromStderr("just noise")).toBeUndefined();
});

test("stream-json frames → AgentEvents; denied actions surfaced; MCP workspace file", async () => {
  const ws = mkdtempSync(join(tmpdir(), "uq-agy-")); dirs.push(ws);
  const s = new AgySession({ agyPath: "agy", cwd: ws, env: {}, workspaceDir: join(ws, "w"), settings: {}, flags: [], extraArgs: [], log: silentLogger,
    mcp: { url: "http://x/mcp/t", token: "t", shimCommand: ["bun", "/cli/main.ts", "mcp-shim"] } });
  const cfg = JSON.parse(readFileSync(join(ws, "w", ".agents", "mcp_config.json"), "utf8"));
  expect(cfg).toEqual({ mcpServers: { uniqlaw: { command: "bun", args: ["/cli/main.ts", "mcp-shim"] } } });
  expect(s.args()).toEqual(expect.arrayContaining(["--add-dir", join(ws, "w"), "-p="]));
  const evs: AgentEvent[] = [];
  void (async () => { for await (const e of s.events) evs.push(e); })();
  Object.assign(s as object, { running: true, turnSeq: 1 });
  s.onFrame({ event: "init", conversation_id: "c1" });
  s.onFrame({ event: "step_update", step_update: { step_type: "tool", state: "ACTIVE", step_index: 1, tool_name: "call_mcp_tool", tool_info: { parameters: { ServerName: "uniqlaw", ToolName: "notify" } } } });
  s.onFrame({ event: "step_update", step_update: { step_type: "tool", state: "DONE", step_index: 1 } });
  s.onFrame({ event: "step_update", step_update: { step_type: "agent_response", step_index: 2, text_delta: "Hel" } });
  s.onFrame({ event: "step_update", step_update: { step_type: "agent_response", step_index: 2, text_delta: "lo\n", state: "DONE" } });
  s.onFrame({ event: "result", result: { conversation_id: "c1", status: "SUCCESS", response: "Hello", usage: { input_tokens: 5, output_tokens: 2 }, denied_actions: [{ action: "command", display_name: "RunCommand" }] } });
  await Bun.sleep(10);
  expect(evs.map((e) => e.type)).toEqual(["session", "tool_start", "tool_end", "text", "text", "text", "tool_end", "text", "turn_end"]);
  expect(evs[1]).toMatchObject({ name: "mcp__uniqlaw__notify" });
  expect(evs[5]).toMatchObject({ final: "Hello" });
  expect(evs[6]).toMatchObject({ ok: false, summary: "blocked by policy: RunCommand" });
  expect((evs[7] as { final: string }).final).toContain("Blocked by the permission policy");
  expect(evs[8]).toMatchObject({ type: "turn_end", reason: "done", usage: { inputTokens: 5, outputTokens: 2 } });
  await s.close();
  expect(existsSync(join(ws, "w"))).toBe(false);
});

test("interrupted result → turn_end interrupted", async () => {
  const ws = mkdtempSync(join(tmpdir(), "uq-agy-")); dirs.push(ws);
  const s = new AgySession({ agyPath: "agy", cwd: ws, env: {}, workspaceDir: join(ws, "w"), settings: {}, flags: [], extraArgs: [], log: silentLogger, conversationId: "c9" });
  const evs: AgentEvent[] = [];
  void (async () => { for await (const e of s.events) evs.push(e); })();
  Object.assign(s as object, { running: true, turnSeq: 1 });
  s.onFrame({ event: "result", result: { status: "ERROR", finished_reason: "interrupted" } });
  await Bun.sleep(10);
  expect(evs.map((e) => e.type)).toEqual(["session", "turn_end"]);
  expect(evs[1]).toMatchObject({ reason: "interrupted" });
  expect(s.args()).toEqual(expect.arrayContaining(["--conversation", "c9"]));
  await s.close();
});
