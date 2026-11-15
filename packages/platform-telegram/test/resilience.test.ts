// An unresponsive or rejecting Telegram (docs §11.4): start() gives up when told to, a bad token is a permanent
// error, API trouble shows in health(), and stop() never hangs on the offset confirmation.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlatformStartError, silentLogger } from "@uniqlaw/core";
import { TelegramAdapter } from "../src/index.ts";
import { startFakeBotApi } from "./fake-api.ts";

const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

/** A Bot API that answers getMe with `getMe` and lets every other call hang (or fail) on demand. */
function badApi(o: { getMe: "hang" | 401 | "ok"; others?: "hang" | 502 }) {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    const method = new URL(req.url).pathname.split("/").pop();
    const mode = method === "getMe" ? o.getMe : o.others;
    if (mode === "hang") return new Promise<Response>(() => {});
    if (mode === 401) return Response.json({ ok: false, error_code: 401, description: "Unauthorized" }, { status: 401 });
    if (mode === 502) return Response.json({ ok: false, description: "Bad Gateway" }, { status: 502 });
    if (method === "getMe") return Response.json({ ok: true, result: { id: 1, is_bot: true, username: "b" } });
    return Response.json({ ok: true, result: method === "getUpdates" ? [] : { message_id: 1 } });
  } });
  cleanups.push(() => { void server.stop(true); }); // (awaiting it would wait for the hung requests)
  return `http://127.0.0.1:${server.port}`;
}

function adapter(apiBase: string, pollSeconds = 0) {
  const dir = mkdtempSync(join(tmpdir(), "uq-tg-res-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const a = new TelegramAdapter({ token: "TEST:TOKEN", apiBase, allowedUserIds: ["1"], allowedGroupIds: [], operatorUserIds: ["1"],
    pollSeconds, attachmentsDir: dir, log: silentLogger });
  cleanups.push(() => a.stop());
  return a;
}

test("start() on a hanging getMe returns as soon as the supervisor aborts it", async () => {
  const a = adapter(badApi({ getMe: "hang" }));
  const ac = new AbortController();
  const t0 = Date.now();
  setTimeout(() => ac.abort(), 100);
  await expect(a.start({ message: () => {} }, ac.signal)).rejects.toThrow();
  expect(Date.now() - t0).toBeLessThan(2000);
  expect(a.health().consecutiveFailures).toBe(1);
  expect(a.health().lastError).toContain("getMe");
});

test("a rejected token is a permanent start error", async () => {
  const a = adapter(badApi({ getMe: 401 }));
  const err = await a.start({ message: () => {} }).catch((e) => e);
  expect(err).toBeInstanceOf(PlatformStartError);
  expect((err as PlatformStartError).permanent).toBe(true);
});

test("health(): polls and sends recorded; failing calls counted until one works", async () => {
  const api = startFakeBotApi();
  cleanups.push(() => api.stop());
  const a = adapter(api.apiBase);
  await a.start({ message: () => {} });
  await new Promise((r) => setTimeout(r, 150));
  expect(a.health().lastPollAt).toBeGreaterThan(0);
  await a.send({ platform: "telegram", chatId: "1" }, "hi");
  expect(a.health().lastSendAt).toBeGreaterThan(0);
  expect(a.health().consecutiveFailures).toBe(0);

  const bad = adapter(badApi({ getMe: "ok", others: 502 }));
  await bad.send({ platform: "telegram", chatId: "1" }, "x").catch(() => {});
  expect(bad.health().consecutiveFailures).toBeGreaterThanOrEqual(1);
  expect(bad.health().lastError).toContain("502");
});

test("stop() does not hang on an unresponsive Telegram", async () => {
  const a = adapter(badApi({ getMe: "ok", others: "hang" }));
  await a.start({ message: () => {} });
  (a as unknown as { offset: number }).offset = 5; // something to confirm on stop
  const t0 = Date.now();
  await a.stop();
  expect(Date.now() - t0).toBeLessThan(7000);
}, 10_000);
