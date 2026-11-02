// Multi-instance isolation (docs §11.2): per-project lock, runtime.json with the
// actual ports, and machine-wide bot-token claims so two claws never share a bot.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface RuntimeInfo {
  pid: number;
  instanceId: string;
  projectDir: string;
  startedAt: number;
  webPort?: number;
  gatewayPort?: number;
  /** Ports opened by transport plugins (A2A HTTP / gRPC …). */
  transportPorts?: Record<string, number>;
  version: string;
}

export function stateDirOf(projectDir: string) { return join(resolve(projectDir), ".uniqlaw"); }

export function deriveInstanceId(projectDir: string, configured?: string): string {
  return configured ?? createHash("sha256").update(resolve(projectDir)).digest("hex").slice(0, 8);
}

export function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

export function readRuntime(projectDir: string): RuntimeInfo | undefined {
  const p = join(stateDirOf(projectDir), "runtime.json");
  if (!existsSync(p)) return undefined;
  try { return JSON.parse(readFileSync(p, "utf8")) as RuntimeInfo; } catch { return undefined; }
}

/** Take the per-project daemon lock. Throws if another live daemon holds it. */
export function acquireLock(projectDir: string): () => void {
  const dir = stateDirOf(projectDir);
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, "daemon.lock");
  if (existsSync(lock)) {
    const pid = Number(readFileSync(lock, "utf8").trim());
    if (pid && pid !== process.pid && isAlive(pid)) throw new Error(`another UniQlaw daemon (pid ${pid}) is already running for ${projectDir}`);
  }
  writeFileSync(lock, String(process.pid));
  return () => {
    try { if (readFileSync(lock, "utf8").trim() === String(process.pid)) rmSync(lock); } catch {}
    try { rmSync(join(dir, "runtime.json")); } catch {}
  };
}

export function writeRuntime(projectDir: string, info: RuntimeInfo) {
  writeFileSync(join(stateDirOf(projectDir), "runtime.json"), JSON.stringify(info, null, 2));
}

// ── machine-wide claims ────────────────────────────────────────────────────

export function claimsDir() {
  return join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "uniqlaw", "claims");
}

interface Claim { pid: number; projectDir: string; what: string; at: number }

/** Claim a secret-derived key (e.g. a bot token) for this process. Throws if a live
 *  daemon of another project already holds it. Only the hash is written to disk. */
export function claim(what: string, secret: string, projectDir: string): () => void {
  const dir = claimsDir();
  mkdirSync(dir, { recursive: true });
  const file = join(dir, createHash("sha256").update(secret).digest("hex").slice(0, 32) + ".json");
  if (existsSync(file)) {
    try {
      const c = JSON.parse(readFileSync(file, "utf8")) as Claim;
      if (c.pid !== process.pid && isAlive(c.pid) && resolve(c.projectDir) !== resolve(projectDir)) {
        throw new Error(`${what} is already used by the UniQlaw instance at ${c.projectDir} (pid ${c.pid})`);
      }
    } catch (e) { if (e instanceof Error && e.message.includes("already used")) throw e; }
  }
  writeFileSync(file, JSON.stringify({ pid: process.pid, projectDir: resolve(projectDir), what, at: Date.now() } satisfies Claim));
  return () => { try { if ((JSON.parse(readFileSync(file, "utf8")) as Claim).pid === process.pid) rmSync(file); } catch {} };
}

/** All live instances on this machine (from claims + their runtime.json). */
export function listInstances(): RuntimeInfo[] {
  const dir = claimsDir();
  const projects = new Set<string>();
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      try {
        const c = JSON.parse(readFileSync(join(dir, f), "utf8")) as Claim;
        if (isAlive(c.pid)) projects.add(c.projectDir); else rmSync(join(dir, f));
      } catch {}
    }
  }
  const reg = join(dir, "..", "instances");
  if (existsSync(reg)) for (const f of readdirSync(reg)) {
    try { projects.add(readFileSync(join(reg, f), "utf8").trim()); } catch {}
  }
  const out: RuntimeInfo[] = [];
  for (const p of projects) {
    const r = readRuntime(p);
    if (r && isAlive(r.pid)) out.push(r);
  }
  return out;
}

/** Register the project dir so `uniqlaw ls` finds instances without platform claims. */
export function registerInstance(instanceId: string, projectDir: string) {
  const reg = join(claimsDir(), "..", "instances");
  mkdirSync(reg, { recursive: true });
  writeFileSync(join(reg, instanceId), resolve(projectDir));
}
