// ClaudeClaw v2 → UniQlaw migration (docs/architecture.md §11.1).
//
//   planMigration(v2Dir)               read-only; builds settings + state rows + file copies + warnings
//   applyMigration(plan, targetDir)    writes .uniqlaw/{settings.json,state.db,jobs/,migrated-from-v2/}
//   detectRunningV2(v2Dir)             daemon.pid liveness check
//
// Copies only — v2 originals are never moved or modified. Re-running is idempotent:
// sessions already in state.db are kept, imported inbox entries are de-duplicated,
// and settings.json is only overwritten if it is unchanged since the last migration.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { parseSettings, StateStore, type SessionRow, type Target } from "@uniqlaw/core";

const V2_STATE = join(".claude", "claudeclaw");

export interface PendingImport {
  channelKey: string;
  /** Stable hash for de-duplication across re-runs. */
  hash: string;
  payload: { source: "v2-inbox"; ts?: string; kind?: string; from?: string; text: string; note?: string };
}

export interface FileCopy {
  /** Absolute source path. */
  from: string;
  /** Path relative to the target project dir. */
  to: string;
}

export interface MigrationPlan {
  v2Dir: string;
  /** Raw settings object (validated with core parseSettings; defaults not expanded). */
  settings: Record<string, unknown>;
  sessions: SessionRow[];
  pending: PendingImport[];
  files: FileCopy[];
  /** v2 files that were read (recorded in the manifest with their sha256). */
  sources: string[];
  warnings: string[];
}

export interface ApplyOptions {
  dryRun?: boolean;
  /** Overwrite a settings.json that was edited after the previous migration. */
  force?: boolean;
}

export interface ApplyReport {
  dryRun: boolean;
  settings: "written" | "unchanged" | "skipped-user-edited";
  sessionsImported: string[];
  sessionsSkipped: string[];
  pendingImported: number;
  pendingSkipped: number;
  filesCopied: string[];
  filesSkipped: string[];
  warnings: string[];
}

// ─────────────────────────────────────────────────────────────── plan

export async function planMigration(v2DirIn: string): Promise<MigrationPlan> {
  const v2Dir = resolve(v2DirIn);
  const warnings: string[] = [];
  const sources: string[] = [];
  const stateDir = join(v2Dir, V2_STATE);
  if (!existsSync(stateDir)) throw new Error(`not a ClaudeClaw v2 project (missing ${V2_STATE}/): ${v2Dir}`);

  const readJson = (p: string): any => {
    if (!existsSync(p)) return undefined;
    sources.push(p);
    try { return JSON.parse(readFileSync(p, "utf8")); }
    catch (e) { warnings.push(`could not parse ${relative(v2Dir, p)}: ${(e as Error).message}`); return undefined; }
  };

  const raw = readJson(join(stateDir, "settings.json"));
  if (raw === undefined) warnings.push("no v2 settings.json found; using defaults");
  const settings = mapSettings(raw ?? {}, warnings);
  // Fail fast if our output does not satisfy the UniQlaw schema.
  parseSettings(settings);

  const sessions = mapSessions(readJson(join(stateDir, "sessions.json")), warnings);
  if (existsSync(join(stateDir, "session.json"))) {
    warnings.push("found v1 leftover .claude/claudeclaw/session.json — not migrated; run v2's /claudeclaw2:migrate first if it still matters");
  }

  const pending = readInbox(join(stateDir, "inbox"), sources, warnings);
  const files = planFiles(v2Dir, warnings);

  return { v2Dir, settings, sessions, pending, files, sources, warnings };
}

function isObj(v: unknown): v is Record<string, any> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);

function mapSettings(raw: Record<string, any>, warnings: string[]): Record<string, unknown> {
  const out: Record<string, any> = {};

  // timezone
  if (typeof raw.timezone === "string" && raw.timezone) {
    out.timezone = raw.timezone;
    if (/^UTC[+-]\d/.test(raw.timezone)) {
      warnings.push(`timezone "${raw.timezone}" kept as-is (v2 offset format); consider an IANA name like "Asia/Taipei"`);
    }
  }

  // permissions (v2 security + approval)
  const sec = isObj(raw.security) ? raw.security : {};
  const appr = isObj(raw.approval) ? raw.approval : {};
  const level = ["locked", "strict", "moderate", "unrestricted"].includes(sec.level) ? sec.level : "moderate";
  let mode: "ask-operator" | "auto-deny" | "auto-allow" = "ask-operator";
  if (sec.skipPermissions === true) {
    mode = "auto-allow";
    warnings.push("security.skipPermissions=true → permissions.approval.mode=\"auto-allow\" (every tool auto-approved)");
  } else if (appr.enabled === false) {
    mode = "auto-deny";
    warnings.push("approval.enabled=false → permissions.approval.mode=\"auto-deny\" (v2 left dialogs hanging; UniQlaw denies them)");
  }
  const permissions: Record<string, unknown> = {
    level,
    allowTools: strArr(sec.allowedTools),
    denyTools: strArr(sec.disallowedTools),
    approval: { mode, timeoutSec: typeof appr.timeoutSeconds === "number" && appr.timeoutSeconds > 0 ? Math.round(appr.timeoutSeconds) : 300 },
  };
  if (appr.survey !== undefined) {
    warnings.push(`approval.survey="${appr.survey}" is handled inside the claude-tmux adapter (default: dismiss); not carried over`);
  }

  // profile "main"
  const main: Record<string, any> = { provider: "claude-tmux", permissions, options: {} };
  if (typeof raw.model === "string" && raw.model) main.model = raw.model;
  if (isObj(raw.agentic) && (raw.agentic.enabled || (Array.isArray(raw.agentic.modes) && raw.agentic.modes.length))) {
    main.options.agentic = raw.agentic;
    warnings.push("agentic (per-turn model routing) kept under profiles.main.options.agentic — the model router arrives in M5");
  }
  out.profiles = { main };
  out.bindings = { default: "main", channels: {} };

  // queue
  if (isObj(raw.queue)) {
    const q = raw.queue;
    const qm = q.mode === "native" ? "steer" : ["queue", "interrupt"].includes(q.mode) ? q.mode : "queue";
    if (q.mode === "native") warnings.push("queue.mode \"native\" → \"steer\" (v2 native mode was a mid-turn steer, see M0 results)");
    out.queue = {
      mode: qm,
      ...(typeof q.debounceMs === "number" ? { debounceMs: Math.max(0, Math.round(q.debounceMs)) } : {}),
      ...(typeof q.cap === "number" && q.cap > 0 ? { cap: Math.round(q.cap) } : {}),
      ...(["old", "new", "summarize"].includes(q.dropPolicy) ? { dropPolicy: q.dropPolicy } : {}),
    };
  }

  if (isObj(raw.sessionCleanup)) {
    const c = raw.sessionCleanup;
    out.sessionCleanup = {
      ...(typeof c.idleTimeoutHours === "number" && c.idleTimeoutHours >= 0 ? { idleTimeoutHours: c.idleTimeoutHours } : {}),
      ...(typeof c.checkIntervalMinutes === "number" && c.checkIntervalMinutes > 0 ? { checkIntervalMinutes: c.checkIntervalMinutes } : {}),
    };
  }
  if (isObj(raw.backgroundNotify) && ["last", "all", "off"].includes(raw.backgroundNotify.mode)) {
    out.backgroundNotify = { mode: raw.backgroundNotify.mode };
  }
  if (isObj(raw.web)) {
    out.web = {
      ...(typeof raw.web.enabled === "boolean" ? { enabled: raw.web.enabled } : {}),
      ...(typeof raw.web.host === "string" ? { host: raw.web.host } : {}),
      ...(typeof raw.web.port === "number" && raw.web.port >= 0 ? { port: raw.web.port } : {}),
    };
  }

  // output streaming: v2 had per-platform messageStream; UniQlaw has one global default.
  const tgStream = raw.telegram?.messageStream?.mode;
  if (["replace", "keep", "off"].includes(tgStream)) out.output = { stream: tgStream };
  const otherStreams = ["discord", "slack", "line"].filter((p) => raw[p]?.messageStream?.mode);
  if (otherStreams.length) {
    warnings.push(`per-platform messageStream for ${otherStreams.join(", ")} kept inside plugins.<name>; UniQlaw's global output.stream ${tgStream ? `= "${tgStream}" (from telegram)` : "uses the default"}`);
  }

  // plugins
  const plugins: Record<string, any> = {};
  const tokenWarn = new Set<string>();
  if (isObj(raw.telegram) && raw.telegram.token) {
    plugins.telegram = {
      enabled: true,
      token: raw.telegram.token,
      allowedUserIds: Array.isArray(raw.telegram.allowedUserIds)
        ? raw.telegram.allowedUserIds.filter((x: unknown) => typeof x === "number" || (typeof x === "string" && /^-?\d+$/.test(x))).map(String)
        : [],
      ...(typeof raw.telegramPollSeconds === "number" ? { pollSeconds: raw.telegramPollSeconds } : {}),
    };
    tokenWarn.add("telegram.token");
    if (!plugins.telegram.allowedUserIds.length) {
      warnings.push("telegram.allowedUserIds is empty: v2 accepted everyone, UniQlaw accepts NOBODY (fail closed) — add your Telegram user id to plugins.telegram.allowedUserIds");
    }
  }
  for (const p of ["discord", "slack", "line"] as const) {
    const cfg = raw[p];
    if (!isObj(cfg)) continue;
    const hasToken = p === "discord" ? !!cfg.token : p === "slack" ? !!(cfg.botToken || cfg.appToken) : !!(cfg.channelAccessToken || cfg.channelSecret);
    if (!hasToken) continue;
    plugins[p] = { ...cfg, enabled: false };
    const users = Array.isArray(cfg.allowedUserIds) ? cfg.allowedUserIds : [];
    if (!users.length) warnings.push(`${p}.allowedUserIds is empty: v2 accepted everyone, UniQlaw accepts NOBODY (fail closed) — fill plugins.${p}.allowedUserIds before enabling it`);
    warnings.push(`${p} config copied to plugins.${p} with enabled:false — the ${p} adapter arrives in M5`);
    if (p === "discord") tokenWarn.add("discord.token");
    if (p === "slack") { if (cfg.botToken) tokenWarn.add("slack.botToken"); if (cfg.appToken) tokenWarn.add("slack.appToken"); }
    if (p === "line") { if (cfg.channelAccessToken) tokenWarn.add("line.channelAccessToken"); if (cfg.channelSecret) tokenWarn.add("line.channelSecret"); }
  }
  if (isObj(raw.heartbeat) && (raw.heartbeat.enabled || raw.heartbeat.prompt)) {
    plugins.heartbeat = { ...raw.heartbeat, enabled: false, v2Enabled: raw.heartbeat.enabled === true };
    warnings.push("heartbeat copied to plugins.heartbeat with enabled:false (original state in v2Enabled) — the scheduler plugin arrives in M5");
  }
  if (Object.keys(plugins).length) out.plugins = plugins;
  if (tokenWarn.size) {
    warnings.push(`secrets copied inline (${[...tokenWarn].join(", ")}); consider moving them to {env}/{file} SecretRefs`);
  }

  const known = new Set(["telegram", "discord", "slack", "line", "web", "approval", "sessionCleanup", "heartbeat", "security",
    "backgroundNotify", "model", "agentic", "telegramPollSeconds", "timezone", "queue"]);
  const unknown = Object.keys(raw).filter((k) => !known.has(k));
  if (unknown.length) warnings.push(`unmapped v2 settings keys ignored: ${unknown.join(", ")}`);

  return out;
}

const toMs = (v: unknown, fallback: number): number => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") { const t = Date.parse(v); if (!Number.isNaN(t)) return t; }
  return fallback;
};

/** Best-effort reply target from a v2 channel key (used for background output). */
export function targetForChannelKey(key: string): Target | undefined {
  const m = key.match(/^(telegram|discord|line):(.+)$/);
  if (m) return { platform: m[1]!, chatId: m[2]! };
  const s = key.match(/^slack:([^:]+)(?::(.+))?$/);
  if (s) return { platform: "slack", chatId: s[1]!, ...(s[2] ? { threadId: s[2] } : {}) };
  return undefined;
}

function mapSessions(raw: unknown, warnings: string[]): SessionRow[] {
  if (raw === undefined) return [];
  if (!isObj(raw)) { warnings.push("sessions.json is not an object; skipped"); return []; }
  const hasV2Entries = Object.entries(raw).some(([k, v]) => k !== "threads" && isObj(v) && "sessionId" in v);
  if (isObj(raw.threads) && !hasV2Entries) {
    warnings.push("sessions.json looks v1-shaped ({threads:…}); not migrated — run v2's /claudeclaw2:migrate first");
    return [];
  }
  const now = Date.now();
  const rows: SessionRow[] = [];
  for (const [key, v] of Object.entries(raw)) {
    if (key === "threads" && isObj(v) && !("sessionId" in v)) { warnings.push("ignored v1 'threads' entry in sessions.json"); continue; }
    if (!isObj(v) || typeof v.sessionId !== "string" || !v.sessionId) { warnings.push(`session ${key}: no sessionId; skipped`); continue; }
    const channelKey = typeof v.channelKey === "string" && v.channelKey ? v.channelKey : key;
    const created = toMs(v.createdAt, now);
    const target = targetForChannelKey(channelKey);
    rows.push({
      channelKey,
      profile: "main",
      provider: "claude-tmux",
      providerSessionId: v.sessionId,
      multiparty: v.multiparty === true,
      createdAt: created,
      lastActivityAt: toMs(v.lastActivityAt, created),
      lastTarget: target ? JSON.stringify(target) : null,
      adapterState: JSON.stringify({ v2TmuxSession: typeof v.tmuxSession === "string" ? v.tmuxSession : null }),
    });
  }
  return rows;
}

function readInbox(dir: string, sources: string[], warnings: string[]): PendingImport[] {
  if (!existsSync(dir)) return [];
  const out: PendingImport[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".jsonl")) continue;
    const p = join(dir, name);
    sources.push(p);
    let firstKey: string | undefined;
    const fileKey = unsafeKey(name.slice(0, -".jsonl".length));
    const lines = readFileSync(p, "utf8").split("\n").filter((l) => l.trim());
    lines.forEach((line, i) => {
      let e: any;
      try { e = JSON.parse(line); } catch { warnings.push(`inbox/${name}:${i + 1} unparseable; skipped`); return; }
      if (!isObj(e) || typeof e.text !== "string") return;
      const channelKey = fileKey;
      firstKey ??= channelKey;
      out.push({
        channelKey,
        hash: createHash("sha256").update(`${channelKey}\n${line}`).digest("hex").slice(0, 24),
        payload: { source: "v2-inbox", ts: e.ts, kind: e.kind, from: e.from, text: e.text, ...(e.note ? { note: e.note } : {}) },
      });
    });
  }
  return out;
}

/** v2 inbox filenames replace [^a-zA-Z0-9._-] with "_" — reverse the common cases. */
function unsafeKey(safe: string): string {
  const m = safe.match(/^(telegram|discord|slack|line)_(.+)$/);
  if (!m) return safe;
  if (m[1] === "slack") return `slack:${m[2]!.replace(/_/g, ":")}`;
  return `${m[1]}:${m[2]}`;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (st.isFile()) out.push(p);
  }
  return out;
}

function planFiles(v2Dir: string, warnings: string[]): FileCopy[] {
  const files: FileCopy[] = [];
  const prompts = join(v2Dir, "prompts");
  if (existsSync(prompts)) {
    for (const f of walk(prompts)) files.push({ from: f, to: relative(v2Dir, f) });
  }
  const jobs = join(v2Dir, V2_STATE, "jobs");
  if (existsSync(jobs)) {
    for (const name of readdirSync(jobs)) {
      if (!name.endsWith(".md")) continue;
      files.push({ from: join(jobs, name), to: join(".uniqlaw", "jobs", name) });
    }
    if (files.some((f) => f.to.startsWith(join(".uniqlaw", "jobs")))) {
      warnings.push("cron jobs copied to .uniqlaw/jobs/ unchanged — the cron scheduler arrives in M5");
    }
  }
  // CLAUDE.md is not copied: claude adapters auto-load it from the project cwd.
  return files;
}

// ─────────────────────────────────────────────────────────────── apply

const sha = (buf: Buffer | string) => createHash("sha256").update(buf).digest("hex");

interface Manifest {
  migratedAt: string;
  v2Dir: string;
  settingsSha256: string;
  sources: { path: string; sha256: string }[];
  files: { from: string; to: string; sha256: string }[];
  sessions: string[];
  warnings: string[];
}

export async function applyMigration(plan: MigrationPlan, targetDirIn: string, opts: ApplyOptions = {}): Promise<ApplyReport> {
  const targetDir = resolve(targetDirIn);
  const dryRun = !!opts.dryRun;
  const uq = join(targetDir, ".uniqlaw");
  const manifestDir = join(uq, "migrated-from-v2");
  const manifestPath = join(manifestDir, "manifest.json");
  const settingsPath = join(uq, "settings.json");
  const report: ApplyReport = {
    dryRun, settings: "written", sessionsImported: [], sessionsSkipped: [], pendingImported: 0, pendingSkipped: 0,
    filesCopied: [], filesSkipped: [], warnings: [...plan.warnings],
  };

  const prev: Manifest | undefined = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : undefined;

  // settings.json
  const settingsText = JSON.stringify(plan.settings, null, 2) + "\n";
  if (existsSync(settingsPath)) {
    const cur = readFileSync(settingsPath, "utf8");
    if (cur === settingsText) report.settings = "unchanged";
    else if (!opts.force && (!prev || sha(cur) !== prev.settingsSha256)) {
      report.settings = "skipped-user-edited";
      report.warnings.push(".uniqlaw/settings.json was changed after the last migration (or not created by it); left untouched — pass force to overwrite");
    }
  }
  if (!dryRun) {
    mkdirSync(manifestDir, { recursive: true });
    if (report.settings === "written") writeFileSync(settingsPath, settingsText);
  }

  // state.db
  const store = dryRun ? undefined : new StateStore(join(uq, "state.db"));
  try {
    const existing = store ? new Set(store.listSessions().map((s) => s.channelKey)) : new Set<string>();
    if (dryRun && existsSync(join(uq, "state.db"))) {
      const ro = new StateStore(join(uq, "state.db"));
      for (const s of ro.listSessions()) existing.add(s.channelKey);
      ro.close();
    }
    for (const s of plan.sessions) {
      if (existing.has(s.channelKey)) { report.sessionsSkipped.push(s.channelKey); continue; }
      store?.upsertSession(s);
      report.sessionsImported.push(s.channelKey);
    }
    for (const p of plan.pending) {
      const k = `migrate-v2:inbox:${p.hash}`;
      if (store?.get(k)) { report.pendingSkipped++; continue; }
      store?.pushPending(p.channelKey, "external", p.payload);
      store?.set(k, "1");
      report.pendingImported++;
    }
  } finally {
    store?.close();
  }

  // files
  const copied: Manifest["files"] = [];
  for (const f of plan.files) {
    const dest = join(targetDir, f.to);
    const srcBuf = readFileSync(f.from);
    const srcSha = sha(srcBuf);
    if (resolve(dest) === resolve(f.from)) { report.filesSkipped.push(f.to); copied.push({ ...f, sha256: srcSha }); continue; }
    if (existsSync(dest)) {
      const destSha = sha(readFileSync(dest));
      const prevEntry = prev?.files.find((x) => x.to === f.to);
      if (destSha === srcSha || (prevEntry && destSha !== prevEntry.sha256)) {
        // identical, or user edited the copy since last migration → keep theirs
        if (destSha !== srcSha) report.warnings.push(`${f.to} was edited after the last migration; left untouched`);
        report.filesSkipped.push(f.to);
        copied.push({ ...f, sha256: srcSha });
        continue;
      }
    }
    if (!dryRun) {
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(f.from, dest);
    }
    report.filesCopied.push(f.to);
    copied.push({ ...f, sha256: srcSha });
  }

  if (!dryRun) {
    const manifest: Manifest = {
      migratedAt: new Date().toISOString(),
      v2Dir: plan.v2Dir,
      settingsSha256: report.settings === "skipped-user-edited" ? (prev?.settingsSha256 ?? "") : sha(settingsText),
      sources: plan.sources.filter((p) => existsSync(p)).map((p) => ({ path: p, sha256: sha(readFileSync(p)) })),
      files: copied,
      sessions: plan.sessions.map((s) => s.channelKey),
      warnings: report.warnings,
    };
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  }
  return report;
}

// ─────────────────────────────────────────────────────────────── detect

export function detectRunningV2(v2Dir: string): { running: boolean; pid?: number } {
  const pidFile = join(resolve(v2Dir), V2_STATE, "daemon.pid");
  if (!existsSync(pidFile)) return { running: false };
  const pid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) return { running: false };
  try {
    process.kill(pid, 0);
    return { running: true, pid };
  } catch (e) {
    // EPERM = exists but owned by someone else → still running
    return (e as NodeJS.ErrnoException).code === "EPERM" ? { running: true, pid } : { running: false, pid };
  }
}
