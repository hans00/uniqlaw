// SessionSpec.isolated (inbound A2A) → the claude launch command: no built-in tools, no settings files, only
// UniQlaw's MCP server, native memory off, no operator extraArgs, path-free prompt. Uses a fake tmux.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PERMISSIONS, silentLogger, type SessionSpec } from "@uniqlaw/core";
import { ClaudeTmuxProvider } from "../src/provider.ts";
import type { Tmux } from "../src/tmux.ts";

const READY = ["", "─".repeat(60), "❯ ", "─".repeat(60), "  ? for shortcuts", ""].join("\n");
class FakeTmux {
  argv: string[] = [];
  cwd = "";
  async newSession(_n: string, o: { cwd: string; argv: string[] }) { this.argv = o.argv; this.cwd = o.cwd; }
  async capture() { return READY; }
  async paneDead() { return false; }
  async hasSession() { return false; }
  async sendKeys() {}
  async typeLiteral() {}
  async paste() {}
  async killSession() {}
}

const dirs: string[] = [];
const provs: ClaudeTmuxProvider[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

async function launch(isolated: boolean, judge?: "off" | "shadow") {
  const state = mkdtempSync(join(tmpdir(), "uq-tmux-iso-"));
  dirs.push(state);
  const tmux = new FakeTmux();
  const p = new ClaudeTmuxProvider({ claudePath: "claude", readyTimeoutMs: 2000, width: 100, height: 30, takeOverLegacy: false }, { log: silentLogger, stateDir: state });
  p.tmuxFor = () => tmux as unknown as Tmux;
  provs.push(p);
  const spec: SessionSpec = { sessionId: isolated ? "a2a:main:alice:c" : "tg:1", cwd: "/home/op/project", instanceId: "t", env: { CLAUDE_CONFIG_DIR: state },
    profile: { name: "main", provider: "claude-tmux", options: { extraArgs: ["--add-dir", "/home/op"] },
      permissions: { ...DEFAULT_PERMISSIONS, level: "strict", approval: { ...DEFAULT_PERMISSIONS.approval,
        ...(judge ? { judge: { provider: "fake", mode: judge, allowAbove: 0.9, byKind: { chat: 0.9, worker: 0.93, cron: 0.97, peer: 0.97 }, timeoutMs: 5000, audit: true } } : {}) } } },
    systemPrompt: { fragments: [{ id: "p", text: "PUBLIC PROMPT" }] },
    mcp: { url: "http://127.0.0.1:1/mcp/x", token: "x", toolNames: [], permissionHookUrl: "http://127.0.0.1:1/hook/x/permission" },
    nativeMemory: true, ...(isolated ? { isolated: true } : {}) };
  const s = await p.open(spec);
  s.detach?.();
  const flag = (f: string) => tmux.argv[tmux.argv.indexOf(f) + 1];
  const prompt = readFileSync(flag("--append-system-prompt-file")!, "utf8");
  return { argv: tmux.argv, flag, prompt };
}

test("isolated: --tools \"\", --setting-sources \"\", --strict-mcp-config, memory off, no extraArgs, no path in prompt", async () => {
  const { argv, flag, prompt } = await launch(true);
  expect(flag("--tools")).toBe("");
  expect(flag("--setting-sources")).toBe("");
  expect(argv).toContain("--strict-mcp-config");
  expect(argv).toContain("--mcp-config");
  expect(flag("--settings")).toBe('{"autoMemoryEnabled":false,"autoDreamEnabled":false}');
  expect(argv).not.toContain("--add-dir");
  expect(prompt).toContain("PUBLIC PROMPT");
  expect(prompt).not.toContain("/home/op");
});

test("not isolated: chats keep the operator's settings sources, extraArgs and native memory setting", async () => {
  const { argv, prompt } = await launch(false);
  for (const f of ["--tools", "--setting-sources", "--strict-mcp-config", "--settings"]) expect(argv).not.toContain(f);
  expect(argv).toContain("--add-dir");
  expect(prompt).toContain("/home/op/project");
});

test("approval judge on: one --settings with the PermissionRequest HTTP hook (also isolated); off: no hook", async () => {
  const hook = { PermissionRequest: [{ matcher: "*", hooks: [{ type: "http", url: "http://127.0.0.1:1/hook/x/permission", timeout: 10 }] }] };
  const chat = await launch(false, "shadow");
  expect(chat.argv.filter((a) => a === "--settings")).toHaveLength(1);
  expect(JSON.parse(chat.flag("--settings")!)).toEqual({ hooks: hook });
  const iso = await launch(true, "shadow");
  expect(JSON.parse(iso.flag("--settings")!)).toEqual({ autoMemoryEnabled: false, autoDreamEnabled: false, hooks: hook });
  expect((await launch(false, "off")).argv).not.toContain("--settings");
  expect((await launch(true, "off")).flag("--settings")).toBe('{"autoMemoryEnabled":false,"autoDreamEnabled":false}');
});
