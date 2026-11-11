// Cron scheduler plugin: fires `.uniqlaw/jobs/*.md` (re-read every tick, so the agent can
// add/edit jobs by writing files). Optional catch-up for occurrences missed while down.
import { resolve } from "node:path";
import { unlinkSync } from "node:fs";
import { z } from "zod";
import { definePlugin, type GatewayTool, type Logger, type Scheduler, type SchedulerApi } from "@uniqlaw/core";
import { cronMatches, occurrencesBetween } from "./cron.ts";
import { defaultJobTarget, deleteJob, loadJobs, saveJob, type Job } from "./jobs.ts";
import { isValidCron, nextMatch } from "./cron.ts";

export const cronConfigSchema = z.object({
  /** Jobs directory (relative to the project). */
  dir: z.string().default(".uniqlaw/jobs"),
  /** Fire ONE catch-up run for jobs whose last occurrence was missed within this window (0 = off). */
  catchUpHours: z.number().nonnegative().default(0),
});

/** A gap this short since the previous process's last tick is a restart/reload: its missed occurrences fire once
 *  even with catchUpHours 0 (a job due while the daemon restarted must not be dropped). */
export const RESTART_GAP_MS = 15 * 60_000;
const LAST_TICK_KEY = "cron:__lastTick";

export class CronScheduler implements Scheduler {
  private timer?: ReturnType<typeof setTimeout>;
  private api?: SchedulerApi;
  private warned = new Set<string>();
  constructor(private dir: string, private cfg: z.infer<typeof cronConfigSchema>, private tz: string, private log: Logger, private now: () => Date = () => new Date()) {}

  start(api: SchedulerApi) {
    this.api = api;
    const lastTick = Number(api.kvGet(LAST_TICK_KEY) ?? 0) * 60_000;
    if (this.cfg.catchUpHours > 0) void this.catchUp();
    else if (lastTick && this.now().getTime() - lastTick <= RESTART_GAP_MS) void this.catchUpGap(new Date(lastTick));
    const n = this.now();
    const ms = (60 - n.getSeconds()) * 1000 - n.getMilliseconds();
    this.timer = setTimeout(() => this.loop(), ms);
    this.log.info("cron started", { dir: this.dir, firstTickInSec: Math.round(ms / 1000) });
  }
  stop() { clearTimeout(this.timer); }

  private loop() {
    void this.tick();
    const n = this.now();
    this.timer = setTimeout(() => this.loop(), (60 - n.getSeconds()) * 1000 - n.getMilliseconds() || 60_000);
  }

  jobs(): Job[] {
    return loadJobs(this.dir, (f, err) => { if (!this.warned.has(f + err)) { this.warned.add(f + err); this.log.warn("bad job file", { file: f, err }); } });
  }

  /** MCP tools so agents manage jobs with validation instead of hand-writing files. */
  tools(): GatewayTool[] {
    return [
      { name: "cron_list", description: "List scheduled jobs (name, schedule, target, replyTo, profile, model, next run).", inputSchema: {},
        handler: async () => this.jobs().map((j) => ({ name: j.name, schedule: j.schedule, recurring: j.recurring, target: j.target,
          replyTo: j.replyTo, profile: j.profile, model: j.model, timezone: j.timezone ?? this.tz, next: nextMatch(j.schedule, this.now(), j.timezone ?? this.tz)?.toISOString(), prompt: j.body })) },
      { name: "cron_save",
        description: "Create or replace a scheduled job. schedule = 5-field cron. target = session that runs it: default you; \"own\" = a separate internal session \"cron:<name>\" (clean context, no chat). replyTo = chat target for its final reply, e.g. \"telegram:<chatId>\", or \"none\" (deliver with notify/agent_trigger yourself); default: background-notify policy. model = run the job on this model; profile = pin the job's session to a configured profile.",
        inputSchema: { name: z.string().regex(/^[a-zA-Z0-9._-]+$/), schedule: z.string(), prompt: z.string(), recurring: z.boolean().optional(),
          target: z.string().optional(), replyTo: z.string().optional(), timezone: z.string().optional(),
          model: z.string().optional(), profile: z.string().optional() },
        handler: async (a, caller) => {
          const schedule = String(a.schedule);
          if (!isValidCron(schedule)) throw new Error(`invalid cron "${schedule}" (need 5 fields: minute hour day month weekday)`);
          const tz = (a.timezone as string | undefined) ?? undefined;
          const name = String(a.name);
          const t = a.target as string | undefined;
          saveJob(this.dir, name, { schedule, recurring: a.recurring !== false, target: t === "own" ? defaultJobTarget(name) : t ?? caller,
            replyTo: a.replyTo as string | undefined, timezone: tz, body: String(a.prompt),
            model: a.model as string | undefined, profile: a.profile as string | undefined });
          return { saved: a.name, next: nextMatch(schedule, this.now(), tz ?? this.tz)?.toISOString() };
        } },
      { name: "cron_delete", description: "Delete a scheduled job by name.", inputSchema: { name: z.string() },
        handler: async (a) => ({ deleted: deleteJob(this.dir, String(a.name)) }) },
    ];
  }

  async tick(at = this.now()): Promise<string[]> {
    const fired: string[] = [];
    const minute = Math.floor(at.getTime() / 60_000);
    this.api!.kvSet(LAST_TICK_KEY, String(minute));
    for (const job of this.jobs()) {
      if (!cronMatches(job.schedule, at, job.timezone ?? this.tz)) continue;
      if (Number(this.api!.kvGet(`cron:${job.name}:minute`)) === minute) continue; // already fired this minute
      this.api!.kvSet(`cron:${job.name}:minute`, String(minute));
      await this.fire(job, false);
      fired.push(job.name);
    }
    return fired;
  }

  async catchUp(at = this.now()): Promise<string[]> {
    const fired: string[] = [];
    const windowStart = new Date(at.getTime() - this.cfg.catchUpHours * 3600_000);
    for (const job of this.jobs()) {
      const last = Number(this.api!.kvGet(`cron:${job.name}:minute`) ?? 0) * 60_000;
      const from = new Date(Math.max(last, windowStart.getTime()));
      const missed = occurrencesBetween(job.schedule, from, new Date(at.getTime() - 60_000), job.timezone ?? this.tz);
      if (!missed.length) continue;
      this.api!.kvSet(`cron:${job.name}:minute`, String(Math.floor(missed.at(-1)!.getTime() / 60_000)));
      await this.fire(job, true, missed.length);
      fired.push(job.name);
    }
    return fired;
  }

  /** Occurrences in (lastTick, now] that didn't fire because the daemon was restarting (the current minute
   *  included: the first tick only comes at the next minute boundary). */
  async catchUpGap(lastTick: Date, at = this.now()): Promise<string[]> {
    const fired: string[] = [];
    for (const job of this.jobs()) {
      const last = Number(this.api!.kvGet(`cron:${job.name}:minute`) ?? 0) * 60_000;
      const missed = occurrencesBetween(job.schedule, new Date(Math.max(last, lastTick.getTime())), at, job.timezone ?? this.tz);
      if (!missed.length) continue;
      this.api!.kvSet(`cron:${job.name}:minute`, String(Math.floor(missed.at(-1)!.getTime() / 60_000)));
      await this.fire(job, true, missed.length);
      fired.push(job.name);
    }
    return fired;
  }

  private async fire(job: Job, catchUp: boolean, missed = 0) {
    this.log.info("firing job", { job: job.name, target: job.target, catchUp });
    const tag = catchUp ? `catch-up · cron (missed ${missed}× while UniQlaw was down)` : "scheduled · cron";
    try {
      await this.api!.fire({ channelKey: job.target, job: job.name, text: job.body, deliverTo: job.replyTo,
        sourceLine: `[${tag} · ${job.name} (${job.schedule})]`,
        ...(job.profile ? { profile: job.profile } : {}), ...(job.model ? { model: job.model } : {}) });
    } catch (e) { this.log.error("job fire failed", { job: job.name, e: String(e) }); }
    if (!job.recurring) { try { unlinkSync(job.filePath); this.log.info("one-shot job removed", { job: job.name }); } catch {} }
  }
}

export default definePlugin({
  kind: "scheduler", name: "cron", configSchema: cronConfigSchema,
  create: (ctx, cfg) => new CronScheduler(resolve(ctx.projectDir, cfg.dir), cfg, ctx.timezone, ctx.log),
});
