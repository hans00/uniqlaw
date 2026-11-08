// Job files: `<dir>/<name>.md` with frontmatter (v2-compatible format).
//   schedule: "0 9 * * *"   recurring: true|false   target: "cron:<name>" (default) | "telegram:<chatId>" | any session
//   replyTo: "telegram:<chatId>" | "none"   timezone: "+08:00"   profile: "<profile>"   model: "<model>"
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { isValidCron } from "./cron.ts";

export interface Job {
  name: string;
  filePath: string;
  schedule: string;
  recurring: boolean;
  target: string;
  replyTo?: string;
  timezone?: string;
  /** Pin the job's session to a profile. */
  profile?: string;
  /** Run the job's turns on this model (live switch, then back). */
  model?: string;
  body: string;
}

/** Default session for a job without `target`: its own internal session. */
export const defaultJobTarget = (name: string) => `cron:${name}`;

export function parseFrontmatter(content: string): { meta: Record<string, string>; body: string } {
  content = content.replace(/\r\n?/g, "\n");
  if (!content.startsWith("---")) return { meta: {}, body: content.trim() };
  const rest = content.slice(content.indexOf("\n") + 1);
  const end = rest.indexOf("\n---");
  if (end < 0) return { meta: {}, body: content.trim() };
  const meta: Record<string, string> = {};
  for (const line of rest.slice(0, end).split("\n")) {
    const m = /^([a-zA-Z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2]!.trim().replace(/\s+#.*$/, "");
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    meta[m[1]!] = v;
  }
  return { meta, body: rest.slice(end + 4).replace(/^\n/, "").trim() };
}

export function isValidJobName(name: string) { return /^[a-zA-Z0-9._-]+$/.test(name) && !name.startsWith("."); }

export function parseJob(filePath: string, content: string): Job | { error: string } {
  const { meta, body } = parseFrontmatter(content);
  if (!meta.schedule) return { error: "missing 'schedule'" };
  if (!isValidCron(meta.schedule)) return { error: `invalid schedule "${meta.schedule}"` };
  const name = basename(filePath, extname(filePath));
  return {
    name, filePath, schedule: meta.schedule,
    recurring: meta.recurring === undefined ? true : meta.recurring.toLowerCase() !== "false",
    target: meta.target?.trim() || defaultJobTarget(name),
    replyTo: meta.replyTo?.trim() || undefined,
    timezone: meta.timezone?.trim() || undefined,
    profile: meta.profile?.trim() || undefined,
    model: meta.model?.trim() || undefined,
    body,
  };
}

export function loadJobs(dir: string, onError?: (file: string, error: string) => void): Job[] {
  if (!existsSync(dir)) return [];
  const jobs: Job[] = [];
  for (const f of readdirSync(dir)) {
    if (extname(f).toLowerCase() !== ".md") continue;
    const p = join(dir, f);
    try {
      const j = parseJob(p, readFileSync(p, "utf8"));
      if ("error" in j) onError?.(f, j.error); else jobs.push(j);
    } catch (e) { onError?.(f, String(e)); }
  }
  return jobs;
}

export function saveJob(dir: string, name: string, f: Omit<Job, "name" | "filePath">) {
  if (!isValidJobName(name)) throw new Error(`invalid job name "${name}"`);
  if (!isValidCron(f.schedule)) throw new Error(`invalid schedule "${f.schedule}"`);
  const q = (v: string) => (/^[\w.:+-]+$/.test(v) ? v : JSON.stringify(v));
  const lines = ["---", `schedule: ${q(f.schedule)}`, `recurring: ${f.recurring}`];
  if (f.target && f.target !== defaultJobTarget(name)) lines.push(`target: ${q(f.target)}`);
  if (f.replyTo) lines.push(`replyTo: ${q(f.replyTo)}`);
  if (f.timezone) lines.push(`timezone: ${q(f.timezone)}`);
  if (f.profile) lines.push(`profile: ${q(f.profile)}`);
  if (f.model) lines.push(`model: ${q(f.model)}`);
  lines.push("---", "", f.body.trim(), "");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), lines.join("\n"));
}

export function deleteJob(dir: string, name: string): boolean {
  if (!isValidJobName(name)) return false;
  try { unlinkSync(join(dir, `${name}.md`)); return true; } catch { return false; }
}
