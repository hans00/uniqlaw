// Provider-agnostic, bounded per-session transcript (for the web dashboard).
// Stored in state.db table `transcript`; each session keeps its last `max` entries.
import type { StateStore } from "./state.ts";

export type TranscriptKind = "prompt" | "assistant" | "tool" | "permission" | "turn_end" | "system";

export interface TranscriptEntry {
  id: number;
  channelKey: string;
  at: number;
  kind: TranscriptKind;
  text: string;
  meta?: Record<string, unknown>;
}

export class TranscriptStore {
  constructor(private store: StateStore, private max = 500) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS transcript (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_key TEXT NOT NULL,
      at INTEGER NOT NULL,
      kind TEXT NOT NULL,
      text TEXT NOT NULL,
      meta TEXT
    );
    CREATE INDEX IF NOT EXISTS transcript_key ON transcript(channel_key, id);`);
  }

  append(channelKey: string, kind: TranscriptKind, text: string, meta?: Record<string, unknown>) {
    const db = this.store.db;
    db.query("INSERT INTO transcript (channel_key, at, kind, text, meta) VALUES (?, ?, ?, ?, ?)")
      .run(channelKey, Date.now(), kind, text.length > 20_000 ? text.slice(0, 20_000) + "…" : text, meta ? JSON.stringify(meta) : null);
    db.query(`DELETE FROM transcript WHERE channel_key = ? AND id <= (
      SELECT id FROM transcript WHERE channel_key = ? ORDER BY id DESC LIMIT 1 OFFSET ?)`).run(channelKey, channelKey, this.max);
  }

  list(channelKey: string, limit = this.max, afterId = 0): TranscriptEntry[] {
    const rows = this.store.db.query("SELECT * FROM transcript WHERE channel_key = ? AND id > ? ORDER BY id DESC LIMIT ?")
      .all(channelKey, afterId, limit) as Record<string, unknown>[];
    return rows.reverse().map((r) => ({
      id: r.id as number, channelKey: r.channel_key as string, at: r.at as number, kind: r.kind as TranscriptKind,
      text: r.text as string, ...(r.meta ? { meta: JSON.parse(r.meta as string) } : {}),
    }));
  }
}

/** Runtime events for live UIs (SSE). */
export type RuntimeEvent =
  | { type: "state"; channelKey: string; state: string; at: number }
  | { type: "turn_start"; channelKey: string; at: number }
  | { type: "turn_end"; channelKey: string; reason: string; error?: string; at: number }
  | { type: "transcript"; channelKey: string; entry: Omit<TranscriptEntry, "id"> };
