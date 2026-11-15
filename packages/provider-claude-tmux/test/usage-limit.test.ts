// Claude Code's usage-limit messages: detected from the pane (or a synthetic jsonl message), the turn ends at once
// as "usage_limit" with the reset time, instead of sitting at the prompt until the stall watchdog gives up.
// Incident 2026-11-15T16:25Z: "You've hit your 5-hour limit · resets 2:10am (Asia/Taipei)" was reported as a stall.
import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { silentLogger, type AgentEvent, type Logger } from "@uniqlaw/core";
import { encodeProjectDir } from "@uniqlaw/claude-common";
import { ClaudeTmuxSession } from "../src/session.ts";
import { isUsageLimit, parseResetTime, parseUsageLimit } from "../src/pane.ts";
import type { Tmux } from "../src/tmux.ts";

const INCIDENT_LINE = "You've hit your 5-hour limit · resets 2:10am (Asia/Taipei)";
const NOW = Date.parse("2026-11-15T16:23:00Z"); // the cron job fired at 00:23 Taipei
const RULE = "─".repeat(80);
const BOX = [RULE, "❯ ", RULE, "  ⏵⏵ bypass permissions on (shift+tab to cycle)", ""];
const pane = (...body: string[]) => ["", ...body, "", ...BOX].join("\n");
const INCIDENT_PANE = pane("❯ [heartbeat] xiaomo-issues-heartbeat: check the open issues", `  ⎿  ${INCIDENT_LINE}`, "     /upgrade to increase your usage limit.");
const iso = (ms?: number) => (ms === undefined ? undefined : new Date(ms).toISOString());

describe("parseUsageLimit", () => {
  test("the incident pane: 5-hour limit, Claude's reset wording, reset at 02:10 Taipei = 18:10Z the same day", () => {
    const l = parseUsageLimit(INCIDENT_PANE, NOW)!;
    expect(l).toMatchObject({ kind: "5-hour", resets: "2:10am (Asia/Taipei)", line: INCIDENT_LINE });
    expect(iso(l.resetAt)).toBe("2026-11-15T18:10:00.000Z");
    expect(isUsageLimit(INCIDENT_PANE)).toBe(true);
  });

  test("weekly limit with a date; generic usage limit (older wording); no zone → this machine's zone", () => {
    const w = parseUsageLimit(pane("❯ hi", "  ⎿  You've hit your weekly limit · resets Nov 20, 3am (Asia/Taipei)"), NOW)!;
    expect(w).toMatchObject({ kind: "weekly", resets: "Nov 20, 3am (Asia/Taipei)" });
    expect(iso(w.resetAt)).toBe("2026-11-19T19:00:00.000Z");
    const g = parseUsageLimit(pane("❯ hi", "  ⎿  Claude usage limit reached. Your limit will reset at 3pm (America/New_York)."), NOW)!;
    expect(g).toMatchObject({ kind: "usage", resets: "3pm (America/New_York)" });
    expect(iso(g.resetAt)).toBe("2026-11-15T20:00:00.000Z");
    const short = parseUsageLimit(pane("❯ hi", "● 5-hour limit reached ∙ resets 4pm"), NOW)!;
    expect(short).toMatchObject({ kind: "5-hour", resets: "4pm" });
    expect(short.resetAt).toBeGreaterThan(NOW);
    expect(short.resetAt! - NOW).toBeLessThanOrEqual(24 * 3600_000);
  });

  test("a curly apostrophe and a reset wrapped onto the next line still parse", () => {
    const l = parseUsageLimit(pane("❯ hi", "  ⎿  You’ve hit your 5-hour limit ·", "     resets 2:10am (Asia/Taipei)"), NOW)!;
    expect(l).toMatchObject({ kind: "5-hour", resets: "2:10am (Asia/Taipei)" });
  });

  test("a reset that can't be read: still a usage limit, just without an epoch", () => {
    const l = parseUsageLimit(pane("❯ hi", "  ⎿  You've hit your limit · resets soon"), NOW)!;
    expect(l.kind).toBe("usage");
    expect(l.resetAt).toBeUndefined();
    expect(parseUsageLimit(pane("❯ hi", "  ⎿  You've hit your 5-hour limit"), NOW)).toMatchObject({ kind: "5-hour" });
  });

  test("stale: a limit from an earlier turn sits above the newer prompt echo → not this turn's", () => {
    const p = pane("❯ earlier", `  ⎿  ${INCIDENT_LINE}`, "", "❯ new question after the reset", "", "● Let me look.");
    expect(parseUsageLimit(p, NOW)).toBeUndefined();
  });

  test("warnings and rate limits are not the usage limit", () => {
    expect(parseUsageLimit(pane("❯ hi", "● Hello", "", "  You've used 90% of your weekly limit · resets Nov 20, 3am"), NOW)).toBeUndefined();
    expect(parseUsageLimit(pane("❯ hi", "  Approaching usage limit · resets 2:10am"), NOW)).toBeUndefined();
    expect(isUsageLimit(pane("❯ hi", "  ⎿  API Error: Request rejected (429) · this is a rate limit, not your usage limit"))).toBe(false);
    expect(parseUsageLimit(READY_ONLY, NOW)).toBeUndefined();
  });

  test("the transcript's synthetic form carries the reset as epoch seconds", () => {
    const l = parseUsageLimit("Claude AI usage limit reached|1794766200", NOW)!;
    expect(l.kind).toBe("usage");
    expect(iso(l.resetAt)).toBe("2026-11-15T18:10:00.000Z");
  });

  test("parseResetTime: weekday, 24-hour clock, already passed today → tomorrow, unknown zone → undefined", () => {
    expect(iso(parseResetTime("Thu 3am (UTC)", NOW))).toBe("2026-11-19T03:00:00.000Z");
    expect(iso(parseResetTime("14:30 (UTC)", NOW))).toBe("2026-11-16T14:30:00.000Z");
    expect(iso(parseResetTime("12am (Asia/Taipei)", NOW))).toBe("2026-11-16T16:00:00.000Z");
    expect(parseResetTime("3am (Not/AZone)", NOW)).toBeUndefined();
    expect(parseResetTime("whenever", NOW)).toBeUndefined();
  });
});

const READY_ONLY = pane();

class FakeTmux {
  pane = READY_ONLY;
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
const waitFor = async (c: () => boolean, ms: number) => { const end = Date.now() + ms; while (!c() && Date.now() < end) await Bun.sleep(10); };
const SID = "00000000-0000-0000-0000-00000000000a";

async function running() {
  const tmux = new FakeTmux();
  const dir = mkdtempSync(join(tmpdir(), "uq-limit-"));
  dirs.push(dir);
  const jsonl = join(dir, "projects", encodeProjectDir(dir), `${SID}.jsonl`);
  mkdirSync(join(jsonl, ".."), { recursive: true });
  writeFileSync(jsonl, "");
  const warns: { msg: string; extra?: Record<string, unknown> }[] = [];
  const log: Logger = { ...silentLogger, warn: (msg, extra) => { warns.push({ msg, extra }); }, child: () => log };
  // Stall windows far beyond the test: only the usage-limit path can end the turn.
  const s = new ClaudeTmuxSession({ tmux: tmux as unknown as Tmux, name: "t", providerSessionId: SID, cwd: dir, env: { CLAUDE_CONFIG_DIR: dir },
    log, readyTimeoutMs: 2000, timings: { pollRunningMs: 10, pollIdleMs: 10, pasteSettleMs: 0, apiErrorQuietMs: 100, stallMs: 60_000, stallMaxMs: 120_000 } }, "end");
  sessions.push(s);
  const events: AgentEvent[] = [];
  void (async () => { for await (const ev of s.events) events.push(ev); })();
  await s.start({ reattach: true });
  await s.send({ text: "check the open issues", attachments: [] });
  const ended = () => events.find((e): e is Extract<AgentEvent, { type: "turn_end" }> => e.type === "turn_end");
  const line = (o: unknown) => appendFileSync(jsonl, `${JSON.stringify(o)}\n`);
  return { s, tmux, events, warns, ended, line };
}

describe("session", () => {
  test("the incident: the limit message at an idle prompt ends the turn as usage_limit with the reset, not a stall", async () => {
    const { tmux, ended, warns, events } = await running();
    tmux.pane = INCIDENT_PANE;
    await waitFor(() => !!ended(), 3000);
    const end = ended()!;
    expect(end).toMatchObject({ reason: "error", error: "usage_limit", limit: { kind: "5-hour", resets: "2:10am (Asia/Taipei)" } });
    expect(end.limit!.resetAt).toBeGreaterThan(Date.now());
    expect(warns.some((w) => w.msg.startsWith("usage limit reached"))).toBe(true);
    expect(warns.some((w) => w.msg.startsWith("stall"))).toBe(false);
    expect(events.filter((e) => e.type === "turn_end")).toHaveLength(1);
  }, 10_000);

  test("the agent quoting the message in its own reply does not end the turn", async () => {
    const { tmux, ended, line } = await running();
    line({ type: "assistant", uuid: "u1", message: { id: "m1", role: "assistant", model: "claude-opus-5-5",
      content: [{ type: "text", text: `The pane printed:\n${INCIDENT_LINE}` }] } });
    await Bun.sleep(100);
    tmux.pane = pane("❯ what did claude print?", "● The pane printed:", `  ${INCIDENT_LINE}`);
    await Bun.sleep(600);
    expect(ended()).toBeUndefined();
  }, 10_000);

  test("the limit message in the jsonl as a plain assistant text (no flag) does not hide the pane's: still usage_limit", async () => {
    const { tmux, ended, line } = await running();
    line({ type: "assistant", uuid: "u3", message: { id: "m3", role: "assistant", model: "claude-opus-5-5",
      content: [{ type: "text", text: `${INCIDENT_LINE}\n/upgrade to increase your usage limit.` }] } });
    tmux.pane = INCIDENT_PANE;
    await waitFor(() => !!ended(), 3000);
    expect(ended()).toMatchObject({ reason: "error", error: "usage_limit", limit: { kind: "5-hour", resets: "2:10am (Asia/Taipei)" } });
  }, 10_000);

  test("a tool in flight printing the line (e.g. tailing a log) is not a usage limit", async () => {
    const { tmux, ended, line } = await running();
    line({ type: "assistant", uuid: "u4", message: { id: "m4", role: "assistant", model: "claude-opus-5-5",
      content: [{ type: "tool_use", id: "tool1", name: "Bash", input: { command: "tail -f daemon.log" } }] } });
    await Bun.sleep(100);
    tmux.pane = pane("❯ watch the log", "● Bash(tail -f daemon.log)", `  ⎿  ${INCIDENT_LINE}`);
    await Bun.sleep(600);
    expect(ended()).toBeUndefined();
  }, 10_000);

  test("a synthetic message (model <synthetic>, no flag) ends the turn too; its reset comes from the limit line only", async () => {
    const { ended, line, events } = await running();
    line({ type: "assistant", uuid: "u5", message: { id: "m5", role: "assistant", model: "<synthetic>",
      content: [{ type: "text", text: `${INCIDENT_LINE}\n/upgrade to increase your usage limit.` }] } });
    await waitFor(() => !!ended(), 3000);
    expect(ended()).toMatchObject({ error: "usage_limit", limit: { kind: "5-hour", resets: "2:10am (Asia/Taipei)" } });
    expect(events.some((e) => e.type === "text")).toBe(false);
  }, 10_000);

  test("a synthetic API-error message in the jsonl ends the turn as usage_limit and is not posted as a reply", async () => {
    const { ended, line, events } = await running();
    line({ type: "assistant", uuid: "u2", isApiErrorMessage: true, message: { id: "m2", role: "assistant", model: "<synthetic>",
      stop_reason: "stop_sequence", content: [{ type: "text", text: "Claude AI usage limit reached|1794766200" }] } });
    await waitFor(() => !!ended(), 3000);
    expect(ended()).toMatchObject({ reason: "error", error: "usage_limit", limit: { kind: "usage", resetAt: 1794766200_000 } });
    expect(events.some((e) => e.type === "text")).toBe(false);
  }, 10_000);
});
