// Claude Code session jsonl: locate by id, incremental tail, parse.
// Shared by claude-tmux and claude-sdk (same file format, M0 interop verified).
import { readdirSync, existsSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export type JsonlEventType =
  | "user-message" | "user-tool-result" | "assistant-text" | "assistant-tool-use"
  | "assistant-thinking" | "turn-end" | "stop-hook-summary" | "system" | "unknown";

export interface JsonlEvent {
  type: JsonlEventType;
  raw: any;
  msgId?: string;
  uuid?: string;
  timestamp?: string;
  stopReason?: string;
  /** turn-end only: thinking-only line carrying end_turn — the turn may continue. */
  tentative?: boolean;
  /** Index of the content block inside the assistant line (segment id helper). */
  blockIndex?: number;
  text?: string;
  model?: string;
  toolName?: string;
  toolInput?: unknown;
  toolUseId?: string;
  toolResult?: string;
  toolResultIsError?: boolean;
  userText?: string;
  /** user-message: entry is a meta/system injection (isMeta, attachments, queued_command…). */
  isMeta?: boolean;
}

/** `~/.claude` or `$CLAUDE_CONFIG_DIR`. */
export function claudeConfigDir(env: Record<string, string | undefined> = process.env): string {
  return env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), ".claude");
}

/** Claude Code's cwd → project dir encoding. */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

export function expectedJsonlPath(sessionId: string, cwd: string, env?: Record<string, string | undefined>): string {
  return join(claudeConfigDir(env), "projects", encodeProjectDir(cwd), `${sessionId}.jsonl`);
}

/** Find a session file by id under any project dir (resume from another cwd appends to the original file). */
export function locateJsonl(sessionId: string, env?: Record<string, string | undefined>): string | undefined {
  const root = join(claudeConfigDir(env), "projects");
  if (!existsSync(root)) return undefined;
  for (const d of readdirSync(root)) {
    const p = join(root, d, `${sessionId}.jsonl`);
    if (existsSync(p)) return p;
  }
  return undefined;
}

export function parseLine(line: string): JsonlEvent[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  let raw: any;
  try { raw = JSON.parse(trimmed); } catch { return [{ type: "unknown", raw: { rawLine: line } }]; }
  const type = raw.type;
  const uuid = typeof raw.uuid === "string" ? raw.uuid : undefined;
  const timestamp = typeof raw.timestamp === "string" ? raw.timestamp : undefined;
  const msg = raw.message;
  const events: JsonlEvent[] = [];

  if (type === "assistant" && msg && typeof msg === "object") {
    const msgId: string | undefined = typeof msg.id === "string" ? msg.id : undefined;
    const stopReason: string | undefined = typeof msg.stop_reason === "string" ? msg.stop_reason : undefined;
    const model: string | undefined = typeof msg.model === "string" ? msg.model : undefined;
    const content = Array.isArray(msg.content) ? msg.content : [];
    content.forEach((item: any, blockIndex: number) => {
      if (!item || typeof item !== "object") return;
      const base = { raw, msgId, uuid, timestamp, stopReason, model, blockIndex };
      if (item.type === "text" && typeof item.text === "string") events.push({ ...base, type: "assistant-text", text: item.text });
      else if (item.type === "tool_use") events.push({ ...base, type: "assistant-tool-use", toolName: item.name, toolInput: item.input, toolUseId: item.id });
      else if (item.type === "thinking") events.push({ ...base, type: "assistant-thinking", text: typeof item.thinking === "string" ? item.thinking : "" });
    });
    if (stopReason === "end_turn") {
      const thinkingOnly = content.length > 0 && content.every((i: any) => i?.type === "thinking");
      events.push({ type: "turn-end", raw, msgId, uuid, timestamp, stopReason, ...(thinkingOnly ? { tentative: true } : {}) });
    }
    return events;
  }

  if (type === "user" && msg && typeof msg === "object") {
    const isMeta = raw.isMeta === true;
    const content = msg.content;
    if (typeof content === "string") return [{ type: "user-message", raw, uuid, timestamp, userText: content, isMeta }];
    if (Array.isArray(content)) {
      for (const item of content) {
        if (!item || typeof item !== "object") continue;
        if (item.type === "tool_result") {
          const text = typeof item.content === "string" ? item.content
            : Array.isArray(item.content) ? item.content.map((c: any) => (typeof c?.text === "string" ? c.text : "")).join("") : "";
          events.push({ type: "user-tool-result", raw, uuid, timestamp, toolUseId: item.tool_use_id, toolResult: text, toolResultIsError: item.is_error === true });
        } else if (item.type === "text" && typeof item.text === "string") {
          events.push({ type: "user-message", raw, uuid, timestamp, userText: item.text, isMeta });
        }
      }
      return events;
    }
  }

  if (type === "system" && raw.subtype === "stop_hook_summary") return [{ type: "stop-hook-summary", raw, uuid, timestamp }];
  return [{ type: "system", raw, uuid, timestamp }];
}

/** Lines we never parse: huge request blobs (a 2-turn session was ~650 KB). */
function isSkippableLine(line: string): boolean {
  return line.length > 200_000 || line.startsWith('{"type":"api-request-blob"');
}

export interface TailerOptions {
  /** Resolve the file path (called until it returns a path). */
  locate: () => string | undefined;
  /** Where to start once the file is found: "end" (attach/resume) or "start" (new session). */
  startAt: "start" | "end";
  onEvent: (ev: JsonlEvent) => void;
  onError?: (err: unknown) => void;
  pollMs?: number;
}

/**
 * Polling tailer (fs.watch is unreliable across platforms). Reads only new
 * bytes; never re-reads from the start; buffers partial lines.
 */
export class JsonlTailer {
  private path: string | undefined;
  private pos = 0;
  private buf = "";
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  lastActivityAt = 0;

  constructor(private opts: TailerOptions) {}

  get file(): string | undefined { return this.path; }

  start() {
    if (this.timer) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), this.opts.pollMs ?? 250);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Force an immediate read (e.g. before deciding a turn ended). */
  flush() { this.tick(); }

  private tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      if (!this.path) {
        const p = this.opts.locate();
        if (!p) return;
        this.path = p;
        this.pos = this.opts.startAt === "end" ? statSync(p).size : 0;
      }
      const size = statSync(this.path).size;
      if (size < this.pos) { this.pos = 0; this.buf = ""; }
      if (size === this.pos) return;
      const fd = openSync(this.path, "r");
      try {
        const len = size - this.pos;
        const b = Buffer.alloc(len);
        const n = readSync(fd, b, 0, len, this.pos);
        this.pos += n;
        this.buf += b.subarray(0, n).toString("utf8");
      } finally { closeSync(fd); }
      let nl: number;
      while ((nl = this.buf.indexOf("\n")) !== -1) {
        const line = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + 1);
        if (isSkippableLine(line)) continue;
        this.lastActivityAt = Date.now();
        for (const ev of parseLine(line)) {
          try { this.opts.onEvent(ev); } catch (e) { this.opts.onError?.(e); }
        }
      }
    } catch (e) {
      this.opts.onError?.(e);
    } finally {
      this.busy = false;
    }
  }
}
