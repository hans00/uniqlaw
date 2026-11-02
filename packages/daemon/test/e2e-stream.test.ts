// Real claude-sdk token deltas → one Telegram message edited in place. Gated: UNIQLAW_E2E=1
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeBotApi } from "../../platform-telegram/test/fake-api.ts";
import { startDaemon, type Daemon } from "../src/index.ts";

const E2E = process.env.UNIQLAW_E2E === "1";
let api: ReturnType<typeof startFakeBotApi>;
let dir: string;
let daemon: Daemon | undefined;

beforeAll(async () => {
  if (!E2E) return;
  process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "uq-e2es-xdg-"));
  api = startFakeBotApi();
  dir = mkdtempSync(join(tmpdir(), "uq-e2es-"));
  mkdirSync(join(dir, ".uniqlaw"), { recursive: true });
  writeFileSync(join(dir, ".uniqlaw", "settings.json"), JSON.stringify({
    profiles: { main: { provider: "claude-sdk", model: "haiku", permissions: { approval: { mode: "auto-deny" } } } },
    output: { toolStatus: false, stream: "replace" }, queue: { debounceMs: 0 },
    plugins: { telegram: { token: api.token, allowedUserIds: ["7"], apiBase: api.apiBase, pollSeconds: 1 } },
  }));
  daemon = await startDaemon(dir);
});
afterAll(async () => { if (!E2E) return; await daemon?.stop(); api.stop(); rmSync(dir, { recursive: true, force: true }); });

test.skipIf(!E2E)("long reply streams into one edited message", async () => {
  api.pushUpdate({ message: { message_id: 1, date: Math.floor(Date.now() / 1000), chat: { id: 7, type: "private" }, from: { id: 7, is_bot: false, first_name: "Hans" },
    text: "Write about 250 words on why tide pools are interesting. Plain prose, no headings, and end with the word FIN." } } as never);
  const end = Date.now() + 150_000;
  const finalSeen = () => api.callsOf("editMessageText").some((c) => String(c.body.text).trim().endsWith("FIN") || String(c.body.text).trim().endsWith("FIN."))
    || api.callsOf("sendMessage").some((c) => /FIN\.?$/.test(String(c.body.text).trim()));
  while (!finalSeen()) { if (Date.now() > end) throw new Error("no final"); await Bun.sleep(300); }
  const sends = api.callsOf("sendMessage").filter((c) => c.body.chat_id == 7);
  const edits = api.callsOf("editMessageText");
  console.log(`sends=${sends.length} edits=${edits.length}`);
  // Streaming proof: the first (and only) send was a partial with the cursor; edits finished it.
  // (Fast models may finish within one throttle window, so the number of intermediate edits varies.)
  expect(sends.length).toBe(1);
  expect(String(sends[0]!.body.text)).toContain("▍");
  expect(edits.length).toBeGreaterThanOrEqual(1);
  const last = String(edits.at(-1)!.body.text);
  expect(last).not.toContain("▍");
  expect(last.length).toBeGreaterThan(String(sends[0]!.body.text).length);
}, 200_000);
