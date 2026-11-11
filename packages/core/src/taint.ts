// Taint tracking for the approval judge (docs §10.4): which untrusted sources have entered the agent's context,
// from the actions the harness observed (deterministic: what was read, not what it said). A registry of small
// detectors, extensible like targets: each looks at one observed action and names the untrusted sources it brought
// in. Message origins of the turn (peer, cron, A2A, untrusted humans) are added by the runtime.
import { isAbsolute, normalize, relative, resolve } from "node:path";
import { analyzeShell, type ShellDialect } from "./shell.ts";
import { extractRaw, type SessionLedger } from "./targets.ts";

export type TaintKind =
  | "web" | "network" | "remote-output" | "third-party-tool"
  | "outside-scope-read" | "untracked-file-read" | "tracked-file-read"
  | "peer-message" | "cron-message" | "a2a-message" | "untrusted-human";

export interface TaintSource {
  kind: TaintKind;
  /** What it was (URL, tool, path, session, host): a label written by the agent or a peer, untrusted. */
  id: string;
  /** When it entered (ms). */
  at: number;
}

export interface TaintContext {
  cwd: string;
  /** Directories the session works in (dirScope, else cwd). */
  scope: string[];
  ledger: SessionLedger;
  /** Reads of git-tracked files in the project are not taint (default true). */
  trustRepoFiles: boolean;
  /** Tool-name patterns of MCP tools whose results are third-party content. */
  thirdPartyTools: RegExp[];
  dialect?: ShellDialect;
  at: number;
}

export type TaintDetector = (tool: string, input: unknown, ctx: TaintContext) => TaintSource[] | Promise<TaintSource[]>;
export const TAINT_DETECTORS: TaintDetector[] = [];
export function registerTaintDetector(f: TaintDetector) { TAINT_DETECTORS.push(f); }

/** MCP tools whose results usually come from third parties: mail, chat, issues, docs, browsers, the web. */
export const DEFAULT_THIRD_PARTY_TOOLS = [
  "mail", "gmail", "outlook", "imap", "inbox", "slack", "discord", "telegram", "teams", "whatsapp", "chat", "message",
  "notion", "confluence", "jira", "linear", "github", "gitlab", "bitbucket", "issue", "pull_?request", "comment",
  "docs?", "drive", "sheets", "calendar", "browser", "playwright", "puppeteer", "chrome", "web", "fetch", "search",
  "scrape", "crawl", "reddit", "twitter", "rss", "news", "youtube",
];

const lc = (s: string) => s.toLowerCase();
const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined);
const str = (o: Record<string, unknown> | undefined, ...keys: string[]) => { for (const k of keys) if (typeof o?.[k] === "string") return o[k] as string; return undefined; };
const SHELL_TOOLS = new Set(["bash", "shell", "local_shell", "exec", "exec_command", "run_command", "powershell"]);

// Web tools.
registerTaintDetector((tool, input, ctx) => {
  const t = lc(tool);
  if (!["webfetch", "websearch", "web_search", "web_fetch", "fetch"].includes(t)) return [];
  const o = obj(input);
  return [{ kind: "web", id: str(o, "url", "query", "q") ?? tool, at: ctx.at }];
});

// MCP tools: UniQlaw's own peer tools bring peer text; third-party servers by name pattern.
registerTaintDetector((tool, _input, ctx) => {
  if (!tool.startsWith("mcp__")) return [];
  if (/^mcp__uniqlaw__(agent_ask|task_status)$/.test(tool)) return [{ kind: "peer-message", id: tool, at: ctx.at }];
  if (tool.startsWith("mcp__uniqlaw__")) return [];
  return ctx.thirdPartyTools.some((re) => re.test(tool)) ? [{ kind: "third-party-tool", id: tool, at: ctx.at }] : [];
});

// Shell: network reads and remote output (through the shell normalizer).
const NET_READERS = new Set(["curl", "wget", "http", "https", "xh", "httpie", "aria2c", "lynx", "links", "w3m", "nc", "ncat", "socat", "ftp", "tftp"]);
const GH_NETWORK = /^(api|issue|pr|repo|release|run|search|gist|browse|workflow|discussion)$/;
registerTaintDetector((tool, input, ctx) => {
  if (!SHELL_TOOLS.has(lc(tool))) return [];
  const o = obj(input);
  const cmds: string[] = [];
  if (typeof o?.command === "string") cmds.push(o.command);
  else if (Array.isArray(o?.command)) cmds.push(o.command.filter((x): x is string => typeof x === "string").map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" "));
  const out: TaintSource[] = [];
  for (const c of cmds) {
    const a = analyzeShell(c, ctx.dialect ?? "unknown");
    for (const w of a.commands) {
      const [name, ...args] = w;
      if (!name) continue;
      if (NET_READERS.has(name)) out.push({ kind: "network", id: args.find((x) => /^[a-z]+:\/\/|^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(x)) ?? name, at: ctx.at });
      else if (name === "gh" && GH_NETWORK.test(args.find((x) => !x.startsWith("-")) ?? "")) out.push({ kind: "network", id: `gh ${args.find((x) => !x.startsWith("-"))}`, at: ctx.at });
      else if (name === "git" && args.includes("clone")) out.push({ kind: "network", id: args.filter((x) => !x.startsWith("-")).at(1) ?? "git clone", at: ctx.at });
      else if (name === "scp" || name === "rsync") { const remote = args.find((x) => /^[^/\s]*[^\\/]:/.test(x)); if (remote) out.push({ kind: "remote-output", id: remote.split(":")[0]!, at: ctx.at }); }
    }
    for (const r of a.remote) out.push({ kind: "remote-output", id: `${r.via} ${r.host}`, at: ctx.at });
  }
  return out;
});

// Reads of files: outside the scope, or inside it but neither created by this session nor tracked by git.
const inside = (p: string, dirs: string[]) => dirs.some((d) => { const r = relative(normalize(d), p); return r === "" || (!r.startsWith("..") && !isAbsolute(r)); });
async function gitTracked(abs: string, cwd: string): Promise<"tracked" | "untracked" | "not-in-repo"> {
  try {
    const run = async (args: string[]) => {
      const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore", stdin: "ignore", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
      const t = setTimeout(() => p.kill(), 2000);
      const out = await new Response(p.stdout).text();
      const code = await p.exited;
      clearTimeout(t);
      return { code, out: out.trim() };
    };
    if ((await run(["rev-parse", "--show-toplevel"])).code !== 0) return "not-in-repo";
    return (await run(["ls-files", "-z", "--", abs])).out ? "tracked" : "untracked";
  } catch { return "not-in-repo"; }
}
registerTaintDetector(async (tool, input, ctx) => {
  const reads = extractRaw(tool, input, ctx.cwd, ctx.dialect).targets.filter((t) => t.kind === "path" && t.effect === "read" && !t.remote && !t.unresolved && !/[*?[\]{}$`]/.test(t.id));
  const out: TaintSource[] = [];
  for (const t of reads.slice(0, 10)) {
    const abs = resolve(ctx.cwd, t.id.startsWith("~/") ? `${process.env.HOME}/${t.id.slice(2)}` : t.id);
    if (!inside(abs, ctx.scope)) { out.push({ kind: "outside-scope-read", id: t.id, at: ctx.at }); continue; }
    if (ctx.ledger.createdPath(abs)) continue; // the session's own writes
    const g = await gitTracked(abs, ctx.cwd);
    if (g === "tracked") { if (!ctx.trustRepoFiles) out.push({ kind: "tracked-file-read", id: t.id, at: ctx.at }); }
    else if (g === "untracked") out.push({ kind: "untracked-file-read", id: t.id, at: ctx.at });
    else if (!ctx.trustRepoFiles) out.push({ kind: "tracked-file-read", id: t.id, at: ctx.at }); // no repo: only when the project itself is untrusted
  }
  return out;
});

/** The untrusted sources one observed action brought in (all detectors; a failing detector reports nothing). */
export async function detectTaint(tool: string, input: unknown, ctx: TaintContext): Promise<TaintSource[]> {
  const all = await Promise.all(TAINT_DETECTORS.map(async (d) => { try { return await d(tool, input, ctx); } catch { return []; } }));
  return all.flat();
}

export const compileToolPatterns = (patterns: string[] | undefined) =>
  (patterns ?? DEFAULT_THIRD_PARTY_TOOLS).map((p) => { try { return new RegExp(p, "i"); } catch { return undefined; } }).filter((r): r is RegExp => !!r);
