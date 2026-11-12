// Targets of a permission request (docs §10.4): the resources it acts on, for any tool and any shell command, each
// with a kind, an effect and kind-specific provenance computed by code. Built from small extractors in registries
// (per normalized command name, per tool name) and per-kind enrichers, so a new kind or command is one more entry.
// A session ledger records what this session itself created (files, dirs, branches, packages, processes, containers,
// tmux sessions), from the actions the harness observed.
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { analyzeShell, shellQuote, type ShellAnalysis, type ShellDialect } from "./shell.ts";

export type TargetKind = "path" | "git-ref" | "url" | "process" | "package" | "service" | "device" | "remote-host" | "secret-ish";
export type Effect = "read" | "create" | "modify" | "delete" | "execute" | "send" | "install" | "publish";

export interface RequestTarget {
  kind: TargetKind;
  effect: Effect;
  /** What it is: a path, `origin/main`, a URL, a pid or process name, a package, a service, a device, a host. */
  id: string;
  /** The command or tool that acts on it. */
  via: string;
  createdThisSession?: boolean;
  inScope?: boolean;
  existsNow?: boolean;
  unresolved?: boolean;
  reason?: string;
  /** Lies on another machine (ssh/scp/rsync): nothing beyond the host is checked. */
  remote?: boolean;
  /** Kind-specific provenance (git status, isDefaultBranch, scope global/local, ownedByUser, host class, …). */
  details?: Record<string, unknown>;
}

export interface TargetReport { targets: RequestTarget[]; unrecognized: string[] }

// ── session ledger ─────────────────────────────────────────────────────────

/** Resources this session created, recorded from the actions the harness observed. In memory, per session. */
export interface LedgerOptions {
  /** The session's process root (e.g. claude-tmux's pane pid): a pid counts as started by this session only when
   *  it descends from it. undefined = pids are never recorded. */
  processRoot?: () => number | undefined;
}

export class SessionLedger {
  readonly startedAt: number;
  private items = new Map<string, { at: number; existedBefore?: boolean }>();
  constructor(startedAt = Date.now(), private readonly opts: LedgerOptions = {}) { this.startedAt = startedAt; }

  /** Paths are recorded by their resolved real path (a symlink to elsewhere is not "this session's"). */
  record(kind: TargetKind, id: string, existedBefore?: boolean) {
    const key = `${kind}:${kind === "path" ? normPath(realish(id)) : id}`;
    if (!this.items.has(key)) this.items.set(key, { at: Date.now(), ...(existedBefore !== undefined ? { existedBefore } : {}) });
  }
  has(kind: TargetKind, id: string): boolean { return this.items.has(`${kind}:${id}`); }

  /** A path this session created: a create action targeted it (or a parent directory), and it was new then or
   *  its birth time (never mtime) is after the session started. Checked on the resolved real path. */
  createdPath(abs: string): boolean {
    const p = normPath(realish(abs));
    for (let cur = p; ; cur = dirname(cur)) {
      const it = this.items.get(`path:${cur}`);
      if (it && (it.existedBefore === false || bornAfter(cur, this.startedAt))) return true;
      if (dirname(cur) === cur) return false;
    }
  }
  /** How many recorded created paths lie under `abs`. */
  createdInside(abs: string): number {
    const p = normPath(realish(abs)) + "/";
    let n = 0;
    for (const k of this.items.keys()) if (k.startsWith(`path:${p}`)) n++;
    return n;
  }
  /** Feed one observed action: record what it creates. `output` (tool result) may name background pids; each is
   *  recorded only after verifying it started after the session began and descends from the session's process
   *  root. */
  observe(tool: string, input: unknown, cwd: string, output?: string) {
    for (const t of extractRaw(tool, input, cwd).targets) {
      if (t.remote || t.unresolved) continue;
      if (t.kind === "path" && t.effect === "create") { const abs = absPath(t.id, cwd); this.record("path", abs, existsSync(abs)); }
      // A ref counts as created only if it did not exist before (checkout -B / branch -f on an existing ref resets it).
      else if (t.kind === "git-ref" && t.effect === "create") { if (!refExists(t.id, cwd)) this.record("git-ref", t.id); }
      else if (t.kind !== "process" && (t.effect === "create" || t.effect === "install")) this.record(t.kind, t.id);
    }
    const root = this.opts.processRoot?.();
    if (output && root) {
      for (const m of output.matchAll(/\b(\d{2,8})\b/g)) {
        const pid = Number(m[1]);
        if (pid !== root && startedAfter(pid, this.startedAt) && descendsFrom(pid, root)) this.record("process", String(pid));
      }
    }
  }
}

/** Birth time after `t`. No birth time (filesystem or platform without it): false, never mtime (a false negative is fine). */
function bornAfter(p: string, t: number): boolean {
  try { const s = statSync(p); return s.birthtimeMs > 0 && s.birthtimeMs >= t; } catch { return false; }
}

/** Does the ref exist already: a local branch or tag, or a branch on any remote this repo knows (refs/remotes/<r>/<name>:
 *  a branch that exists on a remote is not one this session created). The remote itself is not queried (network). */
function refExists(ref: string, cwd: string): boolean {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
  try {
    if (ref.startsWith("tags/")) return Bun.spawnSync(["git", "rev-parse", "--verify", "--quiet", `refs/tags/${ref.slice(5)}`], { cwd: nearestDir(cwd), stdout: "ignore", stderr: "ignore", env }).exitCode === 0;
    const r = Bun.spawnSync(["git", "for-each-ref", "--count=1", "--format=%(refname)", `refs/heads/${ref}`, `refs/remotes/*/${ref}`], { cwd: nearestDir(cwd), stdout: "pipe", stderr: "ignore", env });
    return r.exitCode === 0 && r.stdout.toString().trim() !== ""; // not a repo (yet): nothing exists
  } catch { return true; }
}

/** /proc/<pid>/stat fields after the command name: [state, ppid, …, starttime (field 22)]. */
function procStat(pid: number): { ppid: number; startTicks: number } | undefined {
  try {
    const s = readFileSync(`/proc/${pid}/stat`, "utf8");
    const f = s.slice(s.lastIndexOf(")") + 2).split(" ");
    return { ppid: Number(f[1]), startTicks: Number(f[19]) };
  } catch { return undefined; }
}
let bootMs: number | undefined;
function processStartMs(pid: number): number | undefined {
  const st = procStat(pid);
  if (st) {
    bootMs ??= (() => { try { return Number(/^btime (\d+)/m.exec(readFileSync("/proc/stat", "utf8"))?.[1]) * 1000; } catch { return NaN; } })();
    return Number.isFinite(bootMs) ? bootMs + (st.startTicks / 100) * 1000 : undefined; // USER_HZ is 100 on Linux
  }
  try { // macOS / BSD
    const r = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
    const t = Date.parse(r.stdout.toString().trim());
    return Number.isFinite(t) ? t : undefined;
  } catch { return undefined; }
}
function parentOf(pid: number): number | undefined {
  const st = procStat(pid);
  if (st) return st.ppid;
  try { const r = Bun.spawnSync(["ps", "-o", "ppid=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" }); const n = Number(r.stdout.toString().trim()); return n > 0 ? n : undefined; } catch { return undefined; }
}
/** Started at or after `t` (1 s tolerance for clock-tick rounding). */
export function startedAfter(pid: number, t: number): boolean { const s = processStartMs(pid); return s !== undefined && s >= t - 1000; }
export function descendsFrom(pid: number, root: number): boolean {
  let cur: number | undefined = pid;
  for (let i = 0; i < 64 && cur && cur > 1; i++) { cur = parentOf(cur); if (cur === root) return true; }
  return false;
}

// ── extraction ─────────────────────────────────────────────────────────────

type Raw = Omit<RequestTarget, "via"> & { via?: string };
export interface ExtractContext { cwd: string; analysis: ShellAnalysis; /** wrappers seen on this line (sudo, …) */ wrappers: string[] }
/** Turns one normalized simple command (`[name, ...args]`) into targets; undefined = not recognized. */
export type CommandExtractor = (args: string[], ctx: ExtractContext & { name: string }) => Raw[] | undefined;
/** Turns a structured tool input into targets; undefined = not recognized. */
export type ToolExtractor = (input: Record<string, unknown>, cwd: string) => Raw[] | undefined;

export const COMMAND_EXTRACTORS = new Map<string, CommandExtractor>();
export const TOOL_EXTRACTORS = new Map<string, ToolExtractor>();
export function registerCommandExtractor(names: string | string[], f: CommandExtractor) { for (const n of [names].flat()) COMMAND_EXTRACTORS.set(n, f); }
export function registerToolExtractor(names: string | string[], f: ToolExtractor) { for (const n of [names].flat()) TOOL_EXTRACTORS.set(n.toLowerCase(), f); }

/** Commands that act on nothing worth reporting (builtins, text plumbing): no target, not "unrecognized". */
const NO_TARGET = new Set(["echo", "printf", "true", "false", ":", "cd", "pwd", "sleep", "test", "[", "[[", "exit", "export", "set", "unset",
  "read", "wait", "which", "type", "whoami", "id", "hostname", "uname", "date", "env", "printenv", "seq", "yes", "basename", "dirname",
  "sort", "uniq", "cut", "tr", "column", "grep", "rg", "jq", "awk", "xargs", "diff"]);

const flagsOff = (args: string[]) => { const out: string[] = []; let end = false; for (const a of args) { if (!end && a === "--") { end = true; continue; } if (end || !a.startsWith("-") || a === "-") out.push(a); } return out; };
const optVal = (args: string[], ...names: string[]) => {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    for (const n of names) { if (a === n) return args[i + 1]; if (n.startsWith("--") && a.startsWith(n + "=")) return a.slice(n.length + 1); if (!n.startsWith("--") && a.startsWith(n) && a.length > n.length) return a.slice(n.length); }
  }
  return undefined;
};
const has = (args: string[], ...names: string[]) => args.some((a) => names.includes(a) || names.some((n) => /^-[a-zA-Z]$/.test(n) && /^-[a-zA-Z]+$/.test(a) && a.includes(n[1]!)));
const P = (id: string, effect: Effect, details?: Record<string, unknown>): Raw => ({ kind: "path", effect, id, ...(details ? { details } : {}) });

// paths
registerCommandExtractor(["rm", "rmdir", "unlink", "shred"], (a) => flagsOff(a).map((p) => P(p, "delete")));
registerCommandExtractor(["mkdir", "touch"], (a) => flagsOff(a.filter((x, i) => !(a[i - 1] === "-m" || a[i - 1] === "-d" || a[i - 1] === "-t" || a[i - 1] === "-r"))).map((p) => P(p, "create")));
registerCommandExtractor("truncate", (a) => flagsOff(a.filter((_, i) => a[i - 1] !== "-s" && a[i - 1] !== "-r")).map((p) => P(p, "modify")));
registerCommandExtractor(["chmod", "chown", "chgrp"], (a, c) => { const [mode, ...ps] = flagsOff(a); return ps.map((p) => P(p, "modify", c.name === "chmod" && mode ? { chmod: mode } : undefined)); });
registerCommandExtractor(["mv", "cp", "ln", "install", "rsync"], (a, c) => {
  const ps = flagsOff(a.filter((_, i) => !["-t", "--target-directory", "-S", "--suffix", "-m", "--mode", "-e"].includes(a[i - 1] ?? "")));
  if (ps.length < 2) return ps.map((p) => P(p, "read"));
  const dest = ps.at(-1)!;
  const remote = (s: string) => /^[^/\s]*[^\\/]:/.test(s) && !/^[A-Za-z]:\\/.test(s);
  const out: Raw[] = ps.slice(0, -1).map((p) => remote(p) ? remoteRaw(p) : P(p, c.name === "mv" ? "delete" : "read"));
  out.push(remote(dest) ? { ...remoteRaw(dest), effect: "send" } : P(dest, c.name === "ln" ? "create" : "modify"));
  return out;
});
registerCommandExtractor("sed", (a) => (a.some((x) => /^-[a-zA-Z]*i/.test(x) || x.startsWith("--in-place")) ? flagsOff(a.filter((_, i) => !["-e", "-f"].includes(a[i - 1] ?? ""))).slice(a.some((x) => x === "-e" || x === "-f") ? 0 : 1).map((p) => P(p, "modify")) : []));
registerCommandExtractor(["cat", "head", "tail", "less", "more", "bat", "xxd", "hexdump", "strings", "base64", "md5sum", "sha256sum"], (a) => flagsOff(a.filter((_, i) => !["-n", "-c"].includes(a[i - 1] ?? ""))).map((p) => P(p, "read")));
registerCommandExtractor("tee", (a) => flagsOff(a).map((p) => P(p, "modify")));
registerCommandExtractor(["ls", "du", "stat", "wc", "file", "tree"], (a) => flagsOff(a).map((p) => P(p, "read")));
registerCommandExtractor("df", () => []);
registerCommandExtractor("find", (a) => {
  const starts = []; for (const x of a) { if (x.startsWith("-") || x === "!" || x === "(") break; starts.push(x); }
  const del = a.includes("-delete");
  return (starts.length ? starts : ["."]).map((p) => P(p, del ? "delete" : "read", del ? { matchesOnly: true } : undefined));
});
registerCommandExtractor("dd", (a) => {
  const kv = Object.fromEntries(a.filter((x) => x.includes("=")).map((x) => [x.slice(0, x.indexOf("=")), x.slice(x.indexOf("=") + 1)]));
  const out: Raw[] = [];
  for (const [k, eff] of [["if", "read"], ["of", "modify"]] as const) {
    const v = kv[k]; if (!v) continue;
    out.push(v.startsWith("/dev/") ? { kind: "device", effect: eff, id: v } : P(v, eff));
  }
  return out;
});
// git
registerCommandExtractor("git", (a) => {
  // Global options before the subcommand (-C dir, -c key=val, --no-pager, …); a subcommand's own -c stays.
  let k = 0;
  while (k < a.length && a[k]!.startsWith("-")) k += a[k] === "-C" || a[k] === "-c" || a[k] === "--git-dir" || a[k] === "--work-tree" ? 2 : 1;
  const [sub, ...r] = a.slice(k);
  const rest = flagsOff(r);
  const ref = (id: string, effect: Effect, details?: Record<string, unknown>): Raw => ({ kind: "git-ref", effect, id, ...(details ? { details } : {}) });
  switch (sub) {
    case "status": case "log": case "diff": case "show": case "blame": case "remote": case "fetch": case "ls-files": case "rev-parse": case "describe": case "shortlog": case "reflog":
      return [ref("HEAD", "read")];
    case "branch": {
      if (has(r, "-D", "-d", "--delete")) return rest.map((b) => ref(b, "delete", { force: has(r, "-D") || r.includes("--force") }));
      if (has(r, "-m", "-M")) return rest.map((b) => ref(b, "modify"));
      return rest.length ? rest.slice(0, 1).map((b) => ref(b, "create")) : [ref("HEAD", "read")];
    }
    case "checkout": case "switch": {
      const nb = optVal(r, "-b", "-B", "-c", "-C", "--orphan");
      if (nb) return [ref(nb, "create")];
      const dd = r.indexOf("--");
      if (sub === "checkout" && dd >= 0) return r.slice(dd + 1).map((p) => P(p, "modify", { restoredFrom: "index/HEAD" }));
      return rest.length ? [ref(rest[0]!, "read", { switches: true })] : [];
    }
    case "restore": return (rest.length ? rest : ["."]).map((p) => P(p, "modify", { restoredFrom: optVal(r, "--source", "-s") ?? "index/HEAD" }));
    case "clean": return (rest.length ? rest : ["."]).map((p) => P(p, "delete", { untrackedOnly: true, includesIgnored: has(r, "-x", "-X") }));
    case "reset": return [ref("HEAD", "modify", { hard: r.includes("--hard"), to: rest[0] })];
    case "rebase": case "merge": case "cherry-pick": case "revert": case "commit": case "am": case "pull": case "stash":
      return [ref("HEAD", "modify", sub === "rebase" ? { rewritesHistory: true } : undefined)];
    case "tag": return has(r, "-d", "--delete") ? rest.map((t) => ref(`tags/${t}`, "delete")) : rest.length ? [ref(`tags/${rest[0]}`, "create")] : [];
    case "push": {
      const force = has(r, "-f") || r.some((x) => x.startsWith("--force") || x === "--mirror");
      const del = has(r, "-d") || r.includes("--delete");
      const remoteName = rest[0] ?? "origin";
      const specs = rest.slice(1);
      const details = { remote: remoteName, force, ...(r.includes("--tags") ? { tags: true } : {}) };
      if (!specs.length) return [ref(`${remoteName}/HEAD`, del ? "delete" : "publish", { ...details, currentBranch: true })];
      return specs.map((s) => {
        const plus = s.startsWith("+");
        const dst = (plus ? s.slice(1) : s).split(":").at(-1)!.replace(/^refs\/heads\//, "");
        const delSpec = s.startsWith(":");
        return ref(`${remoteName}/${dst}`, del || delSpec ? "delete" : "publish", { ...details, force: force || plus });
      });
    }
    case "clone": return [...rest.slice(0, 1).map((u) => urlRaw(u, "read")), ...rest.slice(1, 2).map((p) => P(p, "create"))];
    case "init": return (rest.length ? rest : ["."]).map((p) => P(p, "create", { gitInit: true }));
    case "add": case "mv": case "rm": return rest.map((p) => P(p, sub === "rm" ? "delete" : "modify", { git: sub }));
    default: return sub ? undefined : [];
  }
});
// urls
const urlRaw = (u: string, effect: Effect, details?: Record<string, unknown>): Raw => ({ kind: "url", effect, id: u, ...(details ? { details } : {}) });
registerCommandExtractor(["curl", "wget", "http", "https", "xh"], (a, c) => {
  const urls = a.filter((x) => /^(https?|ftp|wss?):\/\//i.test(x) || (/^[\w.-]+(:\d+)?\//.test(x) && !x.startsWith("-") && !existsSync(x)));
  const method = (optVal(a, "-X", "--request") ?? "").toUpperCase();
  const sends = !!method && method !== "GET" && method !== "HEAD"
    || a.some((x) => /^(-d|--data|--data-\w+|-F|--form|-T|--upload-file|--json|--post-data|--post-file|--body-data)(=|$)/.test(x) || /^-[dFT].+/.test(x))
    || (["http", "https", "xh"].includes(c.name) && /^(POST|PUT|PATCH|DELETE)$/i.test(a[0] ?? ""));
  const out: Raw[] = urls.map((u) => urlRaw(u, sends ? "send" : "read", { method: method || (sends ? "POST" : "GET") }));
  // curl -o FILE / -O (remote name); wget -O FILE, else the URL's file name (in -P DIR).
  const cluster = (letter: string) => { const i = a.findIndex((x) => new RegExp(`^-[a-zA-Z]*${letter}`).test(x) && !x.startsWith("--")); if (i < 0) return undefined; const rest = a[i]!.slice(a[i]!.indexOf(letter) + 1); return rest || a[i + 1]; };
  const o = c.name === "wget" ? optVal(a, "--output-document") ?? cluster("O") : optVal(a, "--output") ?? cluster("o");
  const fileOf = (u: string) => { try { return decodeURIComponent(new URL(/^[a-z]+:\/\//i.test(u) ? u : `http://${u}`).pathname.split("/").pop() || "index.html"); } catch { return undefined; } };
  if (o && o !== "-") out.push(P(o, "create"));
  else if (!o && (c.name === "wget" || has(a, "-O") || a.includes("--remote-name"))) {
    const dir = c.name === "wget" ? optVal(a, "-P", "--directory-prefix") : undefined;
    for (const u of urls) { const f = fileOf(u); if (f) out.push(P(dir ? `${dir.replace(/\/$/, "")}/${f}` : f, "create")); }
  }
  return out;
});
// processes
registerCommandExtractor(["kill"], (a) => flagsOff(a.filter((_, i) => a[i - 1] !== "-s" && a[i - 1] !== "-n")).map((p) => ({ kind: "process", effect: "delete", id: p })));
registerCommandExtractor(["pkill", "killall"], (a) => flagsOff(a.filter((_, i) => !["-u", "-g", "-s", "-t", "-P", "--signal"].includes(a[i - 1] ?? ""))).map((p) => ({ kind: "process", effect: "delete", id: p, details: { byName: true } })));
// packages
const pkgRaw = (id: string, effect: Effect, scope: string, manager: string): Raw => ({ kind: "package", effect, id, details: { scope, manager } });
registerCommandExtractor(["npm", "pnpm", "yarn", "bun"], (a, c) => {
  const [sub, ...r] = a;
  const global = has(r, "-g") || r.includes("--global") || (c.name === "yarn" && sub === "global");
  const scope = global ? "global" : "project";
  const pk = flagsOff(r).filter((x) => !(c.name === "yarn" && x === "add" && sub === "global"));
  if (["i", "install", "add", "ci"].includes(sub ?? "")) return pk.length ? pk.map((p) => pkgRaw(p, "install", scope, c.name)) : [pkgRaw("(project dependencies)", "install", scope, c.name)];
  if (["uninstall", "remove", "rm", "un", "r"].includes(sub ?? "")) return pk.map((p) => pkgRaw(p, "delete", scope, c.name));
  if (sub === "publish") return [pkgRaw(pk[0] ?? "(this package)", "publish", "registry", c.name)];
  if (["ls", "list", "outdated", "view", "info", "why", "audit"].includes(sub ?? "")) return [];
  if (["run", "test", "start", "exec", "x", "dlx", "npx", "build", "dev"].includes(sub ?? "")) return [{ kind: "process", effect: "execute", id: `${c.name} ${sub} ${pk[0] ?? ""}`.trim() }];
  return undefined;
});
registerCommandExtractor(["pip", "pip3", "uv", "poetry", "pipx"], (a, c) => {
  let [sub, ...r] = a;
  if (c.name === "uv" && sub === "pip") [sub, ...r] = r;
  const scope = c.wrappers.includes("sudo") ? "system" : r.includes("--user") ? "user" : c.name === "pipx" ? "user" : ["add", "remove"].includes(sub ?? "") ? "project" : "python-environment";
  const pk = flagsOff(r.filter((_, i) => !["-r", "--requirement", "-c", "-e", "--index-url", "-i", "--target", "-t"].includes(r[i - 1] ?? "")));
  const req = optVal(r, "-r", "--requirement");
  if (["install", "add", "sync"].includes(sub ?? "")) return [...pk.map((p) => pkgRaw(p, "install", scope, c.name)), ...(req ? [pkgRaw(`-r ${req}`, "install", scope, c.name)] : []), ...(optVal(r, "-e") ? [pkgRaw(`-e ${optVal(r, "-e")}`, "install", scope, c.name)] : [])];
  if (["uninstall", "remove"].includes(sub ?? "")) return pk.map((p) => pkgRaw(p, "delete", scope, c.name));
  if (["list", "show", "freeze", "check"].includes(sub ?? "")) return [];
  if (sub === "publish") return [pkgRaw(pk[0] ?? "(this package)", "publish", "registry", c.name)];
  return undefined;
});
registerCommandExtractor(["apt", "apt-get", "dnf", "yum", "pacman", "apk", "brew", "snap", "zypper"], (a, c) => {
  const sub = a.find((x) => !x.startsWith("-")) ?? "";
  const pk = flagsOff(a).slice(1);
  const scope = "system";
  if (/^(install|add|-S|reinstall)$/.test(sub) || has(a, "-S")) return pk.map((p) => pkgRaw(p, "install", scope, c.name));
  if (/^(remove|purge|uninstall|del|erase|autoremove)$/.test(sub) || has(a, "-R")) return pk.map((p) => pkgRaw(p, "delete", scope, c.name));
  if (/^(update|upgrade|full-upgrade|dist-upgrade)$/.test(sub) || has(a, "-Syu")) return [pkgRaw("(all packages)", "install", scope, c.name)];
  if (/^(list|search|show|info|policy)$/.test(sub)) return [];
  return undefined;
});
registerCommandExtractor(["cargo"], (a) => {
  const [sub, ...r] = a; const pk = flagsOff(r);
  if (sub === "install") return pk.map((p) => pkgRaw(p, "install", "user-global", "cargo"));
  if (sub === "add") return pk.map((p) => pkgRaw(p, "install", "project", "cargo"));
  if (sub === "remove" || sub === "uninstall") return pk.map((p) => pkgRaw(p, "delete", sub === "uninstall" ? "user-global" : "project", "cargo"));
  if (sub === "publish") return [pkgRaw("(this crate)", "publish", "registry", "cargo")];
  if (["build", "test", "run", "check", "clippy", "fmt", "bench", "doc"].includes(sub ?? "")) return [];
  return undefined;
});
// services
const svc = (id: string, effect: Effect, details?: Record<string, unknown>): Raw => ({ kind: "service", effect, id, ...(details ? { details } : {}) });
registerCommandExtractor(["systemctl", "service"], (a, c) => {
  const user = a.includes("--user");
  const words = flagsOff(a);
  const [verb, ...units] = c.name === "service" ? [words[1], words[0]] : words;
  const effect: Effect = /^(status|show|list-units|list-unit-files|is-active|is-enabled|cat)$/.test(verb ?? "") ? "read" : "modify";
  return (units.length ? units : ["(system)"]).filter(Boolean).map((u) => svc(`systemd:${u}`, effect, { verb, user }));
});
registerCommandExtractor(["docker", "podman"], (a, c) => {
  const words = flagsOff(a);
  let [sub, ...r] = words;
  if (sub === "container" || sub === "image") [sub, ...r] = r;
  if (sub === "compose" || c.name === "docker-compose") { const v = r[0]; return [svc(`compose:${v ?? "?"}`, /^(ps|ls|logs|config)$/.test(v ?? "") ? "read" : "modify")]; }
  switch (sub) {
    case "ps": case "images": case "logs": case "inspect": case "stats": case "top": case "version": case "info": return [];
    case "run": {
      const name = optVal(a, "--name");
      const image = r.find((x) => x !== name && !x.includes("=") && !/^\/|:\//.test(x));
      return [svc(`container:${name ?? image ?? "?"}`, "create", { image, privileged: a.includes("--privileged"), mountsRoot: a.some((x) => /^\/:/.test(x)) })];
    }
    case "start": case "stop": case "restart": case "kill": case "pause": case "unpause": return r.map((x) => svc(`container:${x}`, sub === "kill" ? "delete" : "modify"));
    case "rm": case "rmi": case "prune": return (r.length ? r : ["(all unused)"]).map((x) => svc(`${sub === "rmi" ? "image" : "container"}:${x}`, "delete"));
    case "exec": return [svc(`container:${r[0] ?? "?"}`, "execute")];
    case "push": return [svc(`image:${r[0] ?? "?"}`, "publish")];
    case "build": case "pull": return [svc(`image:${optVal(a, "-t", "--tag") ?? r[0] ?? "?"}`, "create")];
    default: return undefined;
  }
});
registerCommandExtractor("tmux", (a) => {
  const sub = a[0] ?? "";
  const t = optVal(a, "-t", "-s");
  if (/^(ls|list-sessions|list-windows|capture-pane|display-message|has-session|show-options)$/.test(sub)) return [];
  if (/^(new|new-session)$/.test(sub)) return [svc(`tmux:${t ?? "?"}`, "create")];
  if (/^(kill-session|kill-server|kill-window|kill-pane)$/.test(sub)) return [svc(`tmux:${t ?? (sub === "kill-server" ? "(server)" : "?")}`, "delete")];
  if (/^(send-keys|send)$/.test(sub)) return [svc(`tmux:${t ?? "?"}`, "execute")];
  return undefined;
});
// devices
const dev = (id: string, effect: Effect, details?: Record<string, unknown>): Raw => ({ kind: "device", effect, id, ...(details ? { details } : {}) });
registerCommandExtractor(["mount", "umount"], (a, c) => { const w = flagsOff(a); return w.length ? w.map((d) => dev(d, "modify", { op: c.name })) : (c.name === "mount" ? [] : undefined); });
registerCommandExtractor(["mkfs", "mkfs.ext4", "mkfs.vfat", "mkfs.fat", "mkfs.btrfs", "mkfs.xfs", "fdisk", "parted", "sfdisk", "wipefs", "blkdiscard"], (a, c) => flagsOff(a).filter((x) => x.startsWith("/dev/")).map((d) => dev(d, "modify", { op: c.name, destructive: true })));
registerCommandExtractor(["flashrom", "esptool", "esptool.py", "avrdude", "openocd", "dfu-util", "fastboot", "st-flash", "picotool"], (a, c) => [dev(optVal(a, "-p", "--port", "-P", "-c") ?? c.name, "modify", { op: c.name, flash: true })]);
registerCommandExtractor("adb", (a) => {
  const sub = flagsOff(a)[0] ?? "";
  const serial = optVal(a, "-s");
  const id = `adb:${serial ?? "default"}`;
  if (/^(devices|logcat|get-state|get-serialno|version)$/.test(sub)) return [dev(id, "read", { op: sub })];
  if (sub === "pull") return [dev(id, "read", { op: sub })];
  return [dev(id, sub === "push" || sub === "install" || sub === "uninstall" || sub === "reboot" ? "modify" : "execute", { op: sub })];
});
registerCommandExtractor(["picocom", "minicom", "screen", "cu", "stty"], (a, c) => {
  const d = a.find((x) => x.startsWith("/dev/tty") || x.startsWith("/dev/serial") || x.startsWith("/dev/cu."));
  return d ? [dev(d, c.name === "stty" ? "modify" : "send", { op: c.name })] : c.name === "screen" ? [] : undefined;
});
registerCommandExtractor(["lsblk", "lsusb", "lspci", "free", "uptime", "ps", "pgrep", "top", "nvidia-smi", "rocm-smi", "ip", "ifconfig", "ss", "netstat", "journalctl", "dmesg"], () => []);
// remote hosts
const remoteRaw = (s: string): Raw => {
  const i = s.indexOf(":");
  return { kind: "remote-host", effect: "read", id: s.slice(0, i), remote: true, details: { path: s.slice(i + 1) } };
};
const SSH_OPT_ARGS = new Set(["-p", "-i", "-l", "-o", "-F", "-J", "-L", "-R", "-D", "-W", "-b", "-c", "-E", "-e", "-I", "-m", "-O", "-Q", "-S", "-w", "-B"]);
registerCommandExtractor(["ssh", "mosh"], (a) => {
  let i = 0;
  while (i < a.length && a[i]!.startsWith("-")) i += SSH_OPT_ARGS.has(a[i]!) ? 2 : 1;
  const host = a[i];
  if (!host) return undefined;
  const cmd = a.slice(i + 1).join(" ");
  const out: Raw[] = [{ kind: "remote-host", effect: cmd ? "execute" : "read", id: host, remote: true, ...(cmd ? { details: { command: cmd.slice(0, 300) } } : { details: { interactive: true } }) }];
  // What the remote command acts on is on the remote host: reported as remote, nothing resolved locally.
  if (cmd) for (const t of extractShell(cmd, "/").targets) out.push({ ...t, remote: true, existsNow: undefined, inScope: undefined, details: { ...t.details, host } });
  return out;
});
registerCommandExtractor("scp", (a) => {
  const ps = flagsOff(a.filter((_, i) => !["-P", "-i", "-o", "-F", "-J", "-l", "-c", "-S"].includes(a[i - 1] ?? "")));
  if (ps.length < 2) return undefined;
  const isRemote = (s: string) => /^[^/\s]*[^\\/]:/.test(s);
  const dest = ps.at(-1)!;
  return [...ps.slice(0, -1).map((s) => isRemote(s) ? remoteRaw(s) : P(s, "read")), isRemote(dest) ? { ...remoteRaw(dest), effect: "send" as Effect } : P(dest, "modify")];
});
// secrets
const secret = (id: string, effect: Effect): Raw => ({ kind: "secret-ish", effect, id });
registerCommandExtractor(["nibwarden", "bw", "rbw", "op", "pass", "gopass", "secret-tool", "security", "keyring", "vault"], (a, c) => {
  const sub = flagsOff(a)[0] ?? "";
  return [secret(`${c.name}${sub ? " " + sub : ""}`, /^(get|read|show|list|ls|find|lookup|status|item|unlock|run|find-generic-password|find-internet-password)$/.test(sub) ? "read" : "modify")];
});
registerCommandExtractor(["gpg"], (a) => [secret("gpg", has(a, "-d") || a.includes("--decrypt") ? "read" : a.some((x) => /--(delete|gen|import)/.test(x)) ? "modify" : "read")]);
registerCommandExtractor(["printenv"], (a) => [secret(a.length ? `env:${a.join(",")}` : "environment", "read")]);

// structured tools
registerToolExtractor(["read", "notebookread", "lsp"], (i) => strs(i, "file_path", "notebook_path", "path", "filePath").map((p) => P(p, "read")));
registerToolExtractor(["grep", "glob", "list", "ls", "find"], (i) => { const p = strs(i, "path", "file_path"); return (p.length ? p : ["."]).map((x) => P(x, "read")); });
registerToolExtractor(["write"], (i) => strs(i, "file_path", "path", "filePath").map((p) => P(p, existsSync(p) ? "modify" : "create")));
registerToolExtractor(["edit", "multiedit", "notebookedit", "patch"], (i) => [...strs(i, "file_path", "notebook_path", "path", "filePath"), ...(Array.isArray(i.patterns) ? i.patterns.filter((x): x is string => typeof x === "string") : [])].map((p) => P(p, "modify")));
registerToolExtractor(["webfetch", "fetch"], (i) => strs(i, "url").map((u) => urlRaw(u, "read")));
registerToolExtractor(["websearch"], () => []);
function strs(i: Record<string, unknown>, ...keys: string[]) { return keys.map((k) => i[k]).filter((v): v is string => typeof v === "string" && !!v); }

const SHELL_TOOLS = new Set(["bash", "shell", "local_shell", "exec", "exec_command", "run_command", "powershell"]);
/** Raw shell commands of a request (Claude `command`, codex string or argv, opencode patterns / metadata.command). */
export function shellCommands(tool: string, input: unknown): string[] {
  const o = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : undefined;
  if (!o || !SHELL_TOOLS.has(tool.toLowerCase())) return [];
  const out: string[] = [];
  if (typeof o.command === "string") out.push(o.command);
  else if (Array.isArray(o.command)) out.push(o.command.filter((x): x is string => typeof x === "string").map(shellQuote).join(" "));
  if (Array.isArray(o.patterns)) out.push(...o.patterns.filter((x): x is string => typeof x === "string"));
  const meta = o.metadata as Record<string, unknown> | undefined;
  if (typeof meta?.command === "string") out.push(meta.command);
  return [...new Set(out)];
}

function extractShell(line: string, cwd: string, dialect: ShellDialect = "unknown"): { targets: Raw[]; unrecognized: string[] } {
  const analysis = analyzeShell(line, dialect);
  if (!analysis.parsed) return { targets: [], unrecognized: [`(${dialect} command: not parsed)`] };
  const targets: Raw[] = [];
  const unrecognized: string[] = [];
  for (const words of analysis.commands) {
    const [name, ...args] = words;
    if (!name) continue;
    if (/[$`]/.test(name)) { targets.push({ kind: "process", effect: "execute", id: name, unresolved: true, reason: "command name comes from a variable or substitution", via: name }); continue; }
    const f = COMMAND_EXTRACTORS.get(name) ?? (name.startsWith("mkfs.") ? COMMAND_EXTRACTORS.get("mkfs") : undefined);
    const got = f?.(args, { name, cwd, analysis, wrappers: analysis.wrappers });
    if (got) { for (const t of got) targets.push({ via: words.slice(0, 3).join(" "), ...t }); continue; }
    if (!NO_TARGET.has(name)) unrecognized.push(f ? `${name} ${args.find((x) => !x.startsWith("-")) ?? ""}`.trim() : name);
  }
  for (const r of analysis.redirects) {
    if (r.target === "/dev/null" || /^\/dev\/(stdout|stderr|fd\/)/.test(r.target)) continue;
    targets.push({ ...P(r.target, r.op === "<" ? "read" : r.op === ">>" ? "modify" : existsSync(absPath(r.target, cwd)) ? "modify" : "create", { redirect: r.op }), via: `${r.op} redirect` });
  }
  // `-o FILE` / `--output FILE` on any command writes that file.
  for (const words of analysis.commands) {
    const o = optVal(words.slice(1), "--output", "--out", "-o");
    if (o && !COMMAND_EXTRACTORS.has(words[0]!) && !o.startsWith("-") && words[0] !== "ssh") targets.push({ ...P(o, existsSync(absPath(o, cwd)) ? "modify" : "create", { outputFlag: true }), via: words[0]! });
  }
  return { targets, unrecognized: [...new Set(unrecognized)] };
}

/** Raw targets (no provenance) of a request: structured tool extractors, or the shell extractors for shell tools. */
export function extractRaw(tool: string, input: unknown, cwd: string, dialect?: ShellDialect): { targets: Raw[]; unrecognized: string[] } {
  const cmds = shellCommands(tool, input);
  if (cmds.length) {
    const all = cmds.map((c) => extractShell(c, cwd, dialect));
    return { targets: all.flatMap((x) => x.targets), unrecognized: [...new Set(all.flatMap((x) => x.unrecognized))] };
  }
  const o = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : undefined;
  const f = TOOL_EXTRACTORS.get(tool.toLowerCase());
  const got = o && f ? f(o, cwd) : undefined;
  if (got) return { targets: got.map((t) => ({ via: tool, ...t })), unrecognized: [] };
  // MCP and other tools: only the obvious (an argument named path / file / url).
  if (o) {
    const ts: Raw[] = [];
    for (const [k, v] of Object.entries(o)) {
      if (typeof v !== "string") continue;
      if (/^(url|uri|endpoint)$/i.test(k)) ts.push({ ...urlRaw(v, "read"), via: tool });
      else if (/^(path|file|file_?path|filename|dir|directory)$/i.test(k)) ts.push({ ...P(v, "read"), via: tool });
    }
    if (ts.length) return { targets: ts, unrecognized: [] };
  }
  return { targets: [], unrecognized: [tool] };
}

// ── provenance (per kind) ──────────────────────────────────────────────────

export interface ProvenanceContext {
  cwd: string;
  /** Write scope (dirScope, else cwd); undefined at the unrestricted level (inScope then uses cwd). */
  scope?: string[];
  ledger: SessionLedger;
  /** The request's shell dialect (requestDialect). */
  dialect?: ShellDialect;
}
type Enricher = (t: RequestTarget, ctx: ProvenanceContext, cache: Map<string, Promise<unknown>>) => Promise<void>;
export const KIND_PROVENANCE = new Map<TargetKind, Enricher>();

const expandHome = (p: string) => (p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);
const normPath = (p: string) => { const n = normalize(p); return n.length > 1 ? n.replace(/\/+$/, "") : n; };
const absPath = (p: string, cwd: string) => normPath(resolve(cwd, expandHome(p)));
function realish(p: string): string { try { return realpathSync(p); } catch { const d = dirname(p); return d === p ? p : join(realish(d), basename(p)); } }
const inside = (p: string, dirs: string[]) => dirs.some((d) => { const r = relative(normalize(d), p); return r === "" || (!r.startsWith("..") && !isAbsolute(r)); });

async function run(cmd: string[], cwd: string, ms = 2000): Promise<{ code: number; out: string }> {
  try {
    const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "ignore", stdin: "ignore", env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" } });
    const timer = setTimeout(() => p.kill(), ms);
    const out = await new Response(p.stdout).text();
    const code = await p.exited;
    clearTimeout(timer);
    return { code, out: out.trim() };
  } catch { return { code: -1, out: "" }; }
}
const nearestDir = (p: string) => { let d = p; while (!existsSync(d) || !lstatSync(d).isDirectory()) { const up = dirname(d); if (up === d) return d; d = up; } return d; };
const cached = <T>(cache: Map<string, Promise<unknown>>, key: string, f: () => Promise<T>) => { if (!cache.has(key)) cache.set(key, f()); return cache.get(key) as Promise<T>; };

/** Category guess from the path: generated (build/cache/tmp/output-like) vs source / config / data. */
export function pathCategory(p: string): "generated" | "source" | "config" | "data" | "secret" | "unknown" {
  const parts = normPath(p).split("/").filter(Boolean);
  const name = parts.at(-1) ?? "";
  if (SECRETISH.test(p)) return "secret";
  // Startup files and hooks run later as code: config, whatever their name.
  if (/^\.(profile|bash_profile|bash_login|bash_logout|zshenv|zprofile|zlogin|zlogout|login|xinitrc|xprofile)$|^authorized_keys$|^crontab$/.test(name)
    || parts.some((s) => s === ".config" || s === "autostart" || s === "systemd" || s === "cron.d") || /(^|\/)\.git\/hooks\/|(^|\/)\.github\/workflows\//.test(normPath(p))) return "config";
  const GEN = /^(build|builds|dist|out|output|outputs|target|node_modules|__pycache__|\.cache|cache|caches|tmp|temp|\.tmp|coverage|\.next|\.nuxt|\.turbo|\.parcel-cache|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.tox|\.gradle|logs?|checkpoints?|ckpts?|runs|wandb|lightning_logs|artifacts|\.venv|venv)$/i;
  if (parts.some((s) => GEN.test(s) || /^out[\w.-]*$/i.test(s) || /_outputs?(\b|_|$)/i.test(s) || /^outputs?_/i.test(s) || /^tmp[\w.-]*/i.test(s) || /checkpoint/i.test(s))) return "generated";
  if (/\.(log|tmp|bak|pyc|pyo|o|obj|a|so\.\d|class|swp)$/i.test(name)) return "generated";
  if (/^(\.env.*|.*\.(json|ya?ml|toml|ini|cfg|conf|config)|\.\w+rc|Dockerfile|Makefile|.*\.lock|package\.json)$/i.test(name)) return "config";
  if (/\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|c|cc|cpp|h|hpp|java|kt|swift|rb|php|sh|lua|cs|scala|sql|md|rst|html|css|scss|vue|svelte|proto)$/i.test(name)) return "source";
  if (/\.(csv|tsv|parquet|feather|arrow|db|sqlite3?|npz|npy|h5|hdf5|pt|pth|ckpt|safetensors|onnx|bin|jsonl|xlsx?|pdf|png|jpe?g|gif|wav|mp[34]|zip|tar|gz)$/i.test(name)) return "data";
  return "unknown";
}
const SECRETISH = /(^|\/)(\.env(\.|$)|\.ssh\/|id_(rsa|ed25519|ecdsa)|.*\.pem$|.*\.key$|\.aws\/credentials|\.netrc|\.npmrc|\.pypirc|credentials(\.json)?$|\.kube\/config|kubeconfig|\.gnupg\/|\.docker\/config\.json|\.git-credentials|secrets?(\.|\/|$))/i;

function dirSize(p: string, budget = 2000): { size?: number; truncated?: boolean } {
  let size = 0, n = 0;
  const stack = [p];
  while (stack.length) {
    const d = stack.pop()!;
    let entries: import("node:fs").Dirent[];
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (++n > budget) return { truncated: true };
      const f = join(d, e.name);
      if (e.isDirectory()) stack.push(f); else if (e.isFile()) { try { size += lstatSync(f).size; } catch { /* gone */ } }
    }
  }
  return { size };
}

KIND_PROVENANCE.set("path", async (t, ctx, cache) => {
  if (t.remote) return;
  if (/[*?[\]{}]/.test(t.id)) { t.unresolved = true; t.reason = "glob pattern"; return; }
  if (/[$`]/.test(t.id)) { t.unresolved = true; t.reason = "variable or substitution"; return; }
  const abs = absPath(t.id, ctx.cwd);
  const scope = ctx.scope ?? [ctx.cwd];
  // Categorize below the cwd when inside it (a /tmp/... project must not read as "tmp").
  const rel = relative(ctx.cwd, abs);
  const d: Record<string, unknown> = { ...t.details, abs, category: pathCategory(rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : abs) };
  t.inScope = inside(abs, scope) && inside(realish(abs), scope.map(realish));
  let st: import("node:fs").Stats | undefined;
  try { st = lstatSync(abs); } catch { /* missing */ }
  t.existsNow = !!st;
  t.createdThisSession = ctx.ledger.createdPath(abs);
  const inside_ = ctx.ledger.createdInside(abs);
  if (inside_) d.createdInsideThisSession = inside_;
  if (st) {
    d.type = st.isDirectory() ? "dir" : st.isSymbolicLink() ? "symlink" : "file";
    d.mtime = new Date(st.mtimeMs).toISOString();
    d.modifiedThisSession = st.mtimeMs >= ctx.ledger.startedAt;
    if (st.isDirectory()) Object.assign(d, dirSize(abs)); else d.size = st.size;
  }
  // git: tracked / untracked / ignored / not in a repo (also for a path that does not exist yet).
  const dir = nearestDir(st?.isDirectory() ? abs : dirname(abs));
  const top = await cached(cache, `top:${dir}`, () => run(["git", "rev-parse", "--show-toplevel"], dir));
  if (top.code !== 0) d.git = "not-in-repo";
  else if (!st) d.git = "missing";
  else if ((await run(["git", "ls-files", "-z", "--", abs], dir)).out) d.git = st.isDirectory() ? "contains-tracked" : "tracked";
  else d.git = (await run(["git", "check-ignore", "-q", "--", abs], dir)).code === 0 ? "ignored" : "untracked";
  t.details = d;
});

const PROTECTED = /^(main|master|trunk|develop|development|release(\/.*)?|prod|production|stable|gh-pages)$/;
KIND_PROVENANCE.set("git-ref", async (t, ctx, cache) => {
  const dir = nearestDir(ctx.cwd);
  const d: Record<string, unknown> = { ...t.details };
  const top = await cached(cache, `top:${dir}`, () => run(["git", "rev-parse", "--show-toplevel"], dir));
  if (top.code !== 0) { d.git = "not-in-repo"; t.details = d; return; }
  let branch = t.id.replace(/^tags\//, "");
  const remoteName = typeof d.remote === "string" ? d.remote : undefined;
  if (remoteName && branch.startsWith(`${remoteName}/`)) branch = branch.slice(remoteName.length + 1);
  if (branch === "HEAD") {
    const cur = await cached(cache, `head:${dir}`, () => run(["git", "rev-parse", "--abbrev-ref", "HEAD"], dir));
    if (cur.code === 0 && cur.out !== "HEAD") { branch = cur.out; d.branch = branch; }
  }
  if (!t.id.startsWith("tags/")) {
    const def = await cached(cache, `def:${dir}:${remoteName ?? "origin"}`, () => run(["git", "symbolic-ref", "--short", `refs/remotes/${remoteName ?? "origin"}/HEAD`], dir));
    const defaultBranch = def.code === 0 ? def.out.replace(/^[^/]+\//, "") : undefined;
    d.isDefaultBranch = defaultBranch ? branch === defaultBranch : branch === "main" || branch === "master";
    if (defaultBranch) d.defaultBranch = defaultBranch;
    d.isProtected = PROTECTED.test(branch) || !!d.isDefaultBranch;
    t.existsNow = (await run(["git", "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], dir)).code === 0;
    if ((await run(["git", "for-each-ref", "--count=1", "--format=%(refname)", `refs/remotes/*/${branch}`], dir)).out) d.onRemote = true;
  }
  t.createdThisSession = ctx.ledger.has("git-ref", branch) || ctx.ledger.has("git-ref", t.id);
  t.details = d;
});

const LOCAL = /^(localhost|127\.\d+\.\d+\.\d+|::1|\[::1\]|0\.0\.0\.0)$/i;
const LAN = /^(10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|[\w-]+\.(local|lan|home|internal)|[\w-]+)$/i;
KIND_PROVENANCE.set("url", async (t, ctx, cache) => {
  let host: string | undefined;
  try { host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(t.id) ? t.id : `http://${t.id}`).hostname; } catch { /* unparsable */ }
  if (!host) { t.unresolved = true; t.reason = "unparsable URL"; return; }
  if (/[$`]/.test(t.id)) { t.unresolved = true; t.reason = "variable or substitution"; return; }
  const remotes = await cached(cache, `remotes:${ctx.cwd}`, () => run(["git", "remote", "-v"], nearestDir(ctx.cwd)));
  const projectHosts = new Set([...remotes.out.matchAll(/(?:@|:\/\/)([^/:\s]+)[:/]/g)].map((m) => m[1]!.toLowerCase()));
  const hostClass = LOCAL.test(host) ? "localhost" : projectHosts.has(host.toLowerCase()) ? "project-remote" : LAN.test(host) ? "lan" : "external";
  t.details = { ...t.details, host, hostClass };
});

KIND_PROVENANCE.set("process", async (t, ctx) => {
  const d: Record<string, unknown> = { ...t.details };
  if (/^\d+$/.test(t.id)) {
    const pid = t.id;
    t.existsNow = existsSync(`/proc/${pid}`);
    if (t.existsNow) {
      try { d.name = readFileSync(`/proc/${pid}/comm`, "utf8").trim(); } catch { /* raced */ }
      try { const uid = /^Uid:\s+(\d+)/m.exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1]; d.ownedByUser = uid !== undefined && Number(uid) === process.getuid?.(); } catch { /* raced */ }
    }
    d.ownedBySession = ctx.ledger.has("process", pid) || (typeof d.name === "string" && ctx.ledger.has("process", d.name));
  } else if (/^%\d+$/.test(t.id)) {
    d.jobSpec = true; d.ownedBySession = false; // a job of some shell: which one can't be checked
  } else {
    d.ownedBySession = false; // by name: may match processes this session did not start
  }
  t.createdThisSession = !!d.ownedBySession;
  t.details = d;
});

KIND_PROVENANCE.set("package", async (t, ctx) => { t.createdThisSession = ctx.ledger.has("package", t.id); t.inScope = t.details?.scope === "project"; });
KIND_PROVENANCE.set("service", async (t, ctx) => { t.createdThisSession = ctx.ledger.has("service", t.id); });
KIND_PROVENANCE.set("secret-ish", async () => {});
KIND_PROVENANCE.set("device", async (t) => { if (t.id.startsWith("/dev/")) t.existsNow = existsSync(t.id); });
KIND_PROVENANCE.set("remote-host", async (t) => { t.remote = true; });

/**
 * Targets of a request with their provenance. At most `max` targets get provenance (git and filesystem checks are
 * bounded); paths that look like secrets also get a `secret-ish` target.
 */
export async function describeTargets(tool: string, input: unknown, ctx: ProvenanceContext, max = 12): Promise<TargetReport> {
  const raw = extractRaw(tool, input, ctx.cwd, ctx.dialect);
  const targets: RequestTarget[] = raw.targets.map((t) => ({ via: tool, ...t }));
  for (const t of [...targets]) {
    if (t.kind === "path" && !t.remote && SECRETISH.test(t.id)) targets.push({ kind: "secret-ish", effect: t.effect, id: t.id, via: t.via });
  }
  const cache = new Map<string, Promise<unknown>>();
  const shown = targets.slice(0, max);
  await Promise.all(shown.map((t) => KIND_PROVENANCE.get(t.kind)?.(t, ctx, cache).catch(() => { t.unresolved = true; t.reason = "provenance check failed"; })));
  for (const t of targets.slice(max)) { t.unresolved = true; t.reason = "too many targets"; }
  return { targets, unrecognized: raw.unrecognized };
}
