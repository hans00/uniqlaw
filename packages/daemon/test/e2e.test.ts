// Full-stack e2e: real daemon + real platform-telegram (against a local fake Bot API)
// + real claude-tmux (haiku). Gated: UNIQLAW_E2E=1 bun test test/e2e.test.ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeBotApi } from "../../platform-telegram/test/fake-api.ts";
import { readRuntime, startDaemon, type Daemon } from "../src/index.ts";

const E2E = process.env.UNIQLAW_E2E === "1";
const USER = 7;
let api: ReturnType<typeof startFakeBotApi>;
let dir: string;
let daemon: Daemon | undefined;

const texts = () => api.callsOf("sendMessage").map((c) => String(c.body.text));
const waitFor = async (cond: () => boolean, ms: number, what: string) => {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error(`timeout waiting for ${what}; sent so far: ${JSON.stringify(texts().slice(-6))}`); await Bun.sleep(250); }
};
let msgId = 1;
const dm = (text: string) => api.pushUpdate({ message: { message_id: msgId++, date: Math.floor(Date.now() / 1000), chat: { id: USER, type: "private" }, from: { id: USER, is_bot: false, first_name: "Hans", username: "hans" }, text } } as never);

beforeAll(async () => {
  if (!E2E) return;
  process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "uq-e2e-xdg-"));
  api = startFakeBotApi();
  dir = mkdtempSync(join(tmpdir(), "uq-e2e-"));
  mkdirSync(join(dir, ".uniqlaw"), { recursive: true });
  writeFileSync(join(dir, ".uniqlaw", "settings.json"), JSON.stringify({
    instance: { id: `e2e${process.pid}` },
    profiles: { main: { provider: "claude-tmux", model: "haiku", permissions: { level: "moderate", approval: { mode: "ask-operator", timeoutSec: 120 } } } },
    output: { toolStatus: true },
    queue: { debounceMs: 0 },
    plugins: { telegram: { token: api.token, allowedUserIds: [String(USER)], apiBase: api.apiBase, pollSeconds: 1 } },
  }));
  daemon = await startDaemon(dir);
});

afterAll(async () => {
  if (!E2E) return;
  // Kill tmux for this instance (detach() on stop keeps it alive by design).
  const id = `e2e${process.pid}`;
  if (process.env.UNIQLAW_E2E_VERBOSE) console.log("E2E SENT:", JSON.stringify(texts(), null, 1));
  await daemon?.stop();
  Bun.spawnSync(["tmux", "-L", `uniqlaw-${id}`, "kill-server"]);
  api.stop();
  rmSync(dir, { recursive: true, force: true });
});

test.skipIf(!E2E)("DM round trip through a real Claude session", async () => {
  dm("Reply with exactly: PONG");
  await waitFor(() => texts().some((t) => t.trim() === "PONG"), 120_000, "PONG");
  expect(api.callsOf("sendChatAction").length).toBeGreaterThan(0);
}, 150_000);

test.skipIf(!E2E)("agent uses the UniQlaw MCP gateway (notify tool)", async () => {
  dm("Call the uniqlaw `notify` tool with target \"telegram:7\" and text \"NOTIFIED-42\". After it succeeds, reply with exactly: DONE");
  await waitFor(() => texts().includes("NOTIFIED-42"), 150_000, "NOTIFIED-42");
  await waitFor(() => texts().some((t) => t.trim() === "DONE"), 60_000, "DONE");
}, 240_000);

test.skipIf(!E2E)("permission dialog → Telegram buttons → approve → tool runs", async () => {
  const before = api.callsOf("sendMessage").length;
  dm("Use the Bash tool to run exactly this command: touch e2e-approved.txt — then reply with exactly: TOUCHED");
  await waitFor(() => api.callsOf("sendMessage").slice(before).some((c) => c.body.reply_markup), 120_000, "approval buttons");
  const ask = api.callsOf("sendMessage").slice(before).find((c) => c.body.reply_markup)!;
  const buttons = (ask.body.reply_markup.inline_keyboard as { text: string; callback_data: string }[][]).flat();
  const yes = buttons.find((b) => /^yes/i.test(b.text)) ?? buttons[0]!;
  api.pushUpdate({ callback_query: { id: "cb1", from: { id: USER, is_bot: false, first_name: "Hans" }, data: yes.callback_data,
    message: { message_id: 1, date: 0, chat: { id: USER, type: "private" } } } } as never);
  await waitFor(() => existsSync(join(dir, "e2e-approved.txt")), 90_000, "file created");
  await waitFor(() => texts().some((t) => t.trim() === "TOUCHED"), 60_000, "TOUCHED");
}, 300_000);

test.skipIf(!E2E)("permission deny → file not created → agent continues via deny-recovery turn", async () => {
  const before = api.callsOf("sendMessage").length;
  dm("Use the Bash tool to run exactly this command: touch e2e-denied.txt — if it is denied, reply with exactly: GAVE-UP");
  await waitFor(() => api.callsOf("sendMessage").slice(before).some((c) => c.body.reply_markup), 120_000, "approval buttons");
  const ask = api.callsOf("sendMessage").slice(before).find((c) => c.body.reply_markup)!;
  const buttons = (ask.body.reply_markup.inline_keyboard as { text: string; callback_data: string }[][]).flat();
  const no = buttons.find((b) => /^(no|deny)/i.test(b.text))!;
  expect(no).toBeDefined();
  api.pushUpdate({ callback_query: { id: "cb2", from: { id: USER, is_bot: false, first_name: "Hans" }, data: no.callback_data,
    message: { message_id: 2, date: 0, chat: { id: USER, type: "private" } } } } as never);
  await waitFor(() => texts().slice(before).some((t) => t.includes("GAVE-UP")), 150_000, "GAVE-UP after deny");
  expect(existsSync(join(dir, "e2e-denied.txt"))).toBe(false);
}, 300_000);

test.skipIf(!E2E)("daemon restart reattaches to the live tmux session", async () => {
  const sid = readRuntime(dir)!.instanceId;
  await daemon!.stop();
  const has = Bun.spawnSync(["tmux", "-L", `uniqlaw-${sid}`, "ls"]).stdout.toString();
  expect(has).toMatch(/uq-/); // tmux survived the daemon
  daemon = await startDaemon(dir);
  const before = texts().length;
  dm("What exact word did I ask you to reply with in my very first message? Reply with just that word.");
  await waitFor(() => texts().slice(before).some((t) => t.trim().replace(/[.`*]/g, "") === "PONG"), 120_000, "PONG recall");
}, 200_000);
