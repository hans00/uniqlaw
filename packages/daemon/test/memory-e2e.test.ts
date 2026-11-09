// Memory e2e: a real Claude session (via Telegram, local fake Bot API) saves a fact with memory_write
// on its own, and after /new finds it again with memory_search. Also checks that Claude Code's own
// auto-memory stays off. Gated: UNIQLAW_E2E=1 bun test test/memory-e2e.test.ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "@uniqlaw/core";
import { startFakeBotApi } from "../../platform-telegram/test/fake-api.ts";
import { startDaemon, type Daemon } from "../src/index.ts";

const E2E = process.env.UNIQLAW_E2E === "1";
const PROVIDER = process.env.UNIQLAW_E2E_PROVIDER ?? "claude-tmux";
const USER = 8;
const ID = `e2em${process.pid}`;
let api: ReturnType<typeof startFakeBotApi>;
let dir: string;
let daemon: Daemon | undefined;

const texts = () => api.callsOf("sendMessage").map((c) => String(c.body.text));
const waitFor = async (cond: () => boolean, ms: number, what: string) => {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error(`timeout waiting for ${what}; sent so far: ${JSON.stringify(texts().slice(-6))}`); await Bun.sleep(500); }
};
let msgId = 1;
const dm = (text: string) => api.pushUpdate({ message: { message_id: msgId++, date: Math.floor(Date.now() / 1000), chat: { id: USER, type: "private" }, from: { id: USER, is_bot: false, first_name: "Hans", username: "hans" }, text } } as never);
const notes = () => existsSync(join(dir, "memory")) ? readdirSync(join(dir, "memory")).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).map((f) => readFileSync(join(dir, "memory", f), "utf8")).join("\n") : "";

beforeAll(async () => {
  if (!E2E) return;
  process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "uq-e2em-xdg-"));
  api = startFakeBotApi();
  dir = realpathSync(mkdtempSync(join(tmpdir(), "uq-e2em-")));
  mkdirSync(join(dir, ".uniqlaw"), { recursive: true });
  writeFileSync(join(dir, ".uniqlaw", "settings.json"), JSON.stringify({
    instance: { id: ID },
    profiles: { main: { provider: PROVIDER, model: "haiku", permissions: { level: "moderate", approval: { mode: "auto-deny" } } } },
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
});

test.skipIf(!E2E)("agent saves a fact with memory_write without being told which tool to use", async () => {
  dm("By the way, my cat is called Mochi and she turns 3 in December. Keep that in mind.");
  await waitFor(() => /Mochi/i.test(notes()), 180_000, "a daily note mentioning Mochi");
  expect(notes()).toMatch(/<!-- m:[a-z0-9]+ -->/);
}, 200_000);

test.skipIf(!E2E)("after /new it finds the fact again with memory_search", async () => {
  const before = texts().length;
  dm("/new");
  await waitFor(() => texts().slice(before).some((t) => t.includes("new session")), 30_000, "/new ack");
  const mark = texts().length;
  dm("What's my cat's name, and when is her birthday?");
  await waitFor(() => texts().slice(mark).some((t) => /Mochi/i.test(t)), 180_000, "an answer naming Mochi");
  const store = new StateStore(join(dir, ".uniqlaw", "state.db"));
  const recalls = store.db.query("SELECT count, path FROM memory_recall").all() as { count: number; path: string }[];
  store.db.close();
  expect(recalls.length).toBeGreaterThan(0); // the answer came through memory_search, not luck
}, 220_000);

test.skipIf(!E2E || !PROVIDER.startsWith("claude"))("Claude Code's own auto-memory stays off", () => {
  const projDir = join(homedir(), ".claude", "projects", dir.replace(/[^a-zA-Z0-9]/g, "-"), "memory");
  expect(existsSync(projDir)).toBe(false);
});
