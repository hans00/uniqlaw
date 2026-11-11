// TypeSafe System One approval judges. Built from the TypeSafe HTTP API docs (https://docs.typesafe.ai/api.md,
// checked 2026-11-12): POST <baseUrl>/v1/systemone with a Choice question; the answer's `probabilities.safe` is the
// calibrated P(safe) (docs.typesafe.ai/confidence.md: act on the probability of the option your code acts on, not on
// `confidence`).
//  - provider "typesafe-compatible": any server speaking that protocol (self-hosted), baseUrl and auth configurable;
//  - provider "typesafe-jev": the hosted TypeSafe service (the same backend with its default baseUrl and model).
import { JUDGE_INDUCED_QUESTION, JUDGE_QUESTION, secretRefSchema, type ApprovalJudge, type JudgeInput, type JudgeVerdict } from "@uniqlaw/core";
import { z } from "zod";

export const TYPESAFE_API = "https://api.typesafe.ai";
export const DEFAULT_JEV_MODEL = "jev-latest";

/** `judge.options` of the TypeSafe backends. */
export const typesafeOptionsSchema = z.object({
  /** Server root (the path /v1/systemone is appended). Required for typesafe-compatible. */
  baseUrl: z.url().optional(),
  model: z.string().optional(),
  /** API key (SecretRef). Optional for typesafe-compatible (a server without auth). */
  credential: secretRefSchema.optional(),
  /** Header the key goes in, and the scheme before it ("" = the bare key, e.g. for "x-api-key"). */
  authHeader: z.string().default("authorization"),
  authScheme: z.string().default("Bearer"),
  /** Extra static headers (no secrets: use credential). */
  headers: z.record(z.string(), z.string()).default({}),
  /** Name shown on prompts ("Jev: 0.87 safe"). */
  name: z.string().optional(),
}).strict();
export type TypeSafeOptions = z.infer<typeof typesafeOptionsSchema>;

export interface TypeSafeJudgeOptions {
  baseUrl: string;
  model: string;
  /** Resolves the API key (a SecretRef resolver). Called on first use; never logged. undefined = no auth header. */
  key?: () => Promise<string>;
  authHeader?: string;
  authScheme?: string;
  headers?: Record<string, string>;
  name?: string;
  fetch?: typeof fetch;
}

/** The Choice question in System One form. Every field of `state` is data: the instructions say so, and the input
 *  comes from code (core buildJudgeInput: no tool output, assistant text or peer/cron/A2A text). */
export const SAFETY_QUESTION = {
  type: "choice",
  instructions: { task: JUDGE_QUESTION.task, data: JUDGE_QUESTION.data, consider: JUDGE_QUESTION.consider },
  criteria: JUDGE_QUESTION.criteria,
} as const;

/** The second question, in the same request (System One answers several named questions per call). */
export const INDUCED_QUESTION = { type: "choice", instructions: JUDGE_INDUCED_QUESTION.task, criteria: JUDGE_INDUCED_QUESTION.criteria } as const;

export function systemOneRequestBody(req: JudgeInput, model: string) {
  return { model, state: { request: req }, questions: { safety: SAFETY_QUESTION, induced: INDUCED_QUESTION } };
}
/** @deprecated name kept for callers of the first version. */
export const jevRequestBody = (req: JudgeInput, model = DEFAULT_JEV_MODEL) => systemOneRequestBody(req, model);

/** P(safe) from a /v1/systemone response; throws on anything unexpected. */
export function parseSystemOneResponse(j: unknown): JudgeVerdict {
  const r = j as { model?: unknown; answers?: { safety?: { type?: unknown; choice?: unknown; probabilities?: Record<string, unknown> } } };
  const a = r?.answers?.safety;
  const p = a?.probabilities?.safe;
  if (a?.type !== "choice" || typeof p !== "number" || !Number.isFinite(p)) throw new Error("unexpected TypeSafe response: no choice probability for \"safe\"");
  const ind = (r.answers as Record<string, { type?: unknown; choice?: unknown; probabilities?: Record<string, unknown> }> | undefined)?.induced;
  const pi = ind?.type === "choice" ? ind.probabilities?.induced : undefined;
  return { pSafe: p, ...(typeof a.choice === "string" ? { label: a.choice } : {}), ...(typeof r.model === "string" ? { model: r.model } : {}),
    ...(typeof pi === "number" && Number.isFinite(pi) ? { pInduced: pi } : {}),
    ...(ind?.choice === "task" || ind?.choice === "induced" || ind?.choice === "unclear" ? { inducedLabel: ind.choice } : {}) };
}
export const parseJevResponse = parseSystemOneResponse;

export class TypeSafeJudge implements ApprovalJudge {
  readonly name: string;
  private key?: Promise<string>;
  constructor(private readonly o: TypeSafeJudgeOptions) { this.name = o.name ?? "Jev"; }

  async judge(req: JudgeInput, signal: AbortSignal): Promise<JudgeVerdict> {
    const headers: Record<string, string> = { ...this.o.headers, "content-type": "application/json" };
    if (this.o.key) {
      // Resolve the key once; a failed resolution is retried on the next request.
      this.key ??= this.o.key().catch((e) => { this.key = undefined; throw new Error(`judge API key: ${e instanceof Error ? e.message : String(e)}`); });
      const key = await this.key;
      const scheme = this.o.authScheme ?? "Bearer";
      headers[this.o.authHeader ?? "authorization"] = scheme ? `${scheme} ${key}` : key;
    }
    const res = await (this.o.fetch ?? fetch)(`${this.o.baseUrl.replace(/\/$/, "")}/v1/systemone`, {
      method: "POST", headers, body: JSON.stringify(systemOneRequestBody(req, this.o.model)), signal,
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 200);
      throw new Error(`TypeSafe API HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
    }
    return parseSystemOneResponse(await res.json());
  }
}

/** The hosted TypeSafe Jev service: TypeSafeJudge with its defaults. */
export class JevJudge extends TypeSafeJudge {
  constructor(o: Omit<TypeSafeJudgeOptions, "baseUrl" | "model"> & { baseUrl?: string; model?: string; key: () => Promise<string> }) {
    super({ ...o, baseUrl: o.baseUrl ?? TYPESAFE_API, model: o.model ?? DEFAULT_JEV_MODEL });
  }
}

/** Build a backend from `judge.options` (already merged with the credential/model shorthands). */
export function createTypeSafeJudge(kind: "typesafe-jev" | "typesafe-compatible", options: unknown,
  resolve: (ref: z.infer<typeof secretRefSchema>) => Promise<string>): TypeSafeJudge {
  const o = typesafeOptionsSchema.parse(options);
  if (kind === "typesafe-compatible" && !o.baseUrl) throw new Error("typesafe-compatible needs judge.options.baseUrl");
  if (kind === "typesafe-jev" && !o.credential) throw new Error("typesafe-jev needs judge.options.credential (a secret ref to the TypeSafe API key)");
  const ref = o.credential;
  return new TypeSafeJudge({
    baseUrl: o.baseUrl ?? TYPESAFE_API, model: o.model ?? DEFAULT_JEV_MODEL,
    ...(ref ? { key: () => resolve(ref) } : {}),
    authHeader: o.authHeader, authScheme: o.authScheme, headers: o.headers,
    name: o.name ?? (kind === "typesafe-jev" ? "Jev" : "TypeSafe"),
  });
}
