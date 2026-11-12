// The provider's stall watchdog: a turn with no jsonl writes is a stall only if there is no other liveness signal
// (pane busy, pane output changing, a dialog, a tool in flight). A long single tool call must not count.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { silentLogger, type AgentEvent, type Logger } from "@uniqlaw/core";
import { ClaudeTmuxSession, type Timings } from "../src/session.ts";
import type { Tmux } from "../src/tmux.ts";

const PROMPT = ["─".repeat(60), "❯ ", "─".repeat(60), "  ? for shortcuts", ""];
const READY = ["", ...PROMPT].join("\n");
const busyPane = (sec: number, out = "") => ["● Bash(bun test)", `  ⎿  ${out}`, "", `✻ Running… (${Math.floor(sec / 60)}m ${sec % 60}s · esc to interrupt)`, "", ...PROMPT].join("\n");
const outputPane = (line: string) => ["● Bash(gh run watch)", `  ⎿  ${line}`, "", ...PROMPT].join("\n");

class FakeTmux {
  pane = READY;
  async capture() { return this.pane; }
  async paneDead() { return false; }
  async hasSession() { return true; }
  async sendKeys() {}
  async typeLiteral() {}
  async paste() {}
  async killSession() {}
}

const dirs: string[] = [];
const sessions: ClaudeTmuxSession[] = [];
afterEach(() => {
  for (const s of sessions.splice(0)) s.detach();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Line = { msg: string; extra?: Record<string, unknown> };
async function running(timings: Partial<Timings>) {
  const tmux = new FakeTmux();
  const dir = mkdtempSync(join(tmpdir(), "uq-stall-"));
  dirs.push(dir);
  const warns: Line[] = [];
  const log: Logger = { ...silentLogger, warn: (msg, extra) => { warns.push({ msg, extra }); }, child: () => log };
  const s = new ClaudeTmuxSession({ tmux: tmux as unknown as Tmux, name: "t", providerSessionId: "00000000-0000-0000-0000-000000000002",
    cwd: dir, env: { CLAUDE_CONFIG_DIR: dir }, log, readyTimeoutMs: 2000,
    timings: { pollRunningMs: 10, pollIdleMs: 10, pasteSettleMs: 0, stallMs: 150, stallMaxMs: 400, ...timings } }, "end");
  sessions.push(s);
  const events: AgentEvent[] = [];
  void (async () => { for await (const ev of s.events) events.push(ev); })();
  await s.start({ reattach: true });
  await s.send({ text: "run the long thing", attachments: [] });
  const stalled = () => events.some((e) => e.type === "turn_end" && e.error === "stall");
  return { s, tmux, events, warns, stalled };
}

test("long tool call: pane busy (spinner ticking) with no jsonl writes, well past stallMs and stallMaxMs → not stalled", async () => {
  const { tmux, stalled, s } = await running({});
  let sec = 125;
  tmux.pane = busyPane(sec);
  const tick = setInterval(() => { tmux.pane = busyPane(++sec); }, 50);
  try {
    await Bun.sleep(900); // > 2 × stallMaxMs since the turn started, no jsonl at all
    expect(stalled()).toBe(false);
    const live = await s.liveness();
    expect(live.busy).toBe(true);
    expect(live.signals).toMatchObject({ paneBusy: true, state: "running" });
    expect(live.signals!.jsonlQuietMs as number).toBeGreaterThan(400);
  } finally { clearInterval(tick); }
});

test("long tool call: no spinner, but its output keeps changing in the pane → not stalled; then nothing changes at the prompt → stalled", async () => {
  const { tmux, stalled, warns } = await running({});
  let n = 0;
  tmux.pane = outputPane("queued");
  const tick = setInterval(() => { tmux.pane = outputPane(`run 4309 in progress, step ${String.fromCharCode(97 + (++n % 26))}`); }, 50);
  await Bun.sleep(700);
  clearInterval(tick);
  expect(stalled()).toBe(false);

  // output stops; claude sits at its prompt with nothing moving → a real stall
  const until = Date.now() + 2000;
  while (!stalled() && Date.now() < until) await Bun.sleep(10);
  expect(stalled()).toBe(true);
  const w = warns.find((x) => x.msg.startsWith("stall:"))!;
  expect(w.msg).toContain("no liveness signal");
  expect(w.extra).toMatchObject({ paneBusy: false, ready: true, dialog: false, toolsInFlight: 0, alive: false });
  expect(w.extra!.jsonlQuietMs as number).toBeGreaterThan(150);
  expect(w.extra!.paneQuietMs as number).toBeGreaterThan(150);
});

test("no activity at all past the threshold (static pane, not busy, not at a prompt) → stalled after stallMaxMs", async () => {
  const { tmux, stalled, warns } = await running({});
  tmux.pane = "some half-drawn screen with no prompt\n";
  await Bun.sleep(250);
  expect(stalled()).toBe(false); // past stallMs but not stallMaxMs: an unknown screen gets longer
  const until = Date.now() + 2000;
  while (!stalled() && Date.now() < until) await Bun.sleep(10);
  expect(stalled()).toBe(true);
  expect(warns.find((x) => x.msg.startsWith("stall:"))!.extra).toMatchObject({ ready: false, paneBusy: false });
});

test("busyHardCapMs > 0: a busy pane without jsonl writes for that long is still a stall (hung tool)", async () => {
  const { tmux, stalled, warns } = await running({ busyHardCapMs: 500 });
  let sec = 0;
  const tick = setInterval(() => { tmux.pane = busyPane(++sec); }, 50);
  try {
    const until = Date.now() + 2000;
    while (!stalled() && Date.now() < until) await Bun.sleep(10);
    expect(stalled()).toBe(true);
    expect(warns.find((x) => x.msg.startsWith("stall:"))!.msg).toContain("hard ceiling");
  } finally { clearInterval(tick); }
});
