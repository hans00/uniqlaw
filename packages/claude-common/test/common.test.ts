import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PERMISSIONS } from "@uniqlaw/core";
import {
  buildPermissionArgs, ISOLATED_SDK_OPTIONS, parseLine, locateJsonl, expectedJsonlPath, JsonlTailer, classifyInternalOutput,
  isInterruptMarker, isRejectionText, nativeMemoryArgs, nativeMemorySettings, composeAppendSystemPrompt, mcpConfigObject, claudeEnvForCredential, type JsonlEvent,
} from "../src/index.ts";

describe("permissions", () => {
  test("always pins mode and disallows native cross-session tools", () => {
    const a = buildPermissionArgs(DEFAULT_PERMISSIONS);
    expect(a.slice(0, 2)).toEqual(["--permission-mode", "auto"]); // moderate + ask-operator (v2 parity)
    expect(buildPermissionArgs({ ...DEFAULT_PERMISSIONS, level: "strict" })[1]).toBe("default");
    const deny = a[a.indexOf("--disallowedTools") + 1];
    expect(deny).toContain("ListAgents");
    expect(deny).toContain("SendMessage");
  });
  test("unrestricted + auto-allow → bypassPermissions; strict adds Bash deny; extra allow", () => {
    expect(buildPermissionArgs({ ...DEFAULT_PERMISSIONS, level: "unrestricted", approval: { mode: "auto-allow", timeoutSec: 1 } })[1]).toBe("bypassPermissions");
    expect(buildPermissionArgs({ ...DEFAULT_PERMISSIONS, approval: { mode: "auto-allow", timeoutSec: 1 } })[1]).toBe("auto");
    const s = buildPermissionArgs({ ...DEFAULT_PERMISSIONS, level: "strict" }, { extraAllowed: ["mcp__uniqlaw"] });
    expect(s[s.indexOf("--disallowedTools") + 1]).toContain("Bash");
    expect(s[s.indexOf("--allowedTools") + 1]).toBe("mcp__uniqlaw");
    expect(buildPermissionArgs({ ...DEFAULT_PERMISSIONS, level: "locked" })).toContain("Read,Grep,Glob");
  });
  test("isolated (inbound A2A): no built-in tools, no settings files, only UniQlaw's MCP server", () => {
    const a = buildPermissionArgs({ ...DEFAULT_PERMISSIONS, level: "locked" }, { isolated: true, extraAllowed: ["mcp__uniqlaw"] });
    const flag = (f: string) => a[a.indexOf(f) + 1];
    expect(a.filter((x) => x === "--tools")).toHaveLength(1); // locked's Read,Grep,Glob is not added back
    expect(flag("--tools")).toBe("");
    expect(flag("--setting-sources")).toBe("");
    expect(a).toContain("--strict-mcp-config");
    expect(flag("--allowedTools")).toBe("mcp__uniqlaw");
    for (const f of ["--tools", "--setting-sources", "--strict-mcp-config"]) expect(buildPermissionArgs(DEFAULT_PERMISSIONS)).not.toContain(f);
    expect(ISOLATED_SDK_OPTIONS).toEqual({ tools: [], settingSources: [], strictMcpConfig: true });
  });
});

describe("jsonl", () => {
  test("parses assistant blocks, tentative end, tool results, stop hook", () => {
    const a = parseLine(JSON.stringify({ type: "assistant", uuid: "u", message: { id: "m1", model: "x", stop_reason: "end_turn", content: [{ type: "text", text: "hi" }] } }));
    expect(a.map((e) => e.type)).toEqual(["assistant-text", "turn-end"]);
    expect(a[1].tentative).toBeUndefined();
    const t = parseLine(JSON.stringify({ type: "assistant", message: { stop_reason: "end_turn", content: [{ type: "thinking", thinking: "hmm" }] } }));
    expect(t[1].tentative).toBe(true);
    const r = parseLine(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "x", is_error: true, content: [{ type: "text", text: "no" }] }] } }));
    expect(r[0]).toMatchObject({ type: "user-tool-result", toolUseId: "x", toolResultIsError: true, toolResult: "no" });
    expect(parseLine(JSON.stringify({ type: "system", subtype: "stop_hook_summary" }))[0].type).toBe("stop-hook-summary");
  });
  test("locate by id across project dirs + tailer reads only new bytes", async () => {
    const home = mkdtempSync(join(tmpdir(), "uq-cc-"));
    const env = { CLAUDE_CONFIG_DIR: home };
    const p = expectedJsonlPath("abc", "/some/other cwd", env);
    expect(locateJsonl("abc", env)).toBeUndefined();
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "old" }] } }) + "\n");
    expect(locateJsonl("abc", env)).toBe(p);
    const got: JsonlEvent[] = [];
    const t = new JsonlTailer({ locate: () => locateJsonl("abc", env), startAt: "end", onEvent: (e) => got.push(e), pollMs: 20 });
    t.start();
    await Bun.sleep(50);
    appendFileSync(p, '{"type":"api-request-blob","x":1}\n' + JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "new" }] } }) + "\n{\"type\":\"user\",");
    await Bun.sleep(80);
    appendFileSync(p, '"message":{"content":"[Request interrupted by user]"}}\n');
    await Bun.sleep(80);
    t.stop();
    expect(got.filter((e) => e.type === "assistant-text").map((e) => e.text)).toEqual(["new"]);
    expect(got.some((e) => e.type === "user-message" && isInterruptMarker(e.userText!))).toBe(true);
  });
});

describe("classify + prompt + mcp + credentials", () => {
  test("classifiers", () => {
    expect(classifyInternalOutput("<local-command-stdout>Set model to sonnet (claude-sonnet)</local-command-stdout>")).toEqual({ kind: "model-switch", model: "sonnet" });
    expect(isRejectionText("[Request interrupted by user for tool use]")).toBe(true);
    expect(isInterruptMarker("[Request interrupted by user for tool use]")).toBe(false);
  });
  test("prompt lists gateway tools; mcp config alwaysLoad", () => {
    const s = composeAppendSystemPrompt({ parts: { fragments: [{ id: "a", text: "IDENTITY" }] }, permissions: DEFAULT_PERMISSIONS, cwd: "/w", mcpToolNames: ["agent_ask"] });
    expect(s).toContain("IDENTITY");
    expect(s).toContain("mcp__uniqlaw__agent_ask");
    expect(s).toContain("/w");
    expect(mcpConfigObject("http://x").mcpServers.uniqlaw.alwaysLoad).toBe(true);
  });
  test("isolated prompt names no path (the remote caller must not learn the project location)", () => {
    const s = composeAppendSystemPrompt({ parts: { fragments: [{ id: "a", text: "PUBLIC" }] }, permissions: { ...DEFAULT_PERMISSIONS, level: "strict" }, cwd: "/home/op/secret-project", isolated: true });
    expect(s).toContain("PUBLIC");
    expect(s).not.toContain("/home/op");
    expect(composeAppendSystemPrompt({ parts: { fragments: [] }, permissions: { ...DEFAULT_PERMISSIONS, level: "strict" }, cwd: "/home/op/x" })).toContain("/home/op/x");
  });
  test("native memory off → Claude auto-memory and auto-dream disabled (CLI flag and SDK option)", () => {
    expect(nativeMemoryArgs(false)).toEqual(["--settings", '{"autoMemoryEnabled":false,"autoDreamEnabled":false}']);
    expect(nativeMemoryArgs(undefined)).toEqual([]);
    expect(nativeMemoryArgs(true)).toEqual([]);
    expect(nativeMemorySettings(false)).toEqual({ settings: { autoMemoryEnabled: false, autoDreamEnabled: false } });
    expect(nativeMemorySettings(true)).toEqual({});
  });
  test("credential env", async () => {
    delete process.env.UQ_TEST_KEY; // other test files in the same `bun test` run may have set it
    expect(await claudeEnvForCredential({ kind: "anthropic-api-key", key: { env: "UQ_TEST_KEY" } }).catch((e) => String(e))).toContain("UQ_TEST_KEY");
    process.env.UQ_TEST_KEY = "k";
    expect(await claudeEnvForCredential({ kind: "anthropic-api-key", key: { env: "UQ_TEST_KEY" } })).toEqual({ ANTHROPIC_API_KEY: "k" });
    expect(await claudeEnvForCredential({ kind: "gcp", project: "p", location: "us-east5" })).toMatchObject({ CLAUDE_CODE_USE_VERTEX: "1", ANTHROPIC_VERTEX_PROJECT_ID: "p", CLOUD_ML_REGION: "us-east5" });
    expect(await claudeEnvForCredential({ kind: "aws", region: "us-west-2", profile: "dev" })).toMatchObject({ CLAUDE_CODE_USE_BEDROCK: "1", AWS_PROFILE: "dev" });
    expect(await claudeEnvForCredential({ kind: "provider-login", provider: "claude", home: "/tmp/cc" })).toEqual({ CLAUDE_CONFIG_DIR: "/tmp/cc" });
    await expect(claudeEnvForCredential({ kind: "openai-api-key", key: { env: "X" } })).rejects.toThrow();
  });
});
