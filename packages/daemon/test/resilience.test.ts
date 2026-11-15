// Startup / shutdown must not depend on a chat platform being reachable (docs §11.4).
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRuntime, startDaemon } from "../src/index.ts";
import { instances } from "./fixtures/fake-platform.ts";
import { hanging } from "./fixtures/hanging-platform.ts";

const FIX = join(import.meta.dir, "fixtures");
const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });
process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "uq-xdg-"));
const until = async (c: () => boolean, ms = 3000) => { const e = Date.now() + ms; while (!c()) { if (Date.now() > e) throw new Error("timeout"); await Bun.sleep(10); } };

test("a platform that hangs: the daemon still comes up at once, the other platform works, status shows it degraded, stop is bounded", async () => {
  const dir = mkdtempSync(join(tmpdir(), "uq-res-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, ".uniqlaw"), { recursive: true });
  writeFileSync(join(dir, ".uniqlaw", "settings.json"), JSON.stringify({
    profiles: { main: { provider: "fake" } }, queue: { debounceMs: 0 },
    plugins: { fake: { module: join(FIX, "fake-provider.ts") }, tg: { module: join(FIX, "fake-platform.ts"), token: "t-res-1" },
      hang: { module: join(FIX, "hanging-platform.ts"), token: "t-res-2" } },
  }));
  const t0 = Date.now();
  const d = await startDaemon(dir, { channels: { startTimeoutMs: 100, retryMinMs: 50, retryMaxMs: 200, stopTimeoutMs: 100 } });
  expect(Date.now() - t0).toBeLessThan(5000);
  expect(readRuntime(dir)!.pid).toBe(process.pid);

  // The working platform routes messages; the hanging one is retried in the background.
  await until(() => d.channels.health().find((c) => c.name === "tg")!.state === "connected");
  const tg = instances.at(-1)!;
  tg.sink!.message({ platform: "tg", channelKey: "tg:100", replyTarget: { platform: "tg", chatId: "100" }, ref: { platform: "tg", chatId: "100", messageId: "1" },
    sender: { id: "7", name: "Hans" }, trusted: true, multiparty: false, text: "hello", attachments: [], receivedAt: Date.now() });
  await until(() => tg.sent.some((m) => m.text === "echo: Message: hello"));
  await until(() => hanging.starts >= 2);

  const status = await (await fetch(`http://127.0.0.1:${d.webPort}/api/status`)).json() as { channels: { name: string; state: string; lastError?: string; nextRetryAt?: number }[] };
  const hang = status.channels.find((c) => c.name === "hang")!;
  expect(hang.state).toBe("degraded");
  expect(hang.lastError).toContain("timed out");
  expect(status.channels.find((c) => c.name === "tg")!.state).toBe("connected");
  const health = await (await fetch(`http://127.0.0.1:${d.webPort}/api/health?refresh=1`)).json() as { ok: boolean; channels: unknown[]; sessions: { name: string }[] };
  expect(health.ok).toBe(true);
  expect(health.channels).toHaveLength(2);
  expect(health.sessions.map((s) => s.name)).toContain("tg:100");

  const s0 = Date.now();
  await d.stop(); // the hanging platform's stop() never returns: bounded
  expect(Date.now() - s0).toBeLessThan(15_000);
}, 30_000);
