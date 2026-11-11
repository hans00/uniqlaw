// Durable runtime state in `.uniqlaw/state.db` (bun:sqlite).
import { Database } from "bun:sqlite";

export interface SessionRow {
  /** UniQlaw session id = channelKey (one session per channel per profile binding). */
  channelKey: string;
  profile: string;
  provider: string;
  providerSessionId: string | null;
  multiparty: boolean;
  createdAt: number;
  lastActivityAt: number;
  /** Last reply target (JSON Target), used for background output. */
  lastTarget: string | null;
  /** Free-form adapter state (JSON), e.g. tmux session name. */
  adapterState: string | null;
}

export interface PendingInput {
  id: number;
  channelKey: string;
  kind: "notify-echo" | "peer-result" | "external" | "group-context" | "handoff";
  /** JSON payload. */
  payload: string;
  createdAt: number;
}

export interface TaskRow {
  taskId: string;
  fromSession: string;
  toSession: string;
  mode: "ask" | "trigger";
  state: "submitted" | "working" | "completed" | "failed" | "canceled";
  request: string;
  result: string | null;
  createdAt: number;
  updatedAt: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  channel_key TEXT PRIMARY KEY,
  profile TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_session_id TEXT,
  multiparty INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL,
  last_target TEXT,
  adapter_state TEXT
);
CREATE TABLE IF NOT EXISTS pending_input (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS pending_input_key ON pending_input(channel_key);
CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY,
  from_session TEXT NOT NULL,
  to_session TEXT NOT NULL,
  mode TEXT NOT NULL,
  state TEXT NOT NULL,
  request TEXT NOT NULL,
  result TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS deferred_input (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_key TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  claimed INTEGER NOT NULL DEFAULT 0
);
`;

/** Input held back while the daemon drains for a restart (replayed after it). A row stays until the turn that
 *  consumes it starts (at-least-once); `claimed` = handed to a session queue by this process. */
export interface DeferredInput { id: number; channelKey: string; payload: string; createdAt: number; claimed: boolean }

export class StateStore {
  readonly db: Database;
  constructor(path: string) {
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
  }
  close() { this.db.close(); }

  // ── sessions ──
  getSession(key: string): SessionRow | undefined {
    const r = this.db.query("SELECT * FROM sessions WHERE channel_key = ?").get(key) as Record<string, unknown> | null;
    return r ? rowToSession(r) : undefined;
  }
  listSessions(): SessionRow[] {
    return (this.db.query("SELECT * FROM sessions ORDER BY last_activity_at DESC").all() as Record<string, unknown>[]).map(rowToSession);
  }
  upsertSession(s: SessionRow) {
    this.db.query(`INSERT INTO sessions (channel_key, profile, provider, provider_session_id, multiparty, created_at, last_activity_at, last_target, adapter_state)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(channel_key) DO UPDATE SET profile=excluded.profile, provider=excluded.provider,
        provider_session_id=excluded.provider_session_id, multiparty=excluded.multiparty,
        last_activity_at=excluded.last_activity_at, last_target=excluded.last_target, adapter_state=excluded.adapter_state`)
      .run(s.channelKey, s.profile, s.provider, s.providerSessionId, s.multiparty ? 1 : 0, s.createdAt, s.lastActivityAt, s.lastTarget, s.adapterState);
  }
  patchSession(key: string, patch: Partial<Omit<SessionRow, "channelKey">>) {
    const cur = this.getSession(key);
    if (cur) this.upsertSession({ ...cur, ...patch });
  }
  deleteSession(key: string) { this.db.query("DELETE FROM sessions WHERE channel_key = ?").run(key); }

  // ── pending input (replaces v2 inbox/*.jsonl) ──
  pushPending(channelKey: string, kind: PendingInput["kind"], payload: unknown) {
    this.db.query("INSERT INTO pending_input (channel_key, kind, payload, created_at) VALUES (?, ?, ?, ?)")
      .run(channelKey, kind, JSON.stringify(payload), Date.now());
  }
  drainPending(channelKey: string): PendingInput[] {
    return this.db.transaction(() => {
      const rows = this.db.query("SELECT * FROM pending_input WHERE channel_key = ? ORDER BY id").all(channelKey) as Record<string, unknown>[];
      this.db.query("DELETE FROM pending_input WHERE channel_key = ?").run(channelKey);
      return rows.map((r) => ({ id: r.id as number, channelKey: r.channel_key as string, kind: r.kind as PendingInput["kind"],
        payload: r.payload as string, createdAt: r.created_at as number }));
    })();
  }
  /** Keep only the newest `keep` entries of one kind (bounded context buffers). */
  trimPending(channelKey: string, kind: PendingInput["kind"], keep: number) {
    this.db.query(`DELETE FROM pending_input WHERE channel_key = ? AND kind = ? AND id NOT IN (
      SELECT id FROM pending_input WHERE channel_key = ? AND kind = ? ORDER BY id DESC LIMIT ?)`).run(channelKey, kind, channelKey, kind, keep);
  }
  countPending(channelKey: string): number {
    return (this.db.query("SELECT COUNT(*) AS n FROM pending_input WHERE channel_key = ?").get(channelKey) as { n: number }).n;
  }

  // ── bus tasks ──
  createTask(t: Omit<TaskRow, "createdAt" | "updatedAt" | "result" | "state">) {
    const now = Date.now();
    this.db.query("INSERT INTO tasks (task_id, from_session, to_session, mode, state, request, result, created_at, updated_at) VALUES (?, ?, ?, ?, 'submitted', ?, NULL, ?, ?)")
      .run(t.taskId, t.fromSession, t.toSession, t.mode, t.request, now, now);
  }
  updateTask(taskId: string, state: TaskRow["state"], result?: string) {
    this.db.query("UPDATE tasks SET state = ?, result = COALESCE(?, result), updated_at = ? WHERE task_id = ?")
      .run(state, result ?? null, Date.now(), taskId);
  }
  getTask(taskId: string): TaskRow | undefined {
    const r = this.db.query("SELECT * FROM tasks WHERE task_id = ?").get(taskId) as Record<string, unknown> | null;
    return r ? rowToTask(r) : undefined;
  }
  /** Tasks nobody has answered yet (submitted / working). */
  openTasks(): TaskRow[] {
    return (this.db.query("SELECT * FROM tasks WHERE state IN ('submitted', 'working') ORDER BY created_at").all() as Record<string, unknown>[]).map(rowToTask);
  }

  // ── deferred input (graceful restart) ──
  pushDeferred(channelKey: string, payload: unknown) {
    this.db.query("INSERT INTO deferred_input (channel_key, payload, created_at) VALUES (?, ?, ?)").run(channelKey, JSON.stringify(payload), Date.now());
  }
  listDeferred(): DeferredInput[] {
    return (this.db.query("SELECT * FROM deferred_input ORDER BY id").all() as Record<string, unknown>[])
      .map((r) => ({ id: r.id as number, channelKey: r.channel_key as string, payload: r.payload as string, createdAt: r.created_at as number, claimed: !!r.claimed }));
  }
  countDeferred(): number { return (this.db.query("SELECT COUNT(*) AS n FROM deferred_input").get() as { n: number }).n; }
  /** Claim every unclaimed deferred input (to replay it). The rows stay until deleteDeferred. */
  claimDeferred(): DeferredInput[] {
    return this.db.transaction(() => {
      const rows = this.listDeferred().filter((r) => !r.claimed);
      this.db.query("UPDATE deferred_input SET claimed = 1 WHERE claimed = 0").run();
      return rows.map((r) => ({ ...r, claimed: true }));
    })();
  }
  /** Give claimed rows back (one row, or all: claims left by a previous process are stale). */
  unclaimDeferred(id?: number) {
    if (id === undefined) this.db.query("UPDATE deferred_input SET claimed = 0").run();
    else this.db.query("UPDATE deferred_input SET claimed = 0 WHERE id = ?").run(id);
  }
  deleteDeferred(ids: number[]) {
    for (const id of ids) this.db.query("DELETE FROM deferred_input WHERE id = ?").run(id);
  }
  /** Run fn in one SQLite transaction. */
  tx<T>(fn: () => T): T { return this.db.transaction(fn)(); }

  // ── kv ──
  get(k: string): string | undefined { return (this.db.query("SELECT v FROM kv WHERE k = ?").get(k) as { v: string } | null)?.v; }
  set(k: string, v: string) { this.db.query("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, v); }
  del(k: string) { this.db.query("DELETE FROM kv WHERE k = ?").run(k); }
  /** kv entries whose key starts with prefix (literal match, no LIKE wildcards). */
  entries(prefix: string): [string, string][] {
    return (this.db.query("SELECT k, v FROM kv WHERE substr(k, 1, ?) = ? ORDER BY k").all(prefix.length, prefix) as { k: string; v: string }[])
      .map((r) => [r.k, r.v]);
  }
}

function rowToTask(r: Record<string, unknown>): TaskRow {
  return { taskId: r.task_id as string, fromSession: r.from_session as string, toSession: r.to_session as string,
    mode: r.mode as TaskRow["mode"], state: r.state as TaskRow["state"], request: r.request as string,
    result: (r.result as string | null) ?? null, createdAt: r.created_at as number, updatedAt: r.updated_at as number };
}

function rowToSession(r: Record<string, unknown>): SessionRow {
  return {
    channelKey: r.channel_key as string, profile: r.profile as string, provider: r.provider as string,
    providerSessionId: (r.provider_session_id as string | null) ?? null, multiparty: !!r.multiparty,
    createdAt: r.created_at as number, lastActivityAt: r.last_activity_at as number,
    lastTarget: (r.last_target as string | null) ?? null, adapterState: (r.adapter_state as string | null) ?? null,
  };
}
