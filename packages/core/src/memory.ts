// Provider-independent long-term memory (docs §8.7), modelled on OpenClaw's memory-core:
//   memory/MEMORY.md        curated long-term memory, injected into chat sessions' prompts
//   memory/YYYY-MM-DD.md    daily notes (append-only working layer, searched, not injected)
//   memory/DREAMS.md        dream diary for humans (never indexed, never promoted)
// Any other *.md under memory/ (topic files, imports/…) is indexed for search too.
// Search uses SQLite FTS5 with the trigram tokenizer (substring matching, works for CJK).
// Every search hit by a chat session is recorded as a recall signal; the dreaming sweep
// (dreaming.ts) promotes entries that keep being useful into MEMORY.md.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { parseUtcOffset } from "./format.ts";
import type { GatewayTool } from "./plugin.ts";
import type { StateStore } from "./state.ts";

export const MEMORY_FILE = "MEMORY.md";
export const DREAMS_FILE = "DREAMS.md";
const DAILY_RE = /^\d{4}-\d{2}-\d{2}(-[a-z0-9._-]+)?\.md$/;
const ID_RE = /<!--\s*m:([a-z0-9]+)\s*-->/;
const DAY_MS = 86_400_000;

/** Who wrote or searched. Only "chat" (a one-to-one chat with an allowed user), "human" and "file" (edited by hand)
 *  entries can be promoted into MEMORY.md; "group" (multiparty chats, where non-operators talk too), internal jobs,
 *  workers and remote agents can write notes that are searchable but never promoted. */
export type MemoryOriginKind = "chat" | "group" | "internal" | "worker" | "remote" | "human" | "file";

export interface MemoryChunk {
  key: string;
  path: string; // relative to the memory dir
  startLine: number; // 1-based
  endLine: number;
  text: string;
  day?: string; // YYYY-MM-DD for daily notes
}

export interface MemoryHit extends MemoryChunk { score: number }

export interface RecallRow {
  key: string;
  path: string;
  snippet: string;
  count: number;
  queries: string[];
  days: string[];
  relSum: number;
  firstAt: number;
  lastAt: number;
  promotedAt: number | null;
}

export interface MemoryMeta { key: string; origin: MemoryOriginKind; source: string; importance: number | null; createdAt: number }

export interface MemoryOptions {
  /** Memory directory, relative to the project (default "memory"). */
  dir?: string;
  /** Bytes of MEMORY.md injected into prompts (the file itself is never truncated). */
  maxInjectBytes?: number;
  timezone?: string;
  now?: () => Date;
}

/** Wall-clock parts in a timezone given as an IANA name or a UTC offset ("UTC+8", "+08:00"). */
function wallClock(d: Date, tz: string): { date: string; time: string } {
  const off = parseUtcOffset(tz);
  if (off !== null) {
    const iso = new Date(d.getTime() + off * 60_000).toISOString();
    return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
  }
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
      .formatToParts(d).map((x) => [x.type, x.value]));
    return { date: `${p.year}-${p.month}-${p.day}`, time: `${String(Number(p.hour) % 24).padStart(2, "0")}:${p.minute}` };
  } catch {
    return wallClock(d, "UTC");
  }
}
export function localDate(d: Date, tz: string): string { return wallClock(d, tz).date; }
function localTime(d: Date, tz: string): string { return wallClock(d, tz).time; }
const hash = (s: string) => new Bun.CryptoHasher("sha1").update(s).digest("hex");
/** Normalised text for dedupe: no ids/annotations, collapsed whitespace, lower case. */
export function normalizeEntry(s: string): string {
  return s.replace(/<!--[\s\S]*?-->/g, "").replace(/^\s*[-*]\s+(\d{1,2}:\d{2}\s+)?/, "").replace(/\s+/g, " ").trim().toLowerCase();
}
/** Entry text without list marker, time stamp or HTML comments. */
export function entryText(s: string): string {
  return s.replace(/<!--[\s\S]*?-->/g, "").replace(/^\s*[-*]\s+(\d{1,2}:\d{2}\s+)?/, "").replace(/\s+/g, " ").trim();
}

/** Split a Markdown file into entries: list items (with their indented continuation) and paragraphs. */
export function chunkMarkdown(path: string, content: string): MemoryChunk[] {
  const lines = content.split("\n");
  const out: MemoryChunk[] = [];
  let cur: { start: number; lines: string[] } | undefined;
  const flush = (end: number) => {
    if (!cur) return;
    const raw = cur.lines.join("\n");
    const text = entryText(raw);
    if (text) {
      const id = raw.match(ID_RE)?.[1];
      out.push({ key: id ? `m:${id}` : `${path}#${hash(normalizeEntry(raw)).slice(0, 12)}`, path, startLine: cur.start, endLine: end, text });
    }
    cur = undefined;
  };
  lines.forEach((line, i) => {
    const n = i + 1;
    if (/^\s*#/.test(line) || !line.trim()) { flush(n - 1); return; }
    if (/^[-*]\s+/.test(line)) { flush(n - 1); cur = { start: n, lines: [line] }; return; }
    if (cur && /^\s+\S/.test(line)) { cur.lines.push(line); return; }
    if (!cur) cur = { start: n, lines: [line] }; else cur.lines.push(line);
  });
  flush(lines.length);
  const day = path.match(/^(\d{4}-\d{2}-\d{2})/)?.[1];
  return day ? out.map((c) => ({ ...c, day })) : out;
}

export class MemoryStore {
  readonly dir: string;
  readonly maxInjectBytes: number;
  private tz: string;
  private now: () => Date;

  constructor(projectDir: string, private store: StateStore, opts: MemoryOptions = {}) {
    this.dir = resolve(projectDir, opts.dir ?? "memory");
    this.maxInjectBytes = opts.maxInjectBytes ?? 24_000;
    this.tz = opts.timezone ?? "UTC";
    this.now = opts.now ?? (() => new Date());
    store.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(text, key UNINDEXED, path UNINDEXED, start_line UNINDEXED, end_line UNINDEXED, day UNINDEXED, tokenize='trigram');
      CREATE TABLE IF NOT EXISTS memory_files (path TEXT PRIMARY KEY, mtime INTEGER NOT NULL, size INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_meta (key TEXT PRIMARY KEY, origin TEXT NOT NULL, source TEXT NOT NULL, importance INTEGER, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_recall (key TEXT PRIMARY KEY, path TEXT NOT NULL, snippet TEXT NOT NULL, count INTEGER NOT NULL,
        queries TEXT NOT NULL, days TEXT NOT NULL, rel_sum REAL NOT NULL, first_at INTEGER NOT NULL, last_at INTEGER NOT NULL, promoted_at INTEGER);
    `);
  }

  today(): string { return localDate(this.now(), this.tz); }
  get timezone() { return this.tz; }
  memoryPath() { return join(this.dir, MEMORY_FILE); }
  rel(abs: string) { return relative(this.dir, abs).split(sep).join("/"); }

  /** MEMORY.md for the prompt, capped at maxInjectBytes. */
  injectText(): string {
    const p = this.memoryPath();
    if (!existsSync(p)) return "";
    const text = readFileSync(p, "utf8").trim();
    const buf = Buffer.from(text);
    if (buf.length <= this.maxInjectBytes) return text;
    const cut = buf.subarray(0, this.maxInjectBytes).toString("utf8").replace(/�$/, "");
    return `${cut.slice(0, cut.lastIndexOf("\n"))}\n\n[MEMORY.md truncated at ${this.maxInjectBytes} bytes — read the rest with memory_get("MEMORY.md")]`;
  }

  /** Indexed files: every .md under the memory dir except DREAMS.md and hidden dirs. */
  private files(): string[] {
    if (!existsSync(this.dir)) return [];
    const out: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.name.startsWith(".")) continue;
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".md") && this.rel(p) !== DREAMS_FILE && e.name.toLowerCase() !== "dreams.md") out.push(p);
      }
    };
    walk(this.dir);
    return out;
  }

  /** Re-index files whose mtime/size changed; drop deleted ones. Cheap when nothing changed. */
  reindex(): void {
    const db = this.store.db;
    const known = new Map((db.query("SELECT path, mtime, size FROM memory_files").all() as { path: string; mtime: number; size: number }[]).map((r) => [r.path, r]));
    const seen = new Set<string>();
    const tx = db.transaction(() => {
      for (const abs of this.files()) {
        const path = this.rel(abs);
        seen.add(path);
        const st = statSync(abs);
        const k = known.get(path);
        if (k && k.mtime === Math.floor(st.mtimeMs) && k.size === st.size) continue;
        db.query("DELETE FROM memory_fts WHERE path = ?").run(path);
        for (const c of chunkMarkdown(path, readFileSync(abs, "utf8"))) {
          db.query("INSERT INTO memory_fts (text, key, path, start_line, end_line, day) VALUES (?, ?, ?, ?, ?, ?)").run(c.text, c.key, c.path, c.startLine, c.endLine, c.day ?? null);
        }
        db.query("INSERT OR REPLACE INTO memory_files (path, mtime, size) VALUES (?, ?, ?)").run(path, Math.floor(st.mtimeMs), st.size);
      }
      for (const path of known.keys()) if (!seen.has(path)) {
        db.query("DELETE FROM memory_fts WHERE path = ?").run(path);
        db.query("DELETE FROM memory_files WHERE path = ?").run(path);
      }
    });
    tx();
  }

  /** Append an entry to today's daily note. Identical text already in today's note is not repeated. */
  write(text: string, o: { origin: MemoryOriginKind; source: string; importance?: number }): { path: string; key: string; duplicate: boolean } {
    const clean = text.replace(/<!--[\s\S]*?-->/g, "").trim();
    if (!clean) throw new Error("empty memory entry");
    if (clean.length > 4000) throw new Error("memory entry too long (max 4000 chars); keep entries short and factual");
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const now = this.now();
    const path = `${localDate(now, this.tz)}.md`;
    const abs = join(this.dir, path);
    const existing = existsSync(abs) ? readFileSync(abs, "utf8") : "";
    const norm = normalizeEntry(clean);
    const dup = chunkMarkdown(path, existing).find((c) => normalizeEntry(c.text) === norm);
    if (dup) return { path, key: dup.key, duplicate: true };
    const id = hash(`${now.getTime()}:${o.source}:${clean}`).slice(0, 10);
    const [first, ...rest] = clean.split("\n");
    const body = [`- ${localTime(now, this.tz)} ${first}`, ...rest.map((l) => `  ${l}`)].join("\n");
    const header = existing ? "" : `# ${localDate(now, this.tz)}\n\n`;
    // One append per entry: concurrent sessions never read-modify-write the note.
    appendFileSync(abs, `${header}${existing && !existing.endsWith("\n") ? "\n" : ""}${body} <!-- m:${id} -->\n`, { mode: 0o600 });
    const key = `m:${id}`;
    this.store.db.query("INSERT OR REPLACE INTO memory_meta (key, origin, source, importance, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(key, o.origin, o.source, o.importance ?? null, now.getTime());
    return { path, key, duplicate: false };
  }

  meta(key: string): MemoryMeta | undefined {
    const r = this.store.db.query("SELECT * FROM memory_meta WHERE key = ?").get(key) as Record<string, unknown> | null;
    return r ? { key, origin: r.origin as MemoryOriginKind, source: r.source as string, importance: r.importance as number | null, createdAt: r.created_at as number } : undefined;
  }

  /** Full-text search over indexed memory. Ranked by FTS relevance × recency (30-day half-life) × importance.
   *  A recall signal is recorded for each hit when `recall` is given (chat sessions only). */
  search(query: string, o: { limit?: number; recall?: boolean } = {}): MemoryHit[] {
    this.reindex();
    const limit = Math.min(Math.max(o.limit ?? 8, 1), 25);
    const terms = query.split(/\s+/).map((t) => t.replace(/"/g, "")).filter(Boolean);
    if (!terms.length) return [];
    const long = terms.filter((t) => [...t].length >= 3);
    const short = terms.filter((t) => [...t].length < 3);
    const db = this.store.db;
    type Row = { text: string; key: string; path: string; start_line: number; end_line: number; day: string | null; rank: number };
    let rows: Row[];
    if (long.length) {
      const match = long.map((t) => `"${t}"`).join(" OR ");
      rows = db.query(`SELECT text, key, path, start_line, end_line, day, bm25(memory_fts) AS rank FROM memory_fts WHERE memory_fts MATCH ? ORDER BY rank LIMIT 200`).all(match) as Row[];
    } else {
      // Trigram needs ≥3 characters; short (e.g. two-character CJK) queries fall back to LIKE.
      rows = db.query(`SELECT text, key, path, start_line, end_line, day, 0 AS rank FROM memory_fts WHERE ${short.map(() => "text LIKE ?").join(" OR ")} LIMIT 200`)
        .all(...short.map((s) => `%${s}%`)) as Row[];
    }
    const nowMs = this.now().getTime();
    // bm25 is negative (more negative = better) and unbounded: normalise within this result set.
    const best = Math.max(0, ...rows.map((r) => -r.rank));
    const scored = rows.map((r) => {
      const rel = best > 0 ? Math.max(0, -r.rank) / best : 1;
      const ageDays = r.day ? Math.max(0, (nowMs - Date.parse(`${r.day}T00:00:00Z`)) / DAY_MS) : 0;
      const recency = r.day ? 0.5 ** (ageDays / 30) : 1;
      const imp = this.meta(r.key)?.importance;
      const impMul = imp ? 0.75 + imp / 20 : 1;
      return { key: r.key, path: r.path, startLine: r.start_line, endLine: r.end_line, text: r.text, ...(r.day ? { day: r.day } : {}), score: rel * (0.5 + 0.5 * recency) * impMul };
    }).sort((a, b) => b.score - a.score).slice(0, limit);
    if (o.recall) this.recordRecall(query, scored);
    return scored;
  }

  private recordRecall(query: string, hits: MemoryHit[]) {
    const db = this.store.db;
    const q = hash(query.trim().toLowerCase().replace(/\s+/g, " ")).slice(0, 12);
    const day = this.today();
    const now = this.now().getTime();
    const tx = db.transaction(() => {
      hits.forEach((h, rank) => {
        if (h.path === MEMORY_FILE) return; // already long-term
        const rel = 1 / (1 + rank);
        const r = db.query("SELECT queries, days FROM memory_recall WHERE key = ?").get(h.key) as { queries: string; days: string } | null;
        if (!r) {
          db.query("INSERT INTO memory_recall (key, path, snippet, count, queries, days, rel_sum, first_at, last_at, promoted_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, NULL)")
            .run(h.key, h.path, h.text.slice(0, 500), JSON.stringify([q]), JSON.stringify([day]), rel, now, now);
        } else {
          const qs = new Set(JSON.parse(r.queries) as string[]); qs.add(q);
          const ds = new Set(JSON.parse(r.days) as string[]); ds.add(day);
          db.query("UPDATE memory_recall SET path = ?, snippet = ?, count = count + 1, queries = ?, days = ?, rel_sum = rel_sum + ?, last_at = ? WHERE key = ?")
            .run(h.path, h.text.slice(0, 500), JSON.stringify([...qs].slice(-50)), JSON.stringify([...ds].slice(-60)), rel, now, h.key);
        }
      });
    });
    tx();
  }

  recall(key: string): RecallRow | undefined {
    const r = this.store.db.query("SELECT * FROM memory_recall WHERE key = ?").get(key) as Record<string, unknown> | null;
    return r ? this.toRecall(r) : undefined;
  }
  recallRows(): RecallRow[] {
    return (this.store.db.query("SELECT * FROM memory_recall").all() as Record<string, unknown>[]).map((r) => this.toRecall(r));
  }
  markPromoted(keys: string[]) {
    const now = this.now().getTime();
    for (const k of keys) this.store.db.query("UPDATE memory_recall SET promoted_at = ? WHERE key = ?").run(now, k);
  }
  private toRecall(r: Record<string, unknown>): RecallRow {
    return { key: r.key as string, path: r.path as string, snippet: r.snippet as string, count: r.count as number,
      queries: JSON.parse(r.queries as string), days: JSON.parse(r.days as string), relSum: r.rel_sum as number,
      firstAt: r.first_at as number, lastAt: r.last_at as number, promotedAt: (r.promoted_at as number | null) ?? null };
  }

  /** All indexed chunks of daily notes on or after `sinceDay`. */
  dailyChunks(sinceDay: string): MemoryChunk[] {
    this.reindex();
    type Row = { text: string; key: string; path: string; start_line: number; end_line: number; day: string };
    return (this.store.db.query("SELECT text, key, path, start_line, end_line, day FROM memory_fts WHERE day IS NOT NULL AND day >= ?").all(sinceDay) as Row[])
      .filter((r) => DAILY_RE.test(r.path))
      .map((r) => ({ key: r.key, path: r.path, startLine: r.start_line, endLine: r.end_line, text: r.text, day: r.day }));
  }

  /** Locate a chunk in its live file (rehydrate): by id comment, else by content hash. Undefined if gone. */
  locate(key: string, path: string): MemoryChunk | undefined {
    const abs = join(this.dir, path);
    if (!existsSync(abs)) return undefined;
    return chunkMarkdown(path, readFileSync(abs, "utf8")).find((c) => c.key === key);
  }

  /** Read a memory file (or a line range). Paths are relative to the memory dir and cannot leave it. */
  get(path: string, from?: number, lines?: number): string {
    const abs = resolve(this.dir, path);
    if (abs !== this.dir && !abs.startsWith(this.dir + sep)) throw new Error("path is outside the memory directory");
    if (!existsSync(abs) || !statSync(abs).isFile()) throw new Error(`no memory file "${path}"`);
    const all = readFileSync(abs, "utf8").split("\n");
    const start = Math.max(1, from ?? 1);
    const n = Math.min(Math.max(lines ?? 200, 1), 1000);
    const slice = all.slice(start - 1, start - 1 + n);
    const more = start - 1 + n < all.length ? `\n[… ${all.length - (start - 1 + n)} more lines; continue with from=${start + n}]` : "";
    return slice.join("\n") + more;
  }

  /** MCP tools. `classify` tells who the calling session is; `canWrite` false hides nothing but refuses writes. */
  tools(classify: (caller: string) => MemoryOriginKind, canWrite: (caller: string) => boolean = () => true): GatewayTool[] {
    return [
      {
        name: "memory_write",
        description: "Save something worth remembering to today's daily note in UniQlaw memory (shared by all sessions of this assistant). "
          + "Write one short, self-contained fact, decision, preference or observation per call, with enough context to make sense later. "
          + "importance 1-10 (optional): how much it matters long-term (8+ = should become long-term memory).",
        inputSchema: { text: z.string(), importance: z.number().int().min(1).max(10).optional() },
        handler: async (a, caller) => {
          if (!canWrite(caller)) throw new Error("this session cannot write memory");
          const r = this.write(String(a.text), { origin: classify(caller), source: caller, ...(typeof a.importance === "number" ? { importance: a.importance } : {}) });
          return r.duplicate ? { saved: false, reason: "already in today's note", path: `memory/${r.path}` } : { saved: true, path: `memory/${r.path}` };
        },
      },
      {
        name: "memory_search",
        description: "Search UniQlaw memory (daily notes, topic files, MEMORY.md) by keywords. Use it before answering about past conversations, "
          + "decisions, people or preferences that aren't in your context. Matching is by substring (works for Chinese/Japanese); use 2-3 distinctive words.",
        inputSchema: { query: z.string(), limit: z.number().int().min(1).max(25).optional() },
        handler: async (a, caller) => {
          const hits = this.search(String(a.query), { ...(typeof a.limit === "number" ? { limit: a.limit } : {}), recall: classify(caller) === "chat" });
          if (!hits.length) return "no matches";
          return hits.map((h) => ({ ref: `memory/${h.path}#L${h.startLine}-L${h.endLine}`, text: h.text }));
        },
      },
      {
        name: "memory_get",
        description: "Read a UniQlaw memory file or a line range, e.g. path \"MEMORY.md\" or \"2026-11-08.md\" (relative to the memory directory).",
        inputSchema: { path: z.string(), from: z.number().int().min(1).optional(), lines: z.number().int().min(1).max(1000).optional() },
        handler: async (a) => this.get(String(a.path).replace(/^memory\//, ""), a.from as number | undefined, a.lines as number | undefined),
      },
    ];
  }
}
