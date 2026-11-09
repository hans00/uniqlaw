// Reattach paths with a fake tmux: a pane that sits on a permission dialog (it opened while the
// daemon was down) must surface it; a process started with stale flags is respawned once idle.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { silentLogger, type AgentEvent } from "@uniqlaw/core";
import { ClaudeTmuxSession } from "../src/session.ts";
import type { Tmux } from "../src/tmux.ts";

const DIALOG = readFileSync(join(import.meta.dir, "fixtures", "permission-dialog-2.1.319.txt"), "utf8");
const READY = ["", "─".repeat(60), "❯ ", "─".repeat(60), "  ? for shortcuts", ""].join("\n");

class FakeTmux {
  pane = READY;
  keys: string[] = [];
  alive = true;
  async capture() { if (!this.alive) throw new Error("no session"); return this.pane; }
  async paneDead() { return false; }
  async hasSession() { return this.alive; }
  async sendKeys(_n: string, ...k: string[]) { this.keys.push(...k); }
  async typeLiteral() {}
  async paste() {}
  async killSession() { this.alive = false; }
}

let dir: string | undefined;
const sessions: ClaudeTmuxSession[] = [];
afterEach(async () => {
  for (const s of sessions.splice(0)) s.detach();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function make(tmux: FakeTmux, extra: { respawn?: () => Promise<void> } = {}) {
  dir = mkdtempSync(join(tmpdir(), "uq-tmux-"));
  const s = new ClaudeTmuxSession({ tmux: tmux as unknown as Tmux, name: "t", providerSessionId: "00000000-0000-0000-0000-000000000001",
    cwd: dir, env: { CLAUDE_CONFIG_DIR: dir }, log: silentLogger, timings: { pollRunningMs: 10, pollIdleMs: 10 }, readyTimeoutMs: 2000, ...extra }, "end");
  sessions.push(s);
  const events: AgentEvent[] = [];
  void (async () => { for await (const ev of s.events) events.push(ev); })();
  return { s, events };
}
const until = async (cond: () => boolean, ms = 2000) => { const end = Date.now() + ms; while (!cond()) { if (Date.now() > end) throw new Error("timeout"); await Bun.sleep(5); } };

test("reattaching to a pane that sits on a permission dialog surfaces it (Claude Code 2.1.319 layout)", async () => {
  const tmux = new FakeTmux();
  tmux.pane = DIALOG;
  const { s, events } = make(tmux);
  await s.start({ reattach: true });
  await until(() => events.some((e) => e.type === "permission_request"));
  const req = events.find((e) => e.type === "permission_request") as Extract<AgentEvent, { type: "permission_request" }>;
  expect(req.options).toEqual(["Yes", "Yes, and switch to auto mode · auto mode handles these prompts for you", "No"]);
  expect(String(req.input)).toContain("can't be checked before it runs");
  expect(events.some((e) => e.type === "unsolicited_turn")).toBe(true); // core gets a turn to route the approval
  await s.respondPermission!(req.id, { behavior: "deny" }, 3);
  expect(tmux.keys.length).toBeGreaterThan(0);
});

test("stale launch flags: an idle reattached claude is respawned (--resume) before taking input", async () => {
  const tmux = new FakeTmux();
  let respawns = 0;
  const { s } = make(tmux, { respawn: async () => { respawns++; tmux.alive = true; tmux.pane = READY; } });
  await s.start({ reattach: true, staleLaunch: true });
  await until(() => respawns === 1);
  await s.send({ text: "hi", attachments: [] });
  expect(respawns).toBe(1);
});

test("fresh launch flags: no respawn", async () => {
  const tmux = new FakeTmux();
  let respawns = 0;
  const { s } = make(tmux, { respawn: async () => { respawns++; } });
  await s.start({ reattach: true, staleLaunch: false });
  await Bun.sleep(50);
  expect(respawns).toBe(0);
});
