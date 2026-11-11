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

test("a reply written while the daemon was down is emitted after reattach (jsonl position kept across detach)", async () => {
  const tmux = new FakeTmux();
  const { s: first } = make(tmux, {});
  const d = dir!;
  const { mkdirSync, appendFileSync, writeFileSync, existsSync } = await import("node:fs");
  const { expectedJsonlPath } = await import("@uniqlaw/claude-common");
  const jsonl = expectedJsonlPath("00000000-0000-0000-0000-000000000001", d, { CLAUDE_CONFIG_DIR: d });
  mkdirSync(join(jsonl, ".."), { recursive: true });
  writeFileSync(jsonl, JSON.stringify({ type: "user", message: { content: "long task" } }) + "\n");
  const tail = join(d, "tail.json");
  (first as unknown as { init: { tailStateFile?: string } }).init.tailStateFile = tail;
  await first.start({ reattach: true });
  await Bun.sleep(30);
  first.detach();
  expect(existsSync(tail)).toBe(true);
  // While the daemon is down, claude finishes the turn.
  appendFileSync(jsonl, JSON.stringify({ type: "assistant", message: { id: "m1", stop_reason: "end_turn", content: [{ type: "text", text: "done while you were away" }] } }) + "\n");

  const second = new ClaudeTmuxSession({ tmux: tmux as unknown as Tmux, name: "t", providerSessionId: "00000000-0000-0000-0000-000000000001",
    cwd: d, env: { CLAUDE_CONFIG_DIR: d }, log: silentLogger, timings: { pollRunningMs: 10, pollIdleMs: 10 }, readyTimeoutMs: 2000, tailStateFile: tail }, "end");
  sessions.push(second);
  const events: AgentEvent[] = [];
  void (async () => { for await (const ev of second.events) events.push(ev); })();
  await second.start({ reattach: true });
  await until(() => events.some((e) => e.type === "turn_end"), 8000);
  const types = events.map((e) => e.type).filter((t) => t === "unsolicited_turn" || t === "text" || t === "turn_end");
  expect(types).toEqual(["unsolicited_turn", "text", "turn_end"]); // a turn of its own: core routes it to the resumed origins
  expect(events.find((e) => e.type === "text")).toMatchObject({ final: "done while you were away" });
  expect(existsSync(tail)).toBe(false);
}, 15_000);
