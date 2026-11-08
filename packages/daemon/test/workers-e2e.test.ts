// Workers e2e: the main Claude session (via Telegram, local fake Bot API) starts a worker — a second
// real claude-tmux session in another directory — through worker_start; then a terminal takeover
// is checked against the real tmux session. Gated: UNIQLAW_E2E=1 bun test test/workers-e2e.test.ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeBotApi } from "../../platform-telegram/test/fake-api.ts";
import { readRuntime, startDaemon, type Daemon } from "../src/index.ts";

const E2E = process.env.UNIQLAW_E2E === "1";
const USER = 7;
const ID = `e2ew${process.pid}`;
let api: ReturnType<typeof startFakeBotApi>;
let dir: string;
let repo: string;
let daemon: Daemon | undefined;

const texts = () => api.callsOf("sendMessage").map((c) => String(c.body.text));
const waitFor = async (cond: () => boolean, ms: number, what: string) => {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error(`timeout waiting for ${what}; sent so far: ${JSON.stringify(texts().slice(-6))}`); await Bun.sleep(500); }
};
const http = async (path: string, body?: unknown) => {
  const port = readRuntime(dir)!.webPort;
  const r = await fetch(`http://127.0.0.1:${port}${path}`, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return r.json() as Promise<Record<string, unknown>>;
};
let msgId = 1;
const dm = (text: string) => api.pushUpdate({ message: { message_id: msgId++, date: Math.floor(Date.now() / 1000), chat: { id: USER, type: "private" }, from: { id: USER, is_bot: false, first_name: "Hans", username: "hans" }, text } } as never);

beforeAll(async () => {
  if (!E2E) return;
  process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "uq-e2ew-xdg-"));
  api = startFakeBotApi();
  dir = realpathSync(mkdtempSync(join(tmpdir(), "uq-e2ew-")));
  repo = realpathSync(mkdtempSync(join(tmpdir(), "uq-e2ew-repo-")));
  mkdirSync(join(dir, ".uniqlaw"), { recursive: true });
  writeFileSync(join(dir, ".uniqlaw", "settings.json"), JSON.stringify({
    instance: { id: ID },
    profiles: {
      main: { provider: "claude-tmux", model: "haiku", permissions: { level: "moderate", approval: { mode: "auto-deny" } } },
      coder: { provider: "claude-tmux", model: "haiku", permissions: { level: "unrestricted" } },
      sdk: { provider: "claude-sdk", model: "haiku", permissions: { level: "unrestricted", approval: { mode: "auto-allow" } } },
    },
    workers: { roots: [repo], profiles: ["coder", "sdk"] },
    queue: { debounceMs: 0 },
    plugins: { telegram: { token: api.token, allowedUserIds: [String(USER)], apiBase: api.apiBase, pollSeconds: 1 } },
  }));
  daemon = await startDaemon(dir);
});

afterAll(async () => {
  if (!E2E) return;
  if (process.env.UNIQLAW_E2E_VERBOSE) console.log("E2E SENT:", JSON.stringify(texts(), null, 1));
  await daemon?.stop();
  Bun.spawnSync(["tmux", "-L", `uniqlaw-${ID}`, "kill-server"]);
  api.stop();
  rmSync(dir, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

test.skipIf(!E2E)("main session starts a worker in another directory and it does the work there", async () => {
  dm(`Call the uniqlaw \`worker_start\` tool with name "w1", profile "coder", cwd "${repo}", wait false, and task `
    + `"Use the Write tool to create a file named hello.txt in your working directory containing exactly WORKER-OK, then reply DONE". `
    + "After the tool returns, reply with exactly: STARTED");
  await waitFor(() => texts().some((t) => t.trim() === "STARTED"), 150_000, "STARTED");
  // The worker's permission prompt reaches the human at the root of the chain (this DM): approve it.
  await waitFor(() => api.callsOf("sendMessage").some((c) => c.body.reply_markup && String(c.body.text).includes("worker:w1")), 180_000, "worker approval buttons");
  const ask = api.callsOf("sendMessage").find((c) => c.body.reply_markup && String(c.body.text).includes("worker:w1"))!;
  const buttons = (ask.body.reply_markup.inline_keyboard as { text: string; callback_data: string }[][]).flat();
  const yes = buttons.find((b) => /^yes/i.test(b.text)) ?? buttons[0]!;
  api.pushUpdate({ callback_query: { id: "cbw", from: { id: USER, is_bot: false, first_name: "Hans" }, data: yes.callback_data,
    message: { message_id: 1, date: 0, chat: { id: USER, type: "private" } } } } as never);
  await waitFor(() => existsSync(join(repo, "hello.txt")), 180_000, "hello.txt in the worker's directory");
  expect(readFileSync(join(repo, "hello.txt"), "utf8").trim()).toBe("WORKER-OK");
  expect(existsSync(join(dir, "hello.txt"))).toBe(false);
  const w = await http("/api/workers");
  expect((w.workers as { name: string; cwd: string; owner: string; provider: string }[])[0]).toMatchObject({ name: "worker:w1", cwd: repo, owner: "telegram:7", provider: "claude-tmux" });
}, 360_000);

test.skipIf(!E2E)("terminal takeover points at the worker's live tmux session; owner is refused meanwhile", async () => {
  const t = await http("/api/takeover", { key: "w1" });
  expect(t).toMatchObject({ ok: true, key: "worker:w1", live: true, cwd: repo });
  const argv = t.argv as string[];
  expect(argv.slice(0, 3)).toEqual(["tmux", "-L", `uniqlaw-${ID}`]);
  // same target, but has-session instead of an interactive attach
  const has = Bun.spawnSync([...argv.slice(0, 3), "has-session", ...argv.slice(4)]);
  expect(has.exitCode).toBe(0);
  const pane = Bun.spawnSync([...argv.slice(0, 3), "display-message", "-p", "-t", argv.at(-1)!, "#{pane_current_path}"]);
  expect(realpathSync(pane.stdout.toString().trim())).toBe(repo);
  expect(((await http("/api/workers")).workers as { heldBy?: string }[])[0]!.heldBy).toBe("terminal");
  expect(await http("/api/trigger", { target: "worker:w1", prompt: "hi" })).toMatchObject({ ok: false, error: expect.stringMatching(/driven by a human/) });
  expect(await http("/api/release", { key: "worker:w1" })).toEqual({ ok: true, released: true });
}, 60_000);

test.skipIf(!E2E)("claude-sdk handoff: what the human does in `claude --resume` is there when the daemon resumes", async () => {
  const sub = join(repo, "sdk");
  mkdirSync(sub);
  const st = await http("/api/workers", { action: "start", name: "w2", profile: "sdk", cwd: sub, task: "Reply with exactly: READY" });
  expect(st).toMatchObject({ ok: true, worker: "worker:w2", created: true });
  const end = Date.now() + 120_000;
  let t: Record<string, unknown> = {};
  // takeover needs the first turn to have produced a Claude session id and the worker to be idle
  while (Date.now() < end) {
    t = await http("/api/takeover", { key: "w2" });
    if (t.ok) break;
    await Bun.sleep(1000);
  }
  expect(t).toMatchObject({ ok: true, live: false, cwd: sub });
  const argv = t.argv as string[];
  expect(argv.slice(0, 2)).toEqual(["claude", "--resume"]);
  // the "human": one non-interactive turn in the same conversation
  const human = Bun.spawnSync([...argv, "-p", "--model", "haiku", "Remember this code word for later: HANDOFF-7Q. Reply with exactly: NOTED"], { cwd: sub, env: { ...process.env } });
  expect(human.stdout.toString()).toContain("NOTED");
  expect(await http("/api/release", { key: "worker:w2" })).toEqual({ ok: true, released: true });
  dm("Call the uniqlaw `agent_ask` tool with to \"worker:w2\", wait true, and message \"What code word were you asked to remember? Reply with just the word.\" Then reply with exactly its answer.");
  await waitFor(() => texts().some((x) => x.includes("HANDOFF-7Q")), 240_000, "code word from the resumed worker");
}, 420_000);
