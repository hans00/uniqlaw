// Approval judge through Claude Code's PermissionRequest hook: real daemon + real claude-tmux (haiku, default
// permission mode) + platform-telegram against a local fake Bot API + a fake judge. Gated:
//   UNIQLAW_E2E=1 bun test test/judge-hook.e2e.test.ts
// Waits are short (a passing run takes ~10 s): a broken hook must fail fast, not hang on a dialog.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JudgeInput } from "@uniqlaw/core";
import { startFakeBotApi } from "../../platform-telegram/test/fake-api.ts";
import { JUDGE_PROVIDERS, startDaemon, type Daemon } from "../src/index.ts";

const E2E = process.env.UNIQLAW_E2E === "1";
const USER = 7;
const ID = `e2ejudge${process.pid}`;
let api: ReturnType<typeof startFakeBotApi>;
let dir: string;
let daemon: Daemon | undefined;
const calls: JudgeInput[] = [];

const texts = () => api.callsOf("sendMessage").map((c) => String(c.body.text));
const waitFor = async (cond: () => boolean, ms: number, what: string) => {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error(`timeout waiting for ${what}; sent so far: ${JSON.stringify(texts().slice(-6))}`); await Bun.sleep(250); }
};
let msgId = 1;
const dm = (text: string) => api.pushUpdate({ message: { message_id: msgId++, date: Math.floor(Date.now() / 1000), chat: { id: USER, type: "private" }, from: { id: USER, is_bot: false, first_name: "Hans", username: "hans" }, text } } as never);
const audit = () => {
  const d = join(dir, ".uniqlaw", "approvals");
  return existsSync(d) ? readdirSync(d).flatMap((f) => readFileSync(join(d, f), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>)) : [];
};
const commandOf = (i: JudgeInput) => String((i.input as { command?: string })?.command ?? "");

beforeAll(async () => {
  if (!E2E) return;
  JUDGE_PROVIDERS["e2e-fake"] = async () => ({ name: "FakeJudge", judge: async (i) => {
    calls.push(i);
    return { pSafe: commandOf(i).includes("judge-allowed") ? 0.99 : 0.3 };
  } });
  process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "uq-e2e-xdg-"));
  api = startFakeBotApi();
  dir = mkdtempSync(join(tmpdir(), "uq-e2e-judge-"));
  mkdirSync(join(dir, ".uniqlaw"), { recursive: true });
  writeFileSync(join(dir, ".uniqlaw", "settings.json"), JSON.stringify({
    instance: { id: ID },
    profiles: { main: { provider: "claude-tmux", model: "haiku", options: { permissionMode: "default" },
      permissions: { level: "moderate", approval: { mode: "ask-operator", timeoutSec: 0, judge: { provider: "e2e-fake", mode: "enforce", timeoutMs: 3000 } } } } },
    output: { toolStatus: true },
    queue: { debounceMs: 0 },
    plugins: { telegram: { token: api.token, allowedUserIds: [String(USER)], apiBase: api.apiBase, pollSeconds: 1 } },
  }));
  daemon = await startDaemon(dir);
});

afterAll(async () => {
  if (!E2E) return;
  await daemon?.stop();
  Bun.spawnSync(["tmux", "-L", `uniqlaw-${ID}`, "kill-server"]);
  api.stop();
  rmSync(dir, { recursive: true, force: true });
});

test.skipIf(!E2E)("enforce + high P(safe): the hook allows with no Telegram prompt; the judge saw structured input", async () => {
  const before = api.callsOf("sendMessage").length;
  dm("Use the Bash tool to run exactly this command: touch e2e-judge-allowed.txt — then reply with exactly: TOUCHED-1");
  await waitFor(() => existsSync(join(dir, "e2e-judge-allowed.txt")), 60_000, "file created");
  await waitFor(() => texts().some((t) => t.trim() === "TOUCHED-1"), 30_000, "TOUCHED-1");
  expect(api.callsOf("sendMessage").slice(before).some((c) => c.body.reply_markup)).toBe(false);
  const c = calls.find((i) => commandOf(i).includes("judge-allowed"))!;
  expect(c).toMatchObject({ tool: "Bash", structured: true, sessionKind: "chat" });
  expect(c.humanRequest).toContain("e2e-judge-allowed.txt");
  expect(JSON.stringify(c.input)).not.toContain("description");
  expect(audit().find((r) => r.outcome === "allow")).toMatchObject({ tool: "Bash", structured: true, pSafe: 0.99 });
}, 120_000);

test.skipIf(!E2E)("enforce + low P(safe): escalated by the hook, the dialog reaches Telegram with the score, judged once", async () => {
  const before = api.callsOf("sendMessage").length;
  const n = calls.length;
  dm("Use the Bash tool to run exactly this command: touch e2e-judge-escalated.txt — then reply with exactly: TOUCHED-2");
  await waitFor(() => api.callsOf("sendMessage").slice(before).some((c) => c.body.reply_markup), 60_000, "approval buttons");
  const ask = api.callsOf("sendMessage").slice(before).find((c) => c.body.reply_markup)!;
  expect(String(ask.body.text)).toContain("FakeJudge: 0.30 safe (needs 0.90)");
  const buttons = (ask.body.reply_markup.inline_keyboard as { text: string; callback_data: string }[][]).flat();
  const yes = buttons.find((b) => /^yes/i.test(b.text)) ?? buttons[0]!;
  api.pushUpdate({ callback_query: { id: "cbj1", from: { id: USER, is_bot: false, first_name: "Hans" }, data: yes.callback_data,
    message: { message_id: 1, date: 0, chat: { id: USER, type: "private" } } } } as never);
  await waitFor(() => existsSync(join(dir, "e2e-judge-escalated.txt")), 30_000, "file created");
  await waitFor(() => texts().some((t) => t.trim() === "TOUCHED-2"), 30_000, "TOUCHED-2");
  expect(calls.slice(n).filter((i) => commandOf(i).includes("judge-escalated") || !i.structured)).toHaveLength(1);
  const req = audit().find((r) => r.outcome === "escalate" && r.structured === true)!;
  expect(req).toMatchObject({ pSafe: 0.3, reason: "low-confidence" });
  expect(audit().find((r) => r.id === req.id && "humanDecision" in r)).toMatchObject({ humanDecision: "allow" });
}, 150_000);
