// Dreaming: nightly consolidation of UniQlaw memory (daily notes → MEMORY.md) plus a dream diary.
// The engine lives in core (runDreamSweep); this plugin schedules it and runs its two model turns
// in the internal session "dream" (fresh context each time, optional profile/model).
import { z } from "zod";
import { DEFAULT_DREAMING, definePlugin, runDreamSweep, type DreamReport, type DreamingThresholds, type Logger, type Scheduler, type SchedulerApi } from "@uniqlaw/core";
import { isValidCron, cronMatches } from "./cron.ts";

export const DREAM_SESSION = "dream";

const d = DEFAULT_DREAMING;
export const dreamingConfigSchema = z.object({
  /** 5-field cron in `timezone` (default: settings.timezone). */
  schedule: z.string().refine(isValidCron, "invalid cron expression").default("0 3 * * *"),
  timezone: z.string().optional(),
  /** Profile for the dream turns. Use one with permissions.level "locked": these turns need no tools. */
  profile: z.string().optional(),
  model: z.string().optional(),
  /** Write a diary entry to memory/DREAMS.md. */
  diary: z.boolean().default(true),
  /** Tell open chat sessions when MEMORY.md changed (their prompt still has the old copy). */
  notifySessions: z.boolean().default(true),
  timeoutSec: z.number().int().positive().default(600),
  lookbackDays: z.number().int().positive().default(d.lookbackDays),
  minScore: z.number().min(0).max(1).default(d.minScore),
  minRecallCount: z.number().int().nonnegative().default(d.minRecallCount),
  minUniqueQueries: z.number().int().nonnegative().default(d.minUniqueQueries),
  recurrenceDays: z.number().int().nonnegative().default(d.recurrenceDays),
  minImportance: z.number().int().min(0).max(10).default(d.minImportance),
  maxCandidates: z.number().int().positive().default(d.maxCandidates),
  maxLossFraction: z.number().min(0).max(1).default(d.maxLossFraction),
  maxEntryChars: z.number().int().positive().default(d.maxEntryChars),
  historyKeep: z.number().int().nonnegative().default(d.historyKeep),
});
export type DreamingConfig = z.infer<typeof dreamingConfigSchema>;

export function thresholdsOf(c: DreamingConfig): DreamingThresholds {
  const { lookbackDays, minScore, minRecallCount, minUniqueQueries, recurrenceDays, minImportance, maxCandidates, maxLossFraction, maxEntryChars, historyKeep } = c;
  return { lookbackDays, minScore, minRecallCount, minUniqueQueries, recurrenceDays, minImportance, maxCandidates, maxLossFraction, maxEntryChars, historyKeep };
}

export class DreamingScheduler implements Scheduler {
  private timer?: ReturnType<typeof setInterval>;
  private api?: SchedulerApi;
  private running?: Promise<DreamReport>;
  constructor(private cfg: DreamingConfig, private tz: string, private log: Logger, private now: () => Date = () => new Date()) {}

  start(api: SchedulerApi) {
    this.api = api;
    if (!api.memory) { this.log.warn("dreaming needs UniQlaw memory (settings.memory.enabled); not scheduling"); return; }
    if (!api.complete) { this.log.warn("dreaming: this daemon cannot run model turns for plugins; not scheduling"); return; }
    this.timer = setInterval(() => void this.tick(), 60_000);
    this.log.info("dreaming scheduled", { schedule: this.cfg.schedule, timezone: this.cfg.timezone ?? this.tz });
  }
  stop() { clearInterval(this.timer); }

  /** Fires at most once per matching minute. */
  async tick(at = this.now()): Promise<boolean> {
    if (!cronMatches(this.cfg.schedule, at, this.cfg.timezone ?? this.tz)) return false;
    const minute = String(Math.floor(at.getTime() / 60_000));
    if (this.api!.kvGet("lastMinute") === minute) return false;
    this.api!.kvSet("lastMinute", minute);
    await this.runNow().catch((e) => this.log.error("dreaming sweep failed", { e: String(e) }));
    return true;
  }

  async runNow(opts: { dryRun?: boolean } = {}): Promise<DreamReport> {
    const api = this.api;
    if (!api?.memory) throw new Error("UniQlaw memory is disabled (settings.memory.enabled)");
    if (this.running) throw new Error("a dreaming sweep is already running");
    if (!opts.dryRun && api.isBusy(DREAM_SESSION)) throw new Error(`the ${DREAM_SESSION} session is busy`);
    const complete = api.complete!;
    this.running = runDreamSweep({
      memory: api.memory, maxMemoryBytes: api.memory.maxInjectBytes, log: this.log, now: this.now,
      complete: async (kind, prompt) => {
        if (kind === "diary" && !this.cfg.diary) return { ok: false, text: "diary disabled" };
        return complete({ channelKey: DREAM_SESSION, job: `dreaming:${kind}`, text: prompt, fresh: true, timeoutMs: this.cfg.timeoutSec * 1000,
          ...(this.cfg.profile ? { profile: this.cfg.profile } : {}), ...(this.cfg.model ? { model: this.cfg.model } : {}) });
      },
    }, thresholdsOf(this.cfg), opts);
    try {
      const r = await this.running;
      if (!opts.dryRun) {
        this.api!.kvSet("lastReport", JSON.stringify({ at: this.now().getTime(), day: r.day, deep: r.deep, candidates: r.candidates.length }));
        const changed = r.deep.added + r.deep.merged + r.deep.superseded;
        if (changed && this.cfg.notifySessions) {
          api.noteToOpenChats?.("UniQlaw memory", `MEMORY.md was updated by the nightly consolidation (${r.deep.added} added, ${r.deep.merged} merged, ${r.deep.superseded} superseded). Your prompt still has the earlier copy; read the current one with memory_get("MEMORY.md") when it matters.`);
        }
        this.log.info("dreaming sweep done", { day: r.day, candidates: r.candidates.length, ...r.deep });
      }
      return r;
    } finally { this.running = undefined; }
  }
}

export default definePlugin({
  kind: "scheduler", name: "dreaming", configSchema: dreamingConfigSchema,
  create: (ctx, cfg) => new DreamingScheduler(cfg, ctx.timezone, ctx.log),
});
