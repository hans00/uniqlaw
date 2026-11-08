// Heartbeat: periodic ambient prompt into a session (default: its own internal session
// "heartbeat"), skipped during quiet hours and while that session is busy. Port of v2 heartbeat.ts.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { definePlugin, type Logger, type Scheduler, type SchedulerApi } from "@uniqlaw/core";
import { minutesOfDay } from "./time.ts";

export const DEFAULT_HEARTBEAT_TEMPLATE = "Review pending tasks, reminders, and anything your human asked you to follow up on. If something needs attention, text them about it — casually, like a real person would. Short, natural, the way you'd message a friend. No formal updates, no bullet points, no \"just checking in.\" Your message shows up in their chat out of nowhere, so it should read like you genuinely thought of something and hit send. If nothing needs attention, reply `HEARTBEAT_OK`. Don't force it.";

const window = z.object({ start: z.string().regex(/^\d{1,2}:\d{2}$/), end: z.string().regex(/^\d{1,2}:\d{2}$/) });
export const heartbeatConfigSchema = z.object({
  /** Minutes between fires. */
  interval: z.number().positive().default(60),
  /** Extra user prompt appended to the template. */
  prompt: z.string().default(""),
  /** Template file (relative to project); falls back to the built-in template. */
  templateFile: z.string().default("prompts/heartbeat/HEARTBEAT.md"),
  /** Session that runs it: an internal name ("heartbeat") or a chat key ("telegram:<chatId>"). */
  target: z.string().default("heartbeat"),
  /** Where the final reply goes, e.g. "telegram:<chatId>"; "none" = nowhere (the agent uses
   *  notify / agent_trigger itself); default = backgroundNotify policy. */
  replyTo: z.string().optional(),
  /** Pin the heartbeat session to this profile (provider + model + permissions). */
  profile: z.string().optional(),
  /** Run heartbeat turns on this model (live model switch; use `profile` for spawn-only providers). */
  model: z.string().optional(),
  excludeWindows: z.array(window).default([]),
}).passthrough(); // tolerate migrated keys (v2Enabled)

export function inExcludeWindow(now: Date, windows: { start: string; end: string }[], tz: string): boolean {
  const cur = minutesOfDay(now, tz);
  for (const w of windows) {
    const [sh, sm] = w.start.split(":").map(Number); const [eh, em] = w.end.split(":").map(Number);
    const s = sh! * 60 + sm!, e = eh! * 60 + em!;
    if (s === e) continue;
    if (s < e ? cur >= s && cur < e : cur >= s || cur < e) return true;
  }
  return false;
}

export class HeartbeatScheduler implements Scheduler {
  private timer?: ReturnType<typeof setInterval>;
  private api?: SchedulerApi;
  constructor(private cfg: z.infer<typeof heartbeatConfigSchema>, private projectDir: string, private tz: string, private log: Logger, private now: () => Date = () => new Date()) {}

  start(api: SchedulerApi) {
    this.api = api;
    if (!api.kvGet("heartbeat:lastFiredAt")) api.kvSet("heartbeat:lastFiredAt", String(this.now().getTime()));
    this.timer = setInterval(() => void this.tick(), 60_000);
    this.log.info("heartbeat started", { interval: this.cfg.interval, target: this.cfg.target });
  }
  stop() { clearInterval(this.timer); }

  prompt(): string {
    const p = resolve(this.projectDir, this.cfg.templateFile);
    const tpl = (existsSync(p) ? readFileSync(p, "utf8").trim() : "") || DEFAULT_HEARTBEAT_TEMPLATE;
    return this.cfg.prompt.trim() ? `${tpl}\n\nUser custom heartbeat prompt:\n${this.cfg.prompt.trim()}` : tpl;
  }

  /** Returns true if it fired. */
  async tick(at = this.now()): Promise<boolean> {
    const api = this.api!;
    const last = Number(api.kvGet("heartbeat:lastFiredAt") ?? 0);
    if (at.getTime() - last < this.cfg.interval * 60_000) return false;
    if (inExcludeWindow(at, this.cfg.excludeWindows, this.tz)) return false; // fire right after quiet hours end
    if (api.isBusy(this.cfg.target)) return false;
    api.kvSet("heartbeat:lastFiredAt", String(at.getTime()));
    await api.fire({ channelKey: this.cfg.target, job: "heartbeat", text: this.prompt(), raw: true, deliverTo: this.cfg.replyTo, sourceLine: "[heartbeat]",
      ...(this.cfg.profile ? { profile: this.cfg.profile } : {}), ...(this.cfg.model ? { model: this.cfg.model } : {}) })
      .catch((e) => this.log.error("heartbeat fire failed", { e: String(e) }));
    return true;
  }
}

export default definePlugin({
  kind: "scheduler", name: "heartbeat", configSchema: heartbeatConfigSchema,
  create: (ctx, cfg) => new HeartbeatScheduler(cfg, ctx.projectDir, ctx.timezone, ctx.log),
});
