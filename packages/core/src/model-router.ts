// Per-turn model routing (port of v2 model-router.ts + channel.ts hysteresis).
// Config lives in profile.options.agentic (migrated verbatim from v2).
import { z } from "zod";

export const agenticSchema = z.object({
  enabled: z.boolean().default(false),
  defaultMode: z.string().default(""),
  modes: z.array(z.object({ name: z.string(), model: z.string(), keywords: z.array(z.string()).default([]), phrases: z.array(z.string()).optional() })).default([]),
  hysteresis: z.object({
    confidenceThreshold: z.number().default(0.75),
    scoreMargin: z.number().default(2),
    stickyWindowMinutes: z.number().default(30),
    stickyWindowTurns: z.number().default(5),
  }).prefault({}),
});
export type AgenticConfig = z.infer<typeof agenticSchema>;
type Mode = AgenticConfig["modes"][number];

export interface Classification { mode: string; model: string; confidence: number; reasoning: string; scores: { mode: string; score: number }[] }

export function classifyTask(prompt: string, modes: Mode[], defaultMode: string): Classification {
  const text = prompt.toLowerCase().trim();
  const scores = modes.map((mode) => ({ mode, score: mode.keywords.filter((k) => text.includes(k.toLowerCase())).length }));
  const q = (text.match(/\?/g) || []).length;
  if (q) for (const s of scores) if (s.mode.phrases?.length) s.score += q * 0.5;
  const snapshot = scores.map((s) => ({ mode: s.mode.name, score: s.score })).sort((a, b) => b.score - a.score);
  for (const m of modes) for (const p of m.phrases ?? []) {
    if (text.includes(p.toLowerCase())) return { mode: m.name, model: m.model, confidence: 0.95, reasoning: `phrase "${p}" → ${m.name}`, scores: snapshot };
  }
  scores.sort((a, b) => b.score - a.score);
  const [top, second] = scores;
  if (top && top.score > 0) {
    if (!second || top.score > second.score) {
      const diff = second ? top.score - second.score : top.score;
      return { mode: top.mode.name, model: top.mode.model, confidence: Math.min(0.9, 0.6 + diff * 0.1), reasoning: `${top.mode.name}:${top.score}${second ? ` vs ${second.mode.name}:${second.score}` : ""}`, scores: snapshot };
    }
    const tied = scores.filter((s) => s.score === top.score);
    const pick = tied.find((s) => s.mode.name === defaultMode) ?? top;
    return { mode: pick.mode.name, model: pick.mode.model, confidence: 0.6, reasoning: `tie ${tied.map((s) => s.mode.name).join("/")} → ${pick.mode.name}`, scores: snapshot };
  }
  const fb = modes.find((m) => m.name === defaultMode) ?? modes[0];
  return fb ? { mode: fb.name, model: fb.model, confidence: 0.5, reasoning: `ambiguous → ${fb.name}`, scores: snapshot }
    : { mode: "unknown", model: "", confidence: 0, reasoning: "no modes configured", scores: snapshot };
}

/** Stateful per-session router with hysteresis gates (bypassed by phrase matches ≥ 0.95). */
export class ModelRouter {
  private currentMode = "";
  private lastSwitchAt = 0;
  private turns = 0;
  private turnsAtSwitch = 0;
  constructor(private cfg: AgenticConfig, private currentModel: string | undefined, private now: () => number = Date.now) {}

  get enabled() { return this.cfg.enabled && this.cfg.modes.length > 0; }

  /** Call once per user turn. Returns the model to switch to, or undefined. */
  decide(prompt: string): { model: string; reasoning: string } | { skip: string } | undefined {
    if (!this.enabled) return undefined;
    this.turns++;
    const r = classifyTask(prompt, this.cfg.modes, this.cfg.defaultMode);
    if (!r.model) return undefined;
    if (r.model === this.currentModel) { this.currentMode = r.mode; return undefined; }
    const h = this.cfg.hysteresis;
    if (r.confidence < 0.95) {
      const why: string[] = [];
      if (r.confidence < h.confidenceThreshold) why.push(`confidence ${r.confidence.toFixed(2)} < ${h.confidenceThreshold}`);
      const ns = r.scores.find((s) => s.mode === r.mode)?.score ?? 0;
      const cs = r.scores.find((s) => s.mode === this.currentMode)?.score ?? 0;
      if (ns - cs < h.scoreMargin) why.push(`margin ${(ns - cs).toFixed(1)} < ${h.scoreMargin}`);
      if (this.lastSwitchAt > 0) {
        if ((this.now() - this.lastSwitchAt) / 60_000 < h.stickyWindowMinutes) why.push("sticky window (minutes)");
        if (this.turns - this.turnsAtSwitch < h.stickyWindowTurns) why.push("sticky window (turns)");
      }
      if (why.length) return { skip: `${r.reasoning}: ${why.join("; ")}` };
    }
    this.currentModel = r.model;
    this.currentMode = r.mode;
    this.lastSwitchAt = this.now();
    this.turnsAtSwitch = this.turns;
    return { model: r.model, reasoning: r.reasoning };
  }

  /** Manual /model switch: adopt without hysteresis bookkeeping surprises. */
  adopt(model: string) { this.currentModel = model; this.lastSwitchAt = this.now(); this.turnsAtSwitch = this.turns; }
}
