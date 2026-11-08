import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { silentLogger, type SchedulerApi } from "@uniqlaw/core";
import { CronScheduler, HeartbeatScheduler, cronMatches, heartbeatConfigSchema, inExcludeWindow, isValidCron, loadJobs, occurrencesBetween, parseJob, saveJob } from "../src/index.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "uq-sched-")); dirs.push(d); return d; };

function fakeApi(busy = false) {
  const kv = new Map<string, string>();
  const fired: Parameters<SchedulerApi["fire"]>[0][] = [];
  const api: SchedulerApi = { fire: async (o) => { fired.push(o); }, isBusy: () => busy, kvGet: (k) => kv.get(k), kvSet: (k, v) => void kv.set(k, v) };
  return { api, fired, kv };
}

describe("cron expressions", () => {
  const at = (iso: string) => new Date(iso);
  test("fields, steps, ranges, lists, Sunday=7", () => {
    expect(cronMatches("*/15 * * * *", at("2026-11-02T10:30:00Z"))).toBe(true);
    expect(cronMatches("*/15 * * * *", at("2026-11-02T10:31:00Z"))).toBe(false);
    expect(cronMatches("0 9-17/4 * * 1-5", at("2026-11-02T13:00:00Z"))).toBe(true); // Monday 13:00
    expect(cronMatches("0 9 * * 0", at("2026-11-01T09:00:00Z"))).toBe(true);
    expect(cronMatches("0 9 * * 7", at("2026-11-01T09:00:00Z"))).toBe(true);
    expect(cronMatches("0 9 1,15 * *", at("2026-11-15T09:00:00Z"))).toBe(true);
  });
  test("timezones: UTC offset and IANA", () => {
    expect(cronMatches("0 9 * * *", at("2026-11-02T01:00:00Z"), "UTC+8")).toBe(true);
    expect(cronMatches("0 9 * * *", at("2026-11-02T01:00:00Z"), "Asia/Taipei")).toBe(true);
    expect(cronMatches("0 9 * * *", at("2026-11-02T01:00:00Z"), "+08:00")).toBe(true);
  });
  test("validation + occurrences", () => {
    expect(isValidCron("0 9 * * *")).toBe(true);
    expect(isValidCron("0 9 * *")).toBe(false);
    expect(isValidCron("rm -rf / * * *")).toBe(false);
    expect(occurrencesBetween("0 * * * *", at("2026-11-02T00:30:00Z"), at("2026-11-02T03:00:00Z")).map((d) => d.toISOString()))
      .toEqual(["2026-11-02T01:00:00.000Z", "2026-11-02T02:00:00.000Z", "2026-11-02T03:00:00.000Z"]);
  });
});

describe("job files (v2 format)", () => {
  test("parse with comments, quotes and defaults", () => {
    const j = parseJob("/x/daily.md", '---\nschedule: "0 9 * * *"   # every day\nrecurring: false\nreplyTo: telegram:123\n---\nDo the thing.\n');
    expect(j).toMatchObject({ name: "daily", schedule: "0 9 * * *", recurring: false, target: "cron:daily", replyTo: "telegram:123", body: "Do the thing." });
  });
  test("save → load round trip; bad files reported", () => {
    const d = tmp();
    saveJob(d, "a", { schedule: "*/5 * * * *", recurring: true, target: "discord:1", replyTo: "telegram:2", timezone: "+08:00", body: "hi" });
    writeFileSync(join(d, "bad.md"), "---\nschedule: nope\n---\nx");
    const errs: string[] = [];
    expect(loadJobs(d, (f) => errs.push(f)).map((j) => [j.name, j.target, j.timezone])).toEqual([["a", "discord:1", "+08:00"]]);
    expect(errs).toEqual(["bad.md"]);
    expect(() => saveJob(d, "../evil", { schedule: "* * * * *", recurring: true, target: "global", body: "" })).toThrow();
  });
});

describe("job sessions, profile and model", () => {
  test("default target is the job's own session; profile/model round-trip; cron_save target \"own\"", async () => {
    const d = tmp();
    saveJob(d, "digest", { schedule: "0 8 * * *", recurring: true, target: "cron:digest", replyTo: "none", profile: "cheap", model: "small", body: "go" });
    const text = (await Bun.file(join(d, "digest.md")).text());
    expect(text).not.toContain("target:");
    expect(loadJobs(d)[0]).toMatchObject({ target: "cron:digest", replyTo: "none", profile: "cheap", model: "small" });
    const s = new CronScheduler(d, { dir: d, catchUpHours: 0 }, "UTC", silentLogger);
    const save = s.tools().find((t) => t.name === "cron_save")!;
    await save.handler({ name: "mine", schedule: "* * * * *", prompt: "a" }, "telegram:100");
    await save.handler({ name: "solo", schedule: "* * * * *", prompt: "b", target: "own", model: "small" }, "telegram:100");
    const { api, fired } = fakeApi();
    (s as unknown as { api: SchedulerApi }).api = api;
    await s.tick(new Date("2026-11-02T08:00:00Z"));
    expect(Object.fromEntries(fired.map((f) => [f.job, [f.channelKey, f.profile, f.model, f.deliverTo]]))).toEqual({
      digest: ["cron:digest", "cheap", "small", "none"], mine: ["telegram:100", undefined, undefined, undefined], solo: ["cron:solo", undefined, "small", undefined] });
  });
});

describe("CronScheduler", () => {
  test("fires matching jobs once per minute; one-shots are removed", async () => {
    const d = tmp();
    saveJob(d, "every", { schedule: "* * * * *", recurring: true, target: "global", replyTo: "telegram:5", body: "tick" });
    saveJob(d, "once", { schedule: "* * * * *", recurring: false, target: "discord:9", body: "once" });
    const s = new CronScheduler(d, { dir: d, catchUpHours: 0 }, "UTC", silentLogger);
    const { api, fired } = fakeApi();
    (s as unknown as { api: SchedulerApi }).api = api;
    const at = new Date("2026-11-02T10:00:00Z");
    expect((await s.tick(at)).sort()).toEqual(["every", "once"]);
    expect(await s.tick(new Date("2026-11-02T10:00:30Z"))).toEqual([]); // same minute
    expect(existsSync(join(d, "once.md"))).toBe(false);
    const every = fired.find((f) => f.job === "every")!;
    expect(every).toMatchObject({ channelKey: "global", deliverTo: "telegram:5", text: "tick" });
    expect(every.sourceLine).toContain("scheduled · cron · every (* * * * *)");
  });
  test("catch-up fires one run for missed occurrences inside the window", async () => {
    const d = tmp();
    saveJob(d, "hourly", { schedule: "0 * * * *", recurring: true, target: "global", body: "h" });
    const s = new CronScheduler(d, { dir: d, catchUpHours: 6 }, "UTC", silentLogger);
    const { api, fired, kv } = fakeApi();
    (s as unknown as { api: SchedulerApi }).api = api;
    kv.set("cron:hourly:minute", String(Math.floor(new Date("2026-11-02T07:00:00Z").getTime() / 60_000)));
    expect(await s.catchUp(new Date("2026-11-02T10:20:00Z"))).toEqual(["hourly"]);
    expect(fired[0]!.sourceLine).toContain("missed 3×");
    expect(await s.catchUp(new Date("2026-11-02T10:25:00Z"))).toEqual([]);
  });
});

describe("HeartbeatScheduler", () => {
  const cfg = (o = {}) => ({ interval: 60, prompt: "", templateFile: "prompts/heartbeat/HEARTBEAT.md", target: "global", excludeWindows: [], ...o });
  test("interval, quiet hours (wrapping midnight), busy deferral, template + custom prompt", async () => {
    const d = tmp();
    mkdirSync(join(d, "prompts", "heartbeat"), { recursive: true });
    writeFileSync(join(d, "prompts", "heartbeat", "HEARTBEAT.md"), "TEMPLATE");
    const h = new HeartbeatScheduler(cfg({ prompt: "also check mail", excludeWindows: [{ start: "23:00", end: "07:00" }] }), d, "UTC+8", silentLogger);
    const { api, fired, kv } = fakeApi();
    (h as unknown as { api: SchedulerApi }).api = api;
    kv.set("heartbeat:lastFiredAt", String(new Date("2026-11-02T00:00:00Z").getTime()));
    expect(await h.tick(new Date("2026-11-02T00:30:00Z"))).toBe(false);   // interval not elapsed
    expect(await h.tick(new Date("2026-11-02T16:00:00Z"))).toBe(false);   // 00:00 local: quiet hours
    expect(await h.tick(new Date("2026-11-02T23:01:00Z"))).toBe(true);    // 07:01 local
    expect(fired[0]).toMatchObject({ channelKey: "global", raw: true, text: "TEMPLATE\n\nUser custom heartbeat prompt:\nalso check mail" });
  });
  test("defaults to its own session; passes profile/model/replyTo through", async () => {
    const c = heartbeatConfigSchema.parse({ profile: "cheap", model: "small", replyTo: "none" });
    expect(c.target).toBe("heartbeat");
    const h = new HeartbeatScheduler(c, tmp(), "UTC", silentLogger);
    const { api, fired, kv } = fakeApi();
    (h as unknown as { api: SchedulerApi }).api = api;
    kv.set("heartbeat:lastFiredAt", "0");
    expect(await h.tick(new Date())).toBe(true);
    expect(fired[0]).toMatchObject({ channelKey: "heartbeat", profile: "cheap", model: "small", deliverTo: "none" });
  });
  test("busy channel defers", async () => {
    const h = new HeartbeatScheduler(cfg(), tmp(), "UTC", silentLogger);
    const { api, fired, kv } = fakeApi(true);
    (h as unknown as { api: SchedulerApi }).api = api;
    kv.set("heartbeat:lastFiredAt", "0");
    expect(await h.tick(new Date())).toBe(false);
    expect(fired).toHaveLength(0);
  });
  test("inExcludeWindow", () => {
    expect(inExcludeWindow(new Date("2026-11-02T12:00:00Z"), [{ start: "11:00", end: "13:00" }], "UTC")).toBe(true);
    expect(inExcludeWindow(new Date("2026-11-02T13:00:00Z"), [{ start: "11:00", end: "13:00" }], "UTC")).toBe(false);
  });
});
