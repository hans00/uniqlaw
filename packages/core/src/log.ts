import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Logger } from "./plugin.ts";

type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(opts: { file?: string; level?: Level; stderr?: boolean } = {}, scope = "uniqlaw"): Logger {
  const min = ORDER[opts.level ?? ((process.env.UNIQLAW_LOG_LEVEL as Level) || "info")];
  if (opts.file) mkdirSync(dirname(opts.file), { recursive: true });
  const write = (level: Level, msg: string, extra?: Record<string, unknown>) => {
    if (ORDER[level] < min) return;
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}${extra ? " " + safeJson(extra) : ""}`;
    if (opts.file) appendFileSync(opts.file, line + "\n");
    if (opts.stderr ?? !opts.file) console.error(line);
  };
  return {
    debug: (m, e) => write("debug", m, e),
    info: (m, e) => write("info", m, e),
    warn: (m, e) => write("warn", m, e),
    error: (m, e) => write("error", m, e),
    child: (s) => createLogger(opts, `${scope}:${s}`),
  };
}

function safeJson(v: unknown): string {
  try { return JSON.stringify(v, (_k, x) => (x instanceof Error ? { message: x.message, stack: x.stack } : x)); }
  catch { return String(v); }
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silentLogger };
