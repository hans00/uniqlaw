// Local wall-clock fields for a timezone given as "UTC±H[:MM]" / "+08:00" or an IANA name.
import { parseUtcOffset } from "@uniqlaw/core";

export interface LocalFields { minute: number; hour: number; day: number; month: number; weekday: number }

export function localFields(d: Date, tz: string): LocalFields {
  const off = parseUtcOffset(tz);
  if (off !== null) {
    const s = new Date(d.getTime() + off * 60_000);
    return { minute: s.getUTCMinutes(), hour: s.getUTCHours(), day: s.getUTCDate(), month: s.getUTCMonth() + 1, weekday: s.getUTCDay() };
  }
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour12: false, minute: "numeric", hour: "numeric", day: "numeric", month: "numeric", weekday: "short" })
      .formatToParts(d).map((p) => [p.type, p.value]));
    const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday!);
    return { minute: Number(parts.minute), hour: Number(parts.hour) % 24, day: Number(parts.day), month: Number(parts.month), weekday: wd };
  } catch {
    return localFields(d, "UTC");
  }
}

export function minutesOfDay(d: Date, tz: string) { const f = localFields(d, tz); return f.hour * 60 + f.minute; }
