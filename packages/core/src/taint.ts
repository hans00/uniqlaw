// Taint tracking for the approval judge (docs §10.4): which untrusted sources have entered the agent's context,
// from the actions the harness observed (deterministic: what was read, not what it said). A registry of small
// detectors, extensible like targets: each looks at one observed action and names the untrusted sources it brought
// in. Message origins of the turn (peer, cron, A2A, untrusted humans) are added by the runtime, which also keeps
// the taint of a turn (never derived from the bounded trace window) and carries it into the next turns.
import { isAbsolute, normalize, relative, resolve } from "node:path";
import { INTERPRETER_NAME, analyzeShell, type ShellDialect } from "./shell.ts";
import { extractRaw, type SessionLedger } from "./targets.ts";

export type TaintKind =
  | "web" | "network" | "remote-output" | "third-party-tool" | "subagent-output"
  | "outside-scope-read" | "untracked-file-read" | "tracked-file-read" | "tainted-file-read"
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
  /** Tool-name patterns of MCP tools that are local (memory, notes): never third-party, even if a pattern above matches. */
  localTools?: RegExp[];
  /** Files this session wrote while its context was tainted (absolute path → whether it carries taint). */
  taintedPath?: (abs: string) => boolean;
  dialect?: ShellDialect;
  at: number;
}

export type TaintDetector = (tool: string, input: unknown, ctx: TaintContext) => TaintSource[] | Promise<TaintSource[]>;
export const TAINT_DETECTORS: TaintDetector[] = [];
export function registerTaintDetector(f: TaintDetector) { TAINT_DETECTORS.push(f); }

/** Words in an MCP server's name for services whose results come from third parties: mail, chat, issues, docs,
 *  browsers, the web. Matched on the server part only (`mcp__<server>__…`), so a local tool called `search` is not one. */
const SERVICE_WORDS = "mail|gmail|outlook|imap|inbox|slack|discord|telegram|teams|whatsapp|signal|chat|message|notion|confluence|jira|linear|github|gitlab|" +
  "bitbucket|issue|docs?|drive|sheets|calendar|browser|playwright|puppeteer|chrome|firefox|web|fetch|search|scrape|crawl|reddit|twitter|rss|news|" +
  "youtube|brave|tavily|exa|perplexity|firecrawl|apify|zapier|hubspot|salesforce|intercom|zendesk|asana|trello|figma|dropbox|sharepoint|onedrive";
/** Tool names (the part after the server) that fetch from the web, whatever the server is called. */
const WEB_TOOL_WORDS = "web_?search|search_web|web_?fetch|fetch_url|fetch_page|read_url|get_url|http_get|http_request|browse|navigate|scrape|crawl|google_search|bing_search";
export const DEFAULT_THIRD_PARTY_TOOLS = [
  `^mcp__(?:(?!__).)*?(?:${SERVICE_WORDS})(?:(?!__).)*__`,
  `^mcp__.+__(?:\\w*?_)?(?:${WEB_TOOL_WORDS})\\w*$`,
];
/** Local memory / notes servers: their results are the operator's own data (claude-mem-lite, memory, notes). */
export const DEFAULT_LOCAL_TOOLS = ["^mcp__(?:(?!__).)*?(?:mem|memory|notes?|knowledge|obsidian|filesystem|sqlite)(?:(?!__).)*__"];

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

// Subagents: their result is whatever the subagent read (web pages, files, tool output), summarized.
registerTaintDetector((tool, input, ctx) => {
  if (!["task", "agent", "spawn_agent", "subagent", "dispatch_agent"].includes(lc(tool))) return [];
  const o = obj(input);
  return [{ kind: "subagent-output", id: str(o, "description", "subagent_type", "name") ?? tool, at: ctx.at }];
});

// MCP tools: UniQlaw's own peer tools bring peer text; local memory is the operator's; third-party servers by name pattern.
registerTaintDetector((tool, _input, ctx) => {
  if (!tool.startsWith("mcp__")) return [];
  if (/^mcp__uniqlaw__(agent_ask|task_status)$/.test(tool)) return [{ kind: "peer-message", id: tool, at: ctx.at }];
  if (tool.startsWith("mcp__uniqlaw__")) return [];
  if ((ctx.localTools ?? []).some((re) => re.test(tool))) return [];
  return ctx.thirdPartyTools.some((re) => re.test(tool)) ? [{ kind: "third-party-tool", id: tool, at: ctx.at }] : [];
});

// Shell: network reads and remote output (through the shell normalizer).
const NET_READERS = new Set(["curl", "wget", "http", "https", "xh", "httpie", "aria2c", "lynx", "links", "w3m", "nc", "ncat", "socat", "ftp", "tftp", "lftp",
  "telnet", "dig", "nslookup", "host", "whois", "yt-dlp", "youtube-dl", "rclone", "s3cmd", "gsutil", "aws", "gcloud", "az", "helm", "npx", "bunx", "pnpx", "uvx", "pipx", "glab", "hub"]);
/** Subcommands that fetch from the network, per program (first non-option argument). */
const NET_SUBCOMMANDS: Record<string, RegExp> = {
  gh: /^(api|issue|pr|repo|release|run|search|gist|browse|workflow|discussion|cache|secret|variable|label|project|ruleset|attestation|codespace)$/,
  git: /^(pull|fetch|clone|ls-remote|remote|submodule|lfs|archive)$/,
  npm: /^(view|v|info|show|install|i|add|ci|update|up|upgrade|outdated|search|pack|exec|x|create|init)$/, pnpm: /^(view|info|install|i|add|update|up|outdated|search|dlx|create)$/,
  yarn: /^(info|install|add|upgrade|up|outdated|search|dlx|create)$/, bun: /^(install|i|add|update|outdated|x|create|pm)$/,
  pip: /^(download|install|search|index)$/, pip3: /^(download|install|search|index)$/, uv: /^(pip|add|sync|lock|tool|run)$/, poetry: /^(add|install|update|lock|search)$/,
  cargo: /^(install|fetch|add|update|search|generate-lockfile)$/, go: /^(get|install|mod)$/, gem: /^(install|fetch|search|update)$/,
  composer: /^(install|require|update|search|create-project)$/, brew: /^(install|update|upgrade|fetch|info|search|tap)$/,
  apt: /^(install|update|download|source|upgrade)$/, "apt-get": /^(install|update|download|source|upgrade)$/, dnf: /^(install|update|download|upgrade)$/,
  yum: /^(install|update|download|upgrade)$/, snap: /^(install|refresh|download)$/, flatpak: /^(install|update)$/,
  docker: /^(pull|build|search|login|buildx|compose)$/, podman: /^(pull|build|search|login)$/, kubectl: /^(get|describe|logs|top|events|explain|cp)$/,
};
/** Inline interpreter code that reaches the network (urllib, requests, fetch, http, sockets, a URL, …). */
const NET_CODE = /\b(urllib|urlopen|requests\.|httpx|aiohttp|http\.client|socket\.|fetch\s*\(|https?\.(get|request)|axios|got\s*\(|net\.connect|XMLHttpRequest|WebSocket|LWP|HTTP::Tiny|Net::HTTP|open-uri|curl_exec)|[a-z]+:\/\/[\w.-]+/i;
const gitSub = (args: string[]) => { for (let k = 0; k < args.length; k++) { if (["-C", "-c", "--git-dir", "--work-tree", "--namespace"].includes(args[k]!)) { k++; continue; } if (!args[k]!.startsWith("-")) return args[k]; } return undefined; };
registerTaintDetector((tool, input, ctx) => {
  if (!SHELL_TOOLS.has(lc(tool))) return [];
  const o = obj(input);
  const cmds: string[] = [];
  if (typeof o?.command === "string") cmds.push(o.command);
  else if (Array.isArray(o?.command)) cmds.push(o.command.filter((x): x is string => typeof x === "string").map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" "));
  const out: TaintSource[] = [];
  for (const c of cmds) {
    const a = analyzeShell(c, ctx.dialect ?? "unknown");
    let interpreter = false;
    for (const w of a.commands) {
      const [name, ...args] = w;
      if (!name) continue;
      const sub = name === "git" ? gitSub(args) : args.find((x) => !x.startsWith("-"));
      if (NET_READERS.has(name)) out.push({ kind: "network", id: args.find((x) => /^[a-z]+:\/\/|^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(x)) ?? name, at: ctx.at });
      else if (NET_SUBCOMMANDS[name]?.test(sub ?? "")) {
        out.push({ kind: "network", id: name === "git" && sub === "clone" ? args.filter((x) => !x.startsWith("-")).at(1) ?? "git clone" : `${name} ${sub}`, at: ctx.at });
      } else if (name === "pacman" && args.some((x) => /^-S/.test(x))) out.push({ kind: "network", id: "pacman -S", at: ctx.at });
      else if (name === "scp" || name === "rsync") { const remote = args.find((x) => /^[^/\s]*[^\\/]:/.test(x)); if (remote) out.push({ kind: "remote-output", id: remote.split(":")[0]!, at: ctx.at }); }
      if (INTERPRETER_NAME.test(name)) { interpreter = true; if (args.some((x) => NET_CODE.test(x))) out.push({ kind: "network", id: `${name} inline code`, at: ctx.at }); }
    }
    // Interpreter code fed through a here-document or pipe is not in the words: look at the line.
    if (interpreter && !out.some((t) => t.kind === "network") && NET_CODE.test(c)) out.push({ kind: "network", id: "interpreter code", at: ctx.at });
    for (const r of a.remote) out.push({ kind: "remote-output", id: `${r.via} ${r.host}`, at: ctx.at });
  }
  return out;
});

// Reads of files: written by this session from tainted content, outside the scope, or inside it but neither created
// by this session nor tracked by git.
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
export const absOf = (p: string, cwd: string) => resolve(cwd, p.startsWith("~/") ? `${process.env.HOME}/${p.slice(2)}` : p);
registerTaintDetector(async (tool, input, ctx) => {
  const reads = extractRaw(tool, input, ctx.cwd, ctx.dialect).targets.filter((t) => t.kind === "path" && t.effect === "read" && !t.remote && !t.unresolved && !/[*?[\]{}$`]/.test(t.id));
  const out: TaintSource[] = [];
  for (const t of reads.slice(0, 10)) {
    const abs = absOf(t.id, ctx.cwd);
    // Written by this session while tainted (curl -o, a redirect, Write): the content came from the taint.
    if (ctx.taintedPath?.(abs)) { out.push({ kind: "tainted-file-read", id: t.id, at: ctx.at }); continue; }
    if (!inside(abs, ctx.scope)) { out.push({ kind: "outside-scope-read", id: t.id, at: ctx.at }); continue; }
    if (ctx.ledger.createdPath(abs)) continue; // the session's own writes (from untainted context)
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

/** Files an observed action writes (absolute paths): Write/Edit paths, shell redirects, `curl -o`, `wget -O`, `tee`, …
 *  (path targets with a create/modify effect). A file written while the context is tainted inherits the taint. */
export function writtenPaths(tool: string, input: unknown, cwd: string, dialect?: ShellDialect): string[] {
  try {
    return extractRaw(tool, input, cwd, dialect).targets
      .filter((t) => t.kind === "path" && (t.effect === "create" || t.effect === "modify") && !t.remote && !t.unresolved && !/[*?[\]{}$`]/.test(t.id))
      .map((t) => absOf(t.id, cwd));
  } catch { return []; }
}

export const compileToolPatterns = (patterns: string[] | undefined, defaults: string[] = DEFAULT_THIRD_PARTY_TOOLS) =>
  (patterns ?? defaults).map((p) => { try { return new RegExp(p, "i"); } catch { return undefined; } }).filter((r): r is RegExp => !!r);
