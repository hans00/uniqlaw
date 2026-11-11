// Channel capabilities reach the claude CLI: the launch flags carry the granted tools, and changing a channel's
// tools makes a reattached claude (daemon reload) stale, so it is respawned with the new tool list.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PERMISSIONS, silentLogger, type AgentSession, type SessionSpec, type ToolPolicy } from "@uniqlaw/core";
import { ClaudeTmuxProvider } from "../src/provider.ts";
import type { Tmux } from "../src/tmux.ts";

const READY = ["", "─".repeat(60), "❯ ", "─".repeat(60), "  ? for shortcuts", ""].join("\n");

class FakeTmux {
  spawned: string[][] = [];
  alive = false;
  socket = "fake";
  async newSession(_n: string, o: { argv: string[] }) { this.spawned.push(o.argv); this.alive = true; }
  async hasSession() { return this.alive; }
  async paneDead() { return false; }
  async killSession() { this.alive = false; }
  async capture() { return READY; }
  async sendKeys() {}
  async typeLiteral() {}
  async paste() {}
}

const dirs: string[] = [];
const sessions: AgentSession[] = [];
afterEach(() => {
  for (const s of sessions.splice(0)) s.detach?.();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const until = async (cond: () => boolean, ms = 3000) => { const end = Date.now() + ms; while (!cond()) { if (Date.now() > end) throw new Error("timeout"); await Bun.sleep(5); } };

function spec(dir: string, toolPolicy: ToolPolicy | undefined, toolNames: string[], providerSessionId?: string): SessionSpec {
  return { sessionId: "discord:1", cwd: dir, profile: { name: "main", provider: "claude-tmux", permissions: DEFAULT_PERMISSIONS, options: {} },
    systemPrompt: { fragments: [] }, mcp: { url: "http://127.0.0.1:1/mcp/abc", token: "abc", toolNames },
    env: { CLAUDE_CONFIG_DIR: join(dir, "claude") }, instanceId: "t", ...(toolPolicy ? { toolPolicy } : {}),
    ...(providerSessionId ? { providerSessionId } : {}) };
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "uq-tp-"));
  dirs.push(dir);
  const tmux = new FakeTmux();
  const p = new ClaudeTmuxProvider({ claudePath: "claude", readyTimeoutMs: 2000, width: 200, height: 50, takeOverLegacy: false,
    timings: { pollRunningMs: 10, pollIdleMs: 10 } }, { log: silentLogger, stateDir: dir });
  p.tmuxFor = () => tmux as unknown as Tmux;
  return { dir, tmux, p };
}
const flag = (argv: string[], f: string) => argv[argv.indexOf(f) + 1];

test("a channel without cron launches claude without cron_*; adding cron + reload respawns it with cron_*", async () => {
  const { dir, tmux, p } = setup();
  const narrow: ToolPolicy = { mode: "allow", groups: ["chat", "memory"] };
  const s1 = await p.open(spec(dir, narrow, ["send_file", "memory_write", "memory_search", "memory_get"]));
  sessions.push(s1);
  const first = tmux.spawned[0]!;
  expect(flag(first, "--allowedTools")).not.toContain("cron_");
  expect(flag(first, "--tools")).toBe("TodoWrite");
  expect(first).toContain("--strict-mcp-config");
  s1.detach!(); // daemon reload: tmux keeps running

  // Same policy: reattached as is.
  const sameId = "00000000-0000-4000-8000-000000000001";
  const again = await p.open(spec(dir, narrow, ["send_file", "memory_write", "memory_search", "memory_get"], sameId));
  sessions.push(again);
  await Bun.sleep(60);
  expect(tmux.spawned).toHaveLength(1);
  again.detach!();

  // cron added to the channel: the launch flags differ → the live claude is respawned with them.
  const wide: ToolPolicy = { mode: "allow", groups: ["chat", "memory", "cron"] };
  const s2 = await p.open(spec(dir, wide, ["send_file", "memory_write", "memory_search", "memory_get", "cron_list", "cron_save", "cron_delete"], sameId));
  sessions.push(s2);
  await until(() => tmux.spawned.length === 2);
  const allowed = flag(tmux.spawned[1]!, "--allowedTools")!.split(" ");
  expect(allowed).toEqual(expect.arrayContaining(["mcp__uniqlaw__cron_list", "mcp__uniqlaw__cron_save", "mcp__uniqlaw__cron_delete"]));
});

test("no channel policy: launch flags are unchanged (whole uniqlaw server allowed, default built-ins)", async () => {
  const { dir, tmux, p } = setup();
  sessions.push(await p.open(spec(dir, undefined, ["agents_list", "cron_list"])));
  const argv = tmux.spawned[0]!;
  expect(flag(argv, "--allowedTools")).toBe("mcp__uniqlaw");
  expect(argv).not.toContain("--tools");
  expect(argv).not.toContain("--strict-mcp-config");
});
