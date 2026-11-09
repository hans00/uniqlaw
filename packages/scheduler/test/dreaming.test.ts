import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, StateStore, silentLogger, type SchedulerApi } from "@uniqlaw/core";
import { DreamingScheduler, dreamingConfigSchema } from "../src/index.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function setup(cfg: Record<string, unknown> = {}, now = new Date("2026-11-08T19:00:00Z")) {
  const dir = mkdtempSync(join(tmpdir(), "uq-dreamsch-"));
  dirs.push(dir);
  const store = new StateStore(join(dir, "state.db"));
  const memory = new MemoryStore(dir, store, { timezone: "Asia/Taipei", now: () => now });
  const kv = new Map<string, string>();
  const calls: { channelKey: string; job: string; profile?: string; fresh?: boolean }[] = [];
  const notes: string[] = [];
  const api: SchedulerApi = {
    fire: async () => {}, isBusy: () => false, kvGet: (k) => kv.get(k), kvSet: (k, v) => void kv.set(k, v), memory,
    complete: async (o) => { calls.push(o); return o.job.endsWith("diary") ? { ok: true, text: "Dreamt of tidy shelves." } : { ok: true, text: "{\"operations\":[]}" }; },
    noteToOpenChats: (_l, t) => { notes.push(t); return 1; },
  };
  const sch = new DreamingScheduler(dreamingConfigSchema.parse(cfg), "Asia/Taipei", silentLogger, () => now);
  sch.start(api);
  return { dir, memory, sch, calls, notes, kv, setNow: (d: Date) => { now = d; } };
}

test("defaults: 03:00 nightly, diary on, OpenClaw-like gates with UniQlaw's lower recall thresholds", () => {
  const c = dreamingConfigSchema.parse({});
  expect(c).toMatchObject({ schedule: "0 3 * * *", diary: true, minScore: 0.45, minRecallCount: 2, minUniqueQueries: 1, recurrenceDays: 2, minImportance: 8 });
  expect(() => dreamingConfigSchema.parse({ schedule: "every night" })).toThrow();
});

test("fires once at 03:00 in the configured timezone; runs both turns in the fresh dream session; tells open chats", async () => {
  const t = setup({ profile: "cheap" });
  t.memory.write("Hans' cat is called Mochi", { origin: "chat", source: "tg:1", importance: 9 });
  t.sch.stop();
  expect(await t.sch.tick(new Date("2026-11-08T18:59:00Z"))).toBe(false); // 02:59 Taipei
  expect(await t.sch.tick(new Date("2026-11-08T19:00:00Z"))).toBe(true);  // 03:00 Taipei
  expect(await t.sch.tick(new Date("2026-11-08T19:00:30Z"))).toBe(false); // same minute
  expect(t.calls.map((c) => [c.channelKey, c.job, c.profile, c.fresh])).toEqual([
    ["dream", "dreaming:consolidate", "cheap", true],
    ["dream", "dreaming:diary", "cheap", true],
  ]);
  expect(readFileSync(join(t.dir, "memory", "MEMORY.md"), "utf8")).toContain("Hans' cat is called Mochi");
  expect(readFileSync(join(t.dir, "memory", "DREAMS.md"), "utf8")).toContain("Dreamt of tidy shelves.");
  expect(t.notes).toHaveLength(1);
  expect(JSON.parse(t.kv.get("lastReport")!).deep.added).toBe(1);
});

test("diary can be turned off; a dry run never calls the model", async () => {
  const t = setup({ diary: false });
  t.memory.write("Prefers metric units", { origin: "chat", source: "tg:1", importance: 9 });
  const dry = await t.sch.runNow({ dryRun: true });
  expect(dry.candidates).toHaveLength(1);
  expect(t.calls).toHaveLength(0);
  await t.sch.runNow();
  expect(t.calls.map((c) => c.job)).toEqual(["dreaming:consolidate"]);
  t.sch.stop();
});
