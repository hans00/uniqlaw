// 5-field cron (minute hour day-of-month month day-of-week): * */N a-b a-b/N lists. Port of v2 cron.ts.
import { localFields } from "./time.ts";

function matchField(field: string, value: number): boolean {
  for (const part of field.split(",")) {
    const [range, stepStr] = part.split("/");
    const step = stepStr ? parseInt(stepStr) : 1;
    if (!range || !Number.isFinite(step) || step <= 0) continue;
    if (range === "*") { if (value % step === 0) return true; continue; }
    if (range.includes("-")) {
      const [lo, hi] = range.split("-").map(Number);
      if (lo !== undefined && hi !== undefined && value >= lo && value <= hi && (value - lo) % step === 0) return true;
      continue;
    }
    if (parseInt(range) === value) return true;
  }
  return false;
}

export function isValidCron(expr: string): boolean {
  const f = expr.trim().split(/\s+/);
  return f.length === 5 && f.every((x) => /^[\d*,\-/]+$/.test(x));
}

export function cronMatches(expr: string, date: Date, tz = "UTC"): boolean {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) return false;
  const d = localFields(date, tz);
  // POSIX: Sunday may be written 0 or 7
  const dow = f[4]!.replace(/\b7\b/g, "0");
  return matchField(f[0]!, d.minute) && matchField(f[1]!, d.hour) && matchField(f[2]!, d.day) && matchField(f[3]!, d.month) && matchField(dow, d.weekday);
}

/** Minute-aligned occurrences in (from, to]. Capped to avoid runaway loops. */
export function occurrencesBetween(expr: string, from: Date, to: Date, tz = "UTC", cap = 1000): Date[] {
  const out: Date[] = [];
  const d = new Date(from); d.setSeconds(0, 0); d.setMinutes(d.getMinutes() + 1);
  while (d <= to && out.length < cap) {
    if (cronMatches(expr, d, tz)) out.push(new Date(d));
    d.setMinutes(d.getMinutes() + 1);
  }
  return out;
}

export function nextMatch(expr: string, after: Date, tz = "UTC"): Date | undefined {
  const d = new Date(after); d.setSeconds(0, 0);
  for (let i = 0; i < 366 * 24 * 60; i++) {
    d.setMinutes(d.getMinutes() + 1);
    if (cronMatches(expr, d, tz)) return d;
  }
  return undefined;
}
