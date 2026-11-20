// Reattach paths with a fake tmux: a pane that sits on a permission dialog (it opened while the
// daemon was down) must surface it; a process started with stale flags is respawned once idle.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { silentLogger, type AgentEvent } from "@uniqlaw/core";
import { ClaudeTmuxSession } from "../src/session.ts";
import { isVolatileLine } from "../src/dialogs.ts";
import type { Tmux } from "../src/tmux.ts";

const DIALOG = readFileSync(join(import.meta.dir, "fixtures", "permission-dialog-2.1.319.txt"), "utf8");
const READY = ["", "─".repeat(60), "❯ ", "─".repeat(60), "  ? for shortcuts", ""].join("\n");

class FakeTmux {
  pane = READY;
  keys: string[] = [];
  alive = true;
  captures = 0;
  async capture() { if (!this.alive) throw new Error("no session"); this.captures++; return this.pane; }
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

function make(tmux: FakeTmux, extra: { respawn?: () => Promise<void> } = {}, timings: { dialogGraceMs?: number } = {}) {
  dir = mkdtempSync(join(tmpdir(), "uq-tmux-"));
  const s = new ClaudeTmuxSession({ tmux: tmux as unknown as Tmux, name: "t", providerSessionId: "00000000-0000-0000-0000-000000000001",
    cwd: dir, env: { CLAUDE_CONFIG_DIR: dir }, log: silentLogger, timings: { pollRunningMs: 10, pollIdleMs: 10, dialogWithdrawnMs: 300, dialogGraceMs: 50, ...timings }, readyTimeoutMs: 2000, ...extra }, "end");
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
    cwd: d, env: { CLAUDE_CONFIG_DIR: d }, log: silentLogger, timings: { pollRunningMs: 10, pollIdleMs: 10, dialogWithdrawnMs: 300 }, readyTimeoutMs: 2000, tailStateFile: tail }, "end");
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

test("claude exited while the daemon was down: the --resume respawn still emits the reply it wrote before exiting", async () => {
  const tmux = new FakeTmux();
  const { s: first } = make(tmux, {});
  const d = dir!;
  const { mkdirSync, appendFileSync, writeFileSync } = await import("node:fs");
  const { expectedJsonlPath } = await import("@uniqlaw/claude-common");
  const jsonl = expectedJsonlPath("00000000-0000-0000-0000-000000000001", d, { CLAUDE_CONFIG_DIR: d });
  mkdirSync(join(jsonl, ".."), { recursive: true });
  writeFileSync(jsonl, JSON.stringify({ type: "user", message: { content: "task" } }) + "\n");
  const tail = join(d, "tail.json");
  (first as unknown as { init: { tailStateFile?: string } }).init.tailStateFile = tail;
  await first.start({ reattach: true });
  await Bun.sleep(30);
  first.detach();
  appendFileSync(jsonl, JSON.stringify({ type: "assistant", message: { id: "m2", stop_reason: "end_turn", content: [{ type: "text", text: "finished, then claude exited" }] } }) + "\n");
  // Pane dead → the provider spawns claude --resume (same session id, same jsonl) and starts a non-reattach session.
  const second = new ClaudeTmuxSession({ tmux: tmux as unknown as Tmux, name: "t", providerSessionId: "00000000-0000-0000-0000-000000000001",
    cwd: d, env: { CLAUDE_CONFIG_DIR: d }, log: silentLogger, timings: { pollRunningMs: 10, pollIdleMs: 10, dialogWithdrawnMs: 300 }, readyTimeoutMs: 2000, tailStateFile: tail }, "end");
  sessions.push(second);
  const events: AgentEvent[] = [];
  void (async () => { for await (const ev of second.events) events.push(ev); })();
  await second.start({ reattach: false });
  await until(() => events.some((e) => e.type === "turn_end"), 8000);
  expect(events.map((e) => e.type).filter((t) => t === "unsolicited_turn" || t === "text" || t === "turn_end")).toEqual(["unsolicited_turn", "text", "turn_end"]);
  expect(events.find((e) => e.type === "text")).toMatchObject({ final: "finished, then claude exited" });
}, 15_000);

test("a dialog answered in the terminal (or replaced by another) is reported withdrawn, so core cancels its prompt", async () => {
  const tmux = new FakeTmux();
  tmux.pane = DIALOG;
  const { s, events } = make(tmux);
  await s.start({ reattach: true });
  await until(() => events.some((e) => e.type === "permission_request"));
  const req = events.find((e) => e.type === "permission_request") as Extract<AgentEvent, { type: "permission_request" }>;
  const gone = Date.now();
  tmux.pane = READY; // someone answered it in the attached terminal
  await until(() => events.some((e) => e.type === "permission_withdrawn"));
  expect(Date.now() - gone).toBeGreaterThanOrEqual(290); // only after it stayed gone for dialogWithdrawnMs
  expect(events.find((e) => e.type === "permission_withdrawn")).toEqual({ type: "permission_withdrawn", id: req.id });
});

test("a dialog we answered is not reported withdrawn", async () => {
  const tmux = new FakeTmux();
  tmux.pane = DIALOG;
  const { s, events } = make(tmux);
  await s.start({ reattach: true });
  await until(() => events.some((e) => e.type === "permission_request"));
  const req = events.find((e) => e.type === "permission_request") as Extract<AgentEvent, { type: "permission_request" }>;
  await s.respondPermission!(req.id, { behavior: "allow" }, 1);
  tmux.pane = READY;
  await Bun.sleep(100);
  expect(events.some((e) => e.type === "permission_withdrawn")).toBe(false);
});

test("a dialog hidden briefly by a redraw, or redrawn with other option text, is not withdrawn and not asked twice", async () => {
  const tmux = new FakeTmux();
  tmux.pane = DIALOG;
  const { s, events } = make(tmux);
  await s.start({ reattach: true });
  await until(() => events.some((e) => e.type === "permission_request"));
  const req = events.find((e) => e.type === "permission_request") as Extract<AgentEvent, { type: "permission_request" }>;
  tmux.pane = READY; // gone for many polls, but shorter than dialogWithdrawnMs
  await Bun.sleep(120);
  tmux.pane = DIALOG;
  await Bun.sleep(80);
  tmux.pane = DIALOG.replace("Yes, and switch to auto mode · auto mode handles these prompts for you", "Yes, and don't ask again for this command");
  await Bun.sleep(500);
  expect(events.filter((e) => e.type === "permission_request")).toHaveLength(1);
  expect(events.some((e) => e.type === "permission_withdrawn")).toBe(false);
  // Our answer still reaches the (redrawn) dialog under its first id.
  await s.respondPermission!(req.id, { behavior: "allow" }, 1);
  expect(tmux.keys.length).toBeGreaterThan(0);
});

test("a different request replacing the dialog withdraws the old one at once", async () => {
  const tmux = new FakeTmux();
  tmux.pane = DIALOG;
  const { s, events } = make(tmux);
  await s.start({ reattach: true });
  await until(() => events.some((e) => e.type === "permission_request"));
  tmux.pane = DIALOG.replaceAll('FOO=$(date +%s); echo "$FOO" > out.txt', "rm -rf build");
  await until(() => events.filter((e) => e.type === "permission_request").length === 2);
  expect(events.some((e) => e.type === "permission_withdrawn")).toBe(true);
});

// Auto mode draws a dialog while its classifier decides; most are settled within a second. Forwarding each one
// would send the operator a prompt and then a "Cancelled — resolved elsewhere" edit (a burst of them hit Telegram 429).
const OTHER = DIALOG.replaceAll('FOO=$(date +%s); echo "$FOO" > out.txt', "rm -rf build");
const nextPoll = async (tmux: FakeTmux) => { const n = tmux.captures; await until(() => tmux.captures > n); };
const asked = (events: AgentEvent[]) => events.filter((e) => e.type === "permission_request") as Extract<AgentEvent, { type: "permission_request" }>[];

test("grace period: a dialog gone after one poll is never forwarded (no prompt, no withdrawal)", async () => {
  const tmux = new FakeTmux();
  const { s, events } = make(tmux, {}, { dialogGraceMs: 2000 });
  await s.start({ reattach: true });
  tmux.pane = DIALOG;
  await nextPoll(tmux);
  tmux.pane = READY;
  await Bun.sleep(2500);
  expect(asked(events)).toHaveLength(0);
  expect(events.some((e) => e.type === "permission_withdrawn")).toBe(false);
}, 10_000);

test("grace period: a dialog that stays on screen past it is forwarded once, and only then", async () => {
  const tmux = new FakeTmux();
  const { s, events } = make(tmux, {}, { dialogGraceMs: 2000 });
  await s.start({ reattach: true });
  const shown = Date.now();
  tmux.pane = DIALOG;
  await Bun.sleep(1500);
  expect(asked(events)).toHaveLength(0);
  await until(() => asked(events).length === 1, 3000);
  expect(Date.now() - shown).toBeGreaterThanOrEqual(1990);
  await Bun.sleep(500);
  expect(asked(events)).toHaveLength(1);
  // Typing waits while it is open; our answer reaches it.
  await s.respondPermission!(asked(events)[0]!.id, { behavior: "allow" }, 1);
  expect(tmux.keys.length).toBeGreaterThan(0);
}, 10_000);

test("grace period: a dialog replaced within it is not forwarded; the replacement is, only if it stays", async () => {
  const tmux = new FakeTmux();
  const { s, events } = make(tmux, {}, { dialogGraceMs: 2000 });
  await s.start({ reattach: true });
  tmux.pane = DIALOG;
  await Bun.sleep(1000);
  tmux.pane = OTHER; // the first one was settled; another request took its place
  await Bun.sleep(1500); // past the first one's grace, not the second's
  expect(asked(events)).toHaveLength(0);
  await until(() => asked(events).length === 1, 3000);
  expect(String(asked(events)[0]!.input)).toContain("rm -rf build");
  expect(events.some((e) => e.type === "permission_withdrawn")).toBe(false);

  // A replacement that is itself settled within its grace period: nothing at all.
  const tmux2 = new FakeTmux();
  const second = make(tmux2, {}, { dialogGraceMs: 2000 });
  await second.s.start({ reattach: true });
  tmux2.pane = DIALOG;
  await Bun.sleep(800);
  tmux2.pane = OTHER;
  await Bun.sleep(800);
  tmux2.pane = READY;
  await Bun.sleep(2500);
  expect(asked(second.events)).toHaveLength(0);
  expect(second.events.some((e) => e.type === "permission_withdrawn")).toBe(false);
}, 15_000);

// Auto mode's dialog carries a countdown ("Claude Code will automatically block this request in 0:42") that ticks
// every second. Taken into the dialog's identity, each tick read as a new request replacing the old one: a withdrawal
// plus another prompt per second (a burst of askChoice + "Cancelled" edits, then Telegram 429).
const countdown = (where: "question" | "footer", secs: number) => {
  const line = ` Claude Code will automatically block this request in 0:${String(secs).padStart(2, "0")}`;
  return where === "question"
    ? DIALOG.replace(" Do you want to proceed?", `${line}\n\n Do you want to proceed?`)
    : DIALOG.replace("   3. No\n", `   3. No\n${line}\n`);
};
for (const where of ["question", "footer"] as const) {
  test(`a ticking auto-mode countdown (${where}) is the same dialog: asked once, never withdrawn`, async () => {
    const tmux = new FakeTmux();
    const { s, events } = make(tmux);
    await s.start({ reattach: true });
    tmux.pane = countdown(where, 59);
    await until(() => asked(events).length === 1);
    for (let secs = 58; secs > 50; secs--) { tmux.pane = countdown(where, secs); await Bun.sleep(100); }
    expect(asked(events)).toHaveLength(1);
    expect(events.some((e) => e.type === "permission_withdrawn")).toBe(false);
    const req = asked(events)[0]!;
    expect(String(req.input)).not.toContain("automatically block");
    expect(req.options).toEqual(["Yes", "Yes, and switch to auto mode · auto mode handles these prompts for you", "No"]);
    await s.respondPermission!(req.id, { behavior: "allow" }, 1);
    expect(tmux.keys.length).toBeGreaterThan(0);
  });
}

test("countdown filter keeps a request's own text", () => {
  for (const l of ["timeout 30s curl https://x", "Configure git to automatically run hooks", "sleep 5s && echo left in 3"])
    expect(isVolatileLine(l)).toBe(false);
  for (const l of [" Tip: auto mode handles these prompts", "Claude Code will automatically block this request in 0:42", "Auto-deny in 30s"])
    expect(isVolatileLine(l)).toBe(true);
});

test("processRoot is claude's pane pid (the approval judge checks process ownership against it)", async () => {
  const tmux = new FakeTmux() as FakeTmux & { panePid: () => Promise<number> };
  tmux.panePid = async () => 4242;
  const { s } = make(tmux);
  await s.start({ reattach: true });
  await until(() => s.processRoot() === 4242);
});
