import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSettings, StateStore } from "@uniqlaw/core";
import { applyMigration, detectRunningV2, planMigration, targetForChannelKey } from "../src/index.ts";

// Fixture shaped after claudeclaw-v2/src/{config,sessions,inbox,jobs}.ts. Fake tokens only.
function makeV2(opts: { settings?: unknown; sessions?: unknown; v1Global?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "uq-v2-"));
  const st = join(dir, ".claude", "claudeclaw");
  mkdirSync(join(st, "inbox"), { recursive: true });
  mkdirSync(join(st, "jobs"), { recursive: true });
  mkdirSync(join(dir, "prompts", "heartbeat"), { recursive: true });
  writeFileSync(join(st, "settings.json"), JSON.stringify(opts.settings ?? {
    telegram: { token: "TEST-TG-TOKEN", allowedUserIds: [111, "bad"], messageStream: { mode: "keep" } },
    discord: { token: "TEST-DC-TOKEN", allowedUserIds: ["222"], allowedBotIds: [], channels: { "999": { enabled: true, requireMention: true, ignoreOtherMentions: false } } },
    slack: { appToken: "", botToken: "", allowedUserIds: [], allowedBotIds: [], defaultMode: "channel", channels: {} },
    line: { channelAccessToken: "", channelSecret: "", webhookPath: "/line/webhook", webhookPort: 0, allowedUserIds: [], allowedGroupIds: [] },
    web: { enabled: true, host: "127.0.0.1", port: 4632 },
    approval: { enabled: true, timeoutSeconds: 120, survey: "dismiss" },
    sessionCleanup: { idleTimeoutHours: 72, checkIntervalMinutes: 15 },
    heartbeat: { enabled: true, interval: 60, prompt: "ping", excludeWindows: [{ start: "23:00", end: "07:00" }] },
    security: { level: "strict", allowedTools: ["Read"], disallowedTools: ["WebFetch"], skipPermissions: false },
    backgroundNotify: { mode: "all" },
    model: "opus",
    agentic: { enabled: true, defaultMode: "impl", modes: [{ name: "impl", model: "sonnet", keywords: ["code"] }],
      hysteresis: { confidenceThreshold: 0.75, scoreMargin: 2, stickyWindowMinutes: 30, stickyWindowTurns: 5 } },
    telegramPollSeconds: 30,
    timezone: "UTC+8",
    queue: { mode: "native", debounceMs: 1000, cap: 10, dropPolicy: "old" },
    somethingElse: 1,
  }));
  writeFileSync(join(st, "sessions.json"), JSON.stringify(opts.sessions ?? {
    global: { kind: "global", channelKey: "global", sessionId: "11111111-1111-4111-8111-111111111111",
      tmuxSession: "claudeclaw-abcd1234-global", multiparty: false, createdAt: "2026-05-14T17:30:00Z", lastActivityAt: "2026-05-14T17:45:12Z" },
    "telegram:-100123": { kind: "telegram", channelKey: "telegram:-100123", sessionId: "22222222-2222-4222-8222-222222222222",
      tmuxSession: "claudeclaw-abcd1234-telegram--100123", multiparty: true, createdAt: "2026-05-15T00:00:00Z", lastActivityAt: "2026-05-16T00:00:00Z" },
    "discord:999": { kind: "discord", channelKey: "discord:999", tmuxSession: "x" },
  }));
  writeFileSync(join(st, "inbox", "telegram_-100123.jsonl"),
    JSON.stringify({ ts: "2026-05-16T01:00:00Z", kind: "send", from: "global", text: "hello group" }) + "\nnot json\n" +
    JSON.stringify({ ts: "2026-05-16T01:01:00Z", kind: "trigger-result", text: "done", note: "target=x" }) + "\n");
  writeFileSync(join(st, "jobs", "daily.md"), "---\nschedule: 0 9 * * *\ntarget: global\n---\nGood morning\n");
  writeFileSync(join(st, "jobs", "notes.txt"), "ignored");
  writeFileSync(join(dir, "prompts", "IDENTITY.md"), "I am claw");
  writeFileSync(join(dir, "prompts", "heartbeat", "default.md"), "hb");
  if (opts.v1Global) writeFileSync(join(st, "session.json"), JSON.stringify({ sessionId: "v1" }));
  return dir;
}

let v2: string;
let target: string;
beforeEach(() => {
  v2 = makeV2();
  target = mkdtempSync(join(tmpdir(), "uq-target-"));
});

describe("planMigration", () => {
  test("maps settings into a schema-valid UniQlaw config", async () => {
    const plan = await planMigration(v2);
    const s = parseSettings(plan.settings);
    expect(s.profiles.main!.provider).toBe("claude-tmux");
    expect(s.profiles.main!.model).toBe("opus");
    expect(s.profiles.main!.permissions).toMatchObject({ level: "strict", allowTools: ["Read"], denyTools: ["WebFetch"],
      approval: { mode: "ask-operator", timeoutSec: 120 } });
    expect((s.profiles.main!.options as any).agentic.defaultMode).toBe("impl");
    expect(s.queue).toEqual({ mode: "steer", debounceMs: 1000, cap: 10, dropPolicy: "old" });
    expect(s.sessionCleanup).toEqual({ idleTimeoutHours: 72, checkIntervalMinutes: 15 });
    expect(s.backgroundNotify.mode).toBe("all");
    expect(s.timezone).toBe("UTC+8");
    expect(s.output.stream).toBe("keep");
    expect(s.web).toEqual({ enabled: true, host: "127.0.0.1", port: 4632 });
    expect(s.plugins.telegram).toMatchObject({ enabled: true, token: "TEST-TG-TOKEN", allowedUserIds: ["111"], pollSeconds: 30 });
    expect(s.plugins.discord).toMatchObject({ enabled: false, token: "TEST-DC-TOKEN" });
    expect(s.plugins.slack).toBeUndefined(); // no tokens → not copied
    expect(s.plugins.heartbeat).toMatchObject({ enabled: false, v2Enabled: true, prompt: "ping" });
  });

  test("warns about everything not carried over 1:1", async () => {
    const { warnings } = await planMigration(v2);
    const w = warnings.join("\n");
    for (const needle of ["native", "M5", "SecretRefs", "telegram.token", "discord.token", "UTC+8", "somethingElse", "survey", "no sessionId", "unparseable"]) {
      expect(w).toContain(needle);
    }
  });

  test("maps sessions and inbox", async () => {
    const plan = await planMigration(v2);
    expect(plan.sessions.map((s) => s.channelKey).sort()).toEqual(["global", "telegram:-100123"]);
    const tg = plan.sessions.find((s) => s.channelKey === "telegram:-100123")!;
    expect(tg).toMatchObject({ profile: "main", provider: "claude-tmux", providerSessionId: "22222222-2222-4222-8222-222222222222", multiparty: true });
    expect(tg.createdAt).toBe(Date.parse("2026-05-15T00:00:00Z"));
    expect(JSON.parse(tg.lastTarget!)).toEqual({ platform: "telegram", chatId: "-100123" });
    expect(JSON.parse(tg.adapterState!)).toEqual({ v2TmuxSession: "claudeclaw-abcd1234-telegram--100123" });
    expect(plan.sessions.find((s) => s.channelKey === "global")!.lastTarget).toBeNull();
    expect(plan.pending).toHaveLength(2);
    expect(plan.pending[0]!.channelKey).toBe("telegram:-100123");
    expect(plan.pending[0]!.payload).toMatchObject({ source: "v2-inbox", kind: "send", text: "hello group" });
    expect(plan.files.map((f) => f.to).sort()).toEqual([".uniqlaw/jobs/daily.md", "prompts/IDENTITY.md", "prompts/heartbeat/default.md"]);
  });

  test("approval/skip flags map to approval modes", async () => {
    const a = await planMigration(makeV2({ settings: { approval: { enabled: false } } }));
    expect(parseSettings(a.settings).profiles.main!.permissions.approval.mode).toBe("auto-deny");
    const b = await planMigration(makeV2({ settings: { security: { skipPermissions: true } } }));
    expect(parseSettings(b.settings).profiles.main!.permissions.approval.mode).toBe("auto-allow");
  });

  test("empty telegram allowlist warns (v2 allowed everyone, UniQlaw fails closed)", async () => {
    const plan = await planMigration(makeV2({ settings: { telegram: { token: "T", allowedUserIds: [] } } }));
    expect(plan.warnings.join("\n")).toMatch(/accepts NOBODY/);
  });

  test("empty allowlists warn for every platform", async () => {
    const plan = await planMigration(makeV2({ settings: { discord: { token: "D", allowedUserIds: [] }, slack: { botToken: "S", appToken: "A", allowedUserIds: [] } } }));
    const w = plan.warnings.join("\n");
    expect(w).toMatch(/discord\.allowedUserIds is empty/);
    expect(w).toMatch(/slack\.allowedUserIds is empty/);
  });

  test("v1 leftovers only warn", async () => {
    const dir = makeV2({ sessions: { threads: { "123": { sessionId: "v1-thread" } } }, v1Global: true });
    const plan = await planMigration(dir);
    expect(plan.sessions).toEqual([]);
    expect(plan.warnings.join("\n")).toMatch(/v1-shaped/);
    expect(plan.warnings.join("\n")).toMatch(/v1 leftover/);
  });

  test("rejects a non-v2 directory", async () => {
    await expect(planMigration(target)).rejects.toThrow(/not a ClaudeClaw v2 project/);
  });
});

describe("applyMigration", () => {
  test("dry run writes nothing", async () => {
    const r = await applyMigration(await planMigration(v2), target, { dryRun: true });
    expect(r.sessionsImported).toHaveLength(2);
    expect(r.pendingImported).toBe(2);
    expect(r.filesCopied).toHaveLength(3);
    expect(existsSync(join(target, ".uniqlaw"))).toBe(false);
  });

  test("writes settings, state, files, manifest; v2 untouched", async () => {
    const before = readFileSync(join(v2, ".claude/claudeclaw/sessions.json"), "utf8");
    const r = await applyMigration(await planMigration(v2), target);
    expect(r.settings).toBe("written");
    parseSettings(JSON.parse(readFileSync(join(target, ".uniqlaw/settings.json"), "utf8")));
    const store = new StateStore(join(target, ".uniqlaw/state.db"));
    expect(store.listSessions().map((s) => s.channelKey).sort()).toEqual(["global", "telegram:-100123"]);
    const pend = store.drainPending("telegram:-100123");
    expect(pend.map((p) => p.kind)).toEqual(["external", "external"]);
    expect(JSON.parse(pend[0]!.payload).text).toBe("hello group");
    store.close();
    expect(readFileSync(join(target, ".uniqlaw/jobs/daily.md"), "utf8")).toContain("schedule: 0 9");
    expect(readFileSync(join(target, "prompts/heartbeat/default.md"), "utf8")).toBe("hb");
    const m = JSON.parse(readFileSync(join(target, ".uniqlaw/migrated-from-v2/manifest.json"), "utf8"));
    expect(m.sources.length).toBeGreaterThanOrEqual(3);
    expect(m.sources[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(join(v2, ".claude/claudeclaw/sessions.json"), "utf8")).toBe(before);
    expect(existsSync(join(v2, ".claude/claudeclaw/inbox/telegram_-100123.jsonl"))).toBe(true);
  });

  test("idempotent re-run: no duplicate sessions or pending, settings unchanged", async () => {
    const plan = await planMigration(v2);
    await applyMigration(plan, target);
    const r2 = await applyMigration(await planMigration(v2), target);
    expect(r2.settings).toBe("unchanged");
    expect(r2.sessionsImported).toEqual([]);
    expect(r2.sessionsSkipped.sort()).toEqual(["global", "telegram:-100123"]);
    expect(r2.pendingImported).toBe(0);
    expect(r2.pendingSkipped).toBe(2);
    expect(r2.filesCopied).toEqual([]);
    const store = new StateStore(join(target, ".uniqlaw/state.db"));
    expect(store.countPending("telegram:-100123")).toBe(2);
    store.close();
  });

  test("keeps user edits to settings and copied files unless forced", async () => {
    await applyMigration(await planMigration(v2), target);
    writeFileSync(join(target, ".uniqlaw/settings.json"), JSON.stringify({ timezone: "Asia/Taipei" }));
    writeFileSync(join(target, "prompts/IDENTITY.md"), "edited");
    const r = await applyMigration(await planMigration(v2), target);
    expect(r.settings).toBe("skipped-user-edited");
    expect(readFileSync(join(target, "prompts/IDENTITY.md"), "utf8")).toBe("edited");
    expect(r.filesSkipped).toContain("prompts/IDENTITY.md");
    const forced = await applyMigration(await planMigration(v2), target, { force: true });
    expect(forced.settings).toBe("written");
  });

  test("in-place migration (target = v2 dir) does not copy prompts onto themselves", async () => {
    const r = await applyMigration(await planMigration(v2), v2);
    expect(r.filesSkipped).toEqual(expect.arrayContaining(["prompts/IDENTITY.md", "prompts/heartbeat/default.md"]));
    expect(r.filesCopied).toEqual([".uniqlaw/jobs/daily.md"]);
  });
});

describe("helpers", () => {
  test("detectRunningV2", () => {
    expect(detectRunningV2(v2).running).toBe(false);
    writeFileSync(join(v2, ".claude/claudeclaw/daemon.pid"), String(process.pid));
    expect(detectRunningV2(v2)).toEqual({ running: true, pid: process.pid });
    writeFileSync(join(v2, ".claude/claudeclaw/daemon.pid"), "999999999");
    expect(detectRunningV2(v2).running).toBe(false);
  });
  test("targetForChannelKey", () => {
    expect(targetForChannelKey("global")).toBeUndefined();
    expect(targetForChannelKey("discord:5")).toEqual({ platform: "discord", chatId: "5" });
    expect(targetForChannelKey("slack:C1:123.456")).toEqual({ platform: "slack", chatId: "C1", threadId: "123.456" });
  });
});
