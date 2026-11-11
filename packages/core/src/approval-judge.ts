// Approval judge (docs §10.4): a decision model scores a permission request before the operator is asked.
// It runs in ChannelRuntime.onPermissionInner after the auto-allow / auto-deny short-circuits. Outcomes:
//  - deny: deterministic hard-policy rules in code only (hardPolicyDeny), never the model;
//  - allow: mode "enforce" and pSafe ≥ the session kind's threshold, for this one request (never "always");
//  - escalate: everything else (the operator flow). A judge error or timeout always escalates.
// The judge is a provider (ApprovalJudge), not hard-wired to one service; the daemon builds it from
// `permissions.approval.judge`. Its input is minimal and trusted only (buildJudgeInput).
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, relative, resolve } from "node:path";
import type { ApprovalJudgeConfig, PermissionPolicy } from "./permissions.ts";
import { TOOL_GROUPS, mcpToolAllowed, type ToolGroup, type ToolPolicy } from "./channel-policy.ts";

export type JudgeMode = "off" | "shadow" | "enforce";
/** Who drives the session: decides the allow threshold. a2a is never auto-allowed. */
export type SessionKind = "chat" | "worker" | "cron" | "peer" | "a2a";

export const DEFAULT_JUDGE_THRESHOLDS: Readonly<Record<Exclude<SessionKind, "a2a">, number>> = { chat: 0.9, worker: 0.93, cron: 0.97, peer: 0.97 };

/** What the judge sees: typed data only, every field trusted or produced by code (see buildJudgeInput). */
export interface JudgeInput {
  tool: string;
  /** Tool input, redacted and size-capped; model-written fields (description, reason, …) removed. */
  input: unknown;
  /** false: `input` is raw TUI dialog text (claude-tmux scraping), not structured tool input. */
  structured: boolean;
  cwd: string;
  /** Directories the session may write to (dirScope, else cwd); absent = unrestricted level. */
  scope?: string[];
  level: PermissionPolicy["level"];
  sessionKind: SessionKind;
  /** One-line summary of the channel's tool policy ("unrestricted", "only: web, files.read", "all but: bash"). */
  channelPolicy: string;
  /** The latest message of a trusted human in this turn, capped; absent when the turn has none. */
  humanRequest?: string;
}

export interface JudgeVerdict { pSafe: number; label?: string; model?: string }

export interface ApprovalJudge {
  /** Short display name for prompts ("Jev"). */
  readonly name: string;
  judge(request: JudgeInput, signal: AbortSignal): Promise<JudgeVerdict>;
}

export type JudgeResult =
  | { ok: true; pSafe: number; label?: string; model?: string; latencyMs: number }
  | { ok: false; error: string; latencyMs: number };

/** Run a judge with a hard deadline: a judge that ignores the abort signal still times out. Never throws. */
export async function runJudge(judge: ApprovalJudge, input: JudgeInput, timeoutMs: number): Promise<JudgeResult> {
  const t0 = performance.now();
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, rej) => { timer = setTimeout(() => { ac.abort(); rej(new Error(`judge timed out after ${timeoutMs} ms`)); }, timeoutMs); });
  try {
    const v = await Promise.race([judge.judge(input, ac.signal), deadline]);
    const latencyMs = Math.round(performance.now() - t0);
    if (typeof v?.pSafe !== "number" || !Number.isFinite(v.pSafe) || v.pSafe < 0 || v.pSafe > 1) {
      return { ok: false, error: `judge returned an invalid pSafe: ${String(v?.pSafe)}`, latencyMs };
    }
    return { ok: true, pSafe: v.pSafe, ...(v.label ? { label: v.label } : {}), ...(v.model ? { model: v.model } : {}), latencyMs };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), latencyMs: Math.round(performance.now() - t0) };
  } finally { clearTimeout(timer); }
}

/** Allow threshold for a session kind: the stricter of allowAbove and byKind[kind]. undefined = never auto-allow
 *  (a2a always, whatever the config says; any kind set to "off"). */
export function thresholdFor(cfg: Pick<ApprovalJudgeConfig, "allowAbove" | "byKind">, kind: SessionKind): number | undefined {
  if (kind === "a2a") return undefined; // hard-coded: remote-driven sessions are never auto-allowed
  const k = cfg.byKind?.[kind] ?? DEFAULT_JUDGE_THRESHOLDS[kind];
  if (k === "off") return undefined;
  return Math.max(cfg.allowAbove ?? 0, k);
}

export type JudgeOutcome =
  | { action: "allow" }
  | { action: "deny"; rule: string }
  | { action: "escalate"; reason: "low-confidence" | "judge-error" | "never-auto-allow" | "unstructured-input" | "shadow" };

/** The outcome for a request, from the hard-policy result and the judge result. Pure. */
export function decideOutcome(o: {
  mode: Exclude<JudgeMode, "off">; hardDeny?: string; judged?: JudgeResult; threshold?: number; structured: boolean;
}): { outcome: JudgeOutcome; would: JudgeOutcome } {
  let would: JudgeOutcome;
  if (o.hardDeny) would = { action: "deny", rule: o.hardDeny };
  else if (!o.judged || !o.judged.ok) would = { action: "escalate", reason: "judge-error" };
  else if (o.threshold === undefined) would = { action: "escalate", reason: "never-auto-allow" };
  // Raw dialog text mixes the model's own description into the input: never auto-allow on it.
  else if (!o.structured) would = { action: "escalate", reason: "unstructured-input" };
  else if (o.judged.pSafe >= o.threshold) would = { action: "allow" };
  else would = { action: "escalate", reason: "low-confidence" };
  // Shadow: score and log only; every request goes to the operator as before.
  return { outcome: o.mode === "shadow" ? { action: "escalate", reason: "shadow" } : would, would };
}

// ── hard policy ────────────────────────────────────────────────────────────

/** Tools that only read (Claude Code names, pi names). Anything else is refused at the locked level. */
const READ_ONLY_TOOLS = new Set(["Read", "Grep", "Glob", "LSP", "NotebookRead", "read", "grep", "find", "ls"]);
/** Tools that write the file named by their input (Claude Code, pi). */
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit", "write", "edit"]);
const PATH_KEYS = ["file_path", "notebook_path", "path"] as const;

function inputPath(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  for (const k of PATH_KEYS) {
    const v = (input as Record<string, unknown>)[k];
    if (typeof v === "string" && v) return v;
  }
  return undefined;
}

const expand = (p: string) => (p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

function inside(path: string, dirs: string[]): boolean {
  return dirs.some((d) => {
    const r = relative(normalize(d), path);
    return r === "" || (!r.startsWith("..") && !isAbsolute(r));
  });
}

/** Does one `denyTools` rule (Claude Code permission-rule syntax: `Tool` or `Tool(spec)`) match this request? */
export function denyRuleMatches(rule: string, tool: string, input: unknown, cwd: string): boolean {
  const m = /^([^()]+?)(?:\((.*)\))?$/.exec(rule.trim());
  if (!m) return false;
  const [, name, spec] = m;
  const sameTool = name === tool || (name === "Edit" && WRITE_TOOLS.has(tool));
  if (!sameTool) return false;
  if (spec === undefined || spec === "" || spec === "*") return true;
  const obj = input && typeof input === "object" ? input as Record<string, unknown> : undefined;
  if (typeof obj?.command === "string") {
    const cmd = obj.command.trim();
    const prefix = spec.endsWith(":*") ? spec.slice(0, -2) : spec.endsWith("*") ? spec.slice(0, -1) : undefined;
    return prefix !== undefined ? cmd.startsWith(prefix.trim()) : cmd === spec.trim();
  }
  const p = inputPath(input);
  if (p === undefined) return false;
  // Path rules: `//abs`, `~/home`, `./rel` or `rel` (relative to cwd). A plain `/x` is read as absolute: wider, which
  // is the safe side for a deny rule.
  const pattern = spec.startsWith("//") ? spec.slice(1) : spec.startsWith("~") ? expand(spec) : isAbsolute(spec) ? spec : resolve(cwd, spec);
  return new Bun.Glob(pattern).match(resolve(cwd, expand(p)));
}

/** Channel tool policy: does it take this (Claude Code or UniQlaw MCP) tool away? Names the policy doesn't know
 *  (other providers' tool names, other MCP servers) are left to the provider and the judge. */
function toolPolicyDenies(policy: ToolPolicy | undefined, tool: string): boolean {
  if (!policy) return false;
  const mcp = /^mcp__uniqlaw__(.+)$/.exec(tool);
  if (mcp) return !mcpToolAllowed(policy, mcp[1]!);
  const groups = (Object.keys(TOOL_GROUPS) as ToolGroup[]).filter((g) => TOOL_GROUPS[g].claude.includes(tool));
  if (!groups.length) return false;
  return policy.mode === "allow" ? !groups.some((g) => policy.groups.includes(g)) : groups.some((g) => policy.groups.includes(g));
}

/** Directories writes are confined to (dirScope, else the session's cwd); undefined at the unrestricted level. */
export function writeScope(p: PermissionPolicy, cwd: string): string[] | undefined {
  if (p.level === "unrestricted") return undefined;
  return (p.dirScope?.length ? p.dirScope : [cwd]).map((d) => resolve(cwd, expand(d)));
}

/**
 * Deterministic hard-policy rules (the only automatic deny): the profile's denyTools, the channel's tool policy,
 * the locked level, and writes outside the scope. Returns the rule that matched, else undefined. Needs structured
 * input for anything but tool-name rules.
 */
export function hardPolicyDeny(o: { tool: string; input: unknown; structured: boolean; policy: PermissionPolicy; toolPolicy?: ToolPolicy; cwd: string }): string | undefined {
  const input = o.structured ? o.input : undefined;
  for (const rule of o.policy.denyTools) if (denyRuleMatches(rule, o.tool, input, o.cwd)) return `denyTools: ${rule}`;
  if (toolPolicyDenies(o.toolPolicy, o.tool)) return `channel tool policy: ${o.tool}`;
  if (o.policy.level === "locked" && !READ_ONLY_TOOLS.has(o.tool)) return `level locked: ${o.tool} is not read-only`;
  const scope = writeScope(o.policy, o.cwd);
  const p = WRITE_TOOLS.has(o.tool) ? inputPath(input) : undefined;
  if (scope && p !== undefined && !inside(resolve(o.cwd, expand(p)), scope)) return `write outside scope: ${p}`;
  return undefined;
}

// ── judge input ────────────────────────────────────────────────────────────

/** Fields a model writes about its own call (Claude's Bash `description`, codex `reason`, …): untrusted, dropped. */
const MODEL_WRITTEN_KEYS = new Set(["description", "reason", "title", "justification", "explanation", "rationale"]);
const SECRET_KEY = /pass(word|wd|phrase)?$|secret|token|api[-_]?key|^auth(orization)?$|cookie|credential|private[-_]?key|session[-_]?id/i;
const SECRET_PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[REDACTED PRIVATE KEY]"],
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [REDACTED]"],
  [/\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|PWD|CREDENTIALS?|AUTH)[A-Za-z0-9_]*)=("[^"]*"|'[^']*'|[^\s;&|]+)/gi, "$1=[REDACTED]"],
  [/(--?(?:password|passwd|token|api-key|apikey|secret|auth)[= ])("[^"]*"|'[^']*'|\S+)/gi, "$1[REDACTED]"],
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, "$1[REDACTED]@"],
  [/\b(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g, "[REDACTED]"],
];

export function redactString(s: string): string {
  let out = s;
  for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, rep);
  return out;
}

const STRING_CAP = 2000;
const INPUT_CAP = 6000;
const HUMAN_CAP = 1000;
const cap = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Tool input as the judge and the audit log see it: secrets masked, model-written fields dropped, strings and
 *  the whole value size-capped (an oversized value becomes its capped JSON text). */
export function redactInput(input: unknown, depth = 0): unknown {
  const walk = (v: unknown, d: number): unknown => {
    if (typeof v === "string") return cap(redactString(v), STRING_CAP);
    if (v === null || typeof v !== "object") return v;
    if (d > 6) return "[…]";
    if (Array.isArray(v)) return v.slice(0, 50).map((x) => walk(x, d + 1));
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 50)) {
      if (MODEL_WRITTEN_KEYS.has(k)) continue;
      out[k] = SECRET_KEY.test(k) && x !== null && typeof x !== "object" ? "[REDACTED]" : walk(x, d + 1);
    }
    return out;
  };
  const r = walk(input, depth);
  const json = JSON.stringify(r) ?? "";
  return json.length > INPUT_CAP ? cap(json, INPUT_CAP) : r;
}

/** sha256 of the raw input (to match audit rows without storing secrets). */
export function inputHash(input: unknown): string {
  return new Bun.CryptoHasher("sha256").update(typeof input === "string" ? input : JSON.stringify(input) ?? "").digest("hex");
}

export function summarizeToolPolicy(p: ToolPolicy | undefined): string {
  if (!p) return "unrestricted";
  return p.mode === "allow" ? `only: ${p.groups.join(", ") || "(none)"}` : `all but: ${p.groups.join(", ")}`;
}

export function buildJudgeInput(o: {
  tool: string; input: unknown; policy: PermissionPolicy; toolPolicy?: ToolPolicy; cwd: string; sessionKind: SessionKind;
  /** Only pass a message from a trusted human origin. */
  humanRequest?: string;
}): JudgeInput {
  const structured = typeof o.input !== "string";
  const scope = writeScope(o.policy, o.cwd);
  return {
    tool: o.tool,
    input: redactInput(o.input),
    structured,
    cwd: o.cwd,
    ...(scope ? { scope } : {}),
    level: o.policy.level,
    sessionKind: o.sessionKind,
    channelPolicy: summarizeToolPolicy(o.toolPolicy),
    ...(o.humanRequest?.trim() ? { humanRequest: cap(redactString(o.humanRequest.trim()), HUMAN_CAP) } : {}),
  };
}

/** Line shown on an escalated prompt: "Jev: 0.87 safe (needs 0.90)". */
export function judgeNote(name: string, r: JudgeResult | undefined, threshold: number | undefined): string | undefined {
  if (!r) return undefined;
  if (!r.ok) return `${name}: no score (${cap(r.error, 80)})`;
  return `${name}: ${r.pSafe.toFixed(2)} safe${threshold !== undefined ? ` (needs ${threshold.toFixed(2)})` : " (never auto-allowed here)"}`;
}

// ── audit log ──────────────────────────────────────────────────────────────

export interface ApprovalAuditRecord {
  id: string;
  ts: string;
  channelKey: string;
  sessionKind: SessionKind;
  provider: string;
  tool: string;
  structured: boolean;
  inputHash: string;
  input: unknown;
  judge?: string;
  model?: string;
  pSafe?: number;
  threshold?: number | null;
  mode: Exclude<JudgeMode, "off">;
  outcome: JudgeOutcome["action"];
  reason?: string;
  /** shadow: what enforce would have done. */
  wouldOutcome?: JudgeOutcome["action"];
  latencyMs?: number;
  error?: string;
}

export interface ApprovalDecisionRecord {
  id: string;
  humanDecision: "allow" | "deny" | "timeout" | "no-route";
  decidedAt: string;
}

/** Append-only JSONL audit: `<stateDir>/approvals/YYYY-MM.jsonl` (UTC month of the line). Join a request and the
 *  human's decision by `id`; they may land in different months. */
export class ApprovalAudit {
  constructor(private readonly dir: string, private readonly now: () => Date = () => new Date()) {}

  fileFor(d: Date): string {
    return join(this.dir, `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}.jsonl`);
  }

  append(rec: ApprovalAuditRecord | ApprovalDecisionRecord): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    appendFileSync(this.fileFor(this.now()), JSON.stringify(rec) + "\n", { mode: 0o600 });
  }
}
