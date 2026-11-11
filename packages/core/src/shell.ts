// Shell command normalization for the approval judge (docs §10.4). Not a shell: a conservative, best-effort reader
// that turns a command line into the simple commands it would run, so deny rules can't be dodged by quoting (`r''m`,
// `"rm"`, `\rm`), grouping and compound commands (`(rm …)`, `{ rm …; }`, `! rm`, `if …; then rm …; fi`, loops),
// wrappers (`sudo`, `env`, `timeout`, `xargs`, `sh -c '…'`, sandboxes, …), here-documents, brace expansion of the
// command word, substitution (`echo $(rm …)`) or remote execution (`ssh host rm …`, `docker exec c rm …`). What it
// cannot resolve is flagged `unresolvable` with a reason: callers then fail toward the judge or the human, never
// toward allow. It understands POSIX sh / bash / dash; zsh where it is the same (zsh-only syntax is unresolvable);
// fish and PowerShell not at all. The real boundary is the OS sandbox, permissions and dirScope.

/** The shell that interprets a command: from the provider and tool (outer), switched only by an explicit inner
 *  interpreter (`bash -c`, `zsh -c`, `fish -c`, `pwsh -Command`). `argv`: no shell (an argument vector, codex);
 *  `unknown`: not reported by the provider, read as POSIX. */
export type ShellDialect = "sh" | "bash" | "dash" | "zsh" | "fish" | "powershell" | "argv" | "unknown";
const POSIX_DIALECTS = new Set<ShellDialect>(["sh", "bash", "dash", "argv", "unknown"]);
/** posix | zsh | unsupported: switching between POSIX shells (sh, bash, dash) is not a dialect switch. */
const family = (d: ShellDialect) => (POSIX_DIALECTS.has(d) ? "posix" : d === "zsh" ? "zsh" : "unsupported");
/** Dialects the normalizer reads (zsh: what it shares with POSIX). */
export const isParsedDialect = (d: ShellDialect) => POSIX_DIALECTS.has(d) || d === "zsh";

/** Dialect of a shell binary path or name (`/bin/zsh` → zsh, `pwsh` → powershell). */
export function dialectOfShell(shell: string | undefined): ShellDialect {
  const b = (shell ?? "").replace(/^.*[\\/]/, "").replace(/\.exe$/i, "").toLowerCase();
  if (b === "bash" || b === "sh" || b === "dash" || b === "zsh" || b === "fish") return b;
  if (b === "ash" || b === "ksh" || b === "mksh" || b === "busybox") return "sh";
  if (b === "pwsh" || b === "powershell") return "powershell";
  return "unknown";
}

/** Shell-quote one argv element so a joined argv parses back to the same words (codex sends argv arrays). */
export const shellQuote = (a: string) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);

/** Dialect of a request: `PowerShell` tool → powershell, an argv array → argv, else what the provider declares for
 *  the tool (ProviderCapabilities.shellDialects), else unknown (read as POSIX). */
export function requestDialect(tool: string, input: unknown, dialects?: Readonly<Record<string, ShellDialect>>): ShellDialect {
  if (tool.toLowerCase() === "powershell") return "powershell";
  const o = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : undefined;
  if (Array.isArray(o?.command)) return "argv";
  return dialects?.[tool.toLowerCase()] ?? "unknown";
}

/** Structure of a shell command line, passed to the judge as typed, code-computed data. */
export interface ShellShape {
  /** Simple commands found, including those inside substitutions, `sh -c` / `eval` strings and remote commands. */
  segments: number;
  hasSubstitution: boolean;
  /** Output piped into a shell (`curl … | sh`). */
  hasPipeToShell: boolean;
  /** Wrappers that were unwrapped (sudo, env, timeout, sh -c, ssh, …), in order of appearance. */
  wrappers: string[];
  /** Something decides what runs that code can't see (see unresolvableReasons). */
  unresolvable: boolean;
  unresolvableReasons: string[];
  /** The outer dialect (from the provider / tool). */
  dialect: ShellDialect;
  /** false: the dialect is not one the normalizer reads (fish, PowerShell); nothing was parsed. */
  parsed: boolean;
  /** Explicit inner interpreters that switched the dialect (`zsh -c`, `fish -c`, `pwsh -Command`, …). */
  dialectSwitches: string[];
}

export interface ShellAnalysis extends ShellShape {
  /** Each simple command run here, as its unquoted words, command word reduced to its base name (`/bin/rm` → `rm`). */
  commands: string[][];
  /** Commands run elsewhere (ssh host, docker/kubectl/podman exec or run): `via` and `host` name the place. */
  remote: { via: string; host: string; commands: string[][] }[];
  /** Text of `#` comments (outside quotes). */
  comments: string[];
  /** File redirections and their targets (`> out.txt` overwrites, `>> log` appends, `< in` reads). */
  redirects: { op: ">" | ">>" | "<"; target: string }[];
}

interface Word { value: string; dyn: boolean; quoted: boolean }
type Tok =
  | { t: "w"; w: Word }
  | { t: "op"; v: string }
  | { t: "redir"; op: ">" | ">>" | "<"; target: string }
  | { t: "heredoc"; body: string }
  | { t: "herestring"; w: Word };

const SEP_OPS = new Set([";", "&&", "||", "|", "|&", "&", "\n", ";;", ";&", ";;&", "(", ")"]);

/** Read `$( … )` (or `<( … )`) starting at src[i] === "(" ; returns [body, index after ")"] or undefined. */
function readParen(src: string, i: number): [string, number] | undefined {
  let depth = 0;
  let q: string | undefined;
  for (let j = i; j < src.length; j++) {
    const c = src[j]!;
    if (q) { if (c === "\\" && q === '"') j++; else if (c === q) q = undefined; continue; }
    if (c === "'" || c === '"') q = c;
    else if (c === "\\") j++;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return [src.slice(i + 1, j), j + 1];
  }
  return undefined;
}

function tokenize(src: string): { toks: Tok[]; comments: string[]; subs: string[]; ok: boolean } {
  const toks: Tok[] = [];
  const comments: string[] = [];
  const subs: string[] = [];
  let ok = true;
  let cur: Word | undefined;
  /** What the next word is: a redirect target, a here-string, or a here-document delimiter. */
  let pending: { kind: "redir"; op: ">" | ">>" | "<" } | { kind: "herestring" } | { kind: "heredoc"; strip: boolean } | undefined;
  const heredocs: { tok: { t: "heredoc"; body: string }; delim: string; strip: boolean }[] = [];
  const word = () => (cur ??= { value: "", dyn: false, quoted: false });
  const flush = () => {
    if (!cur) return;
    const w = cur;
    cur = undefined;
    if (!pending) { toks.push({ t: "w", w }); return; }
    const p = pending;
    pending = undefined;
    if (p.kind === "redir") toks.push({ t: "redir", op: p.op, target: w.value });
    else if (p.kind === "herestring") toks.push({ t: "herestring", w });
    else { const tok = { t: "heredoc" as const, body: "" }; toks.push(tok); heredocs.push({ tok, delim: w.value, strip: p.strip }); }
  };
  const sub = (body: string) => { subs.push(body); const w = word(); w.dyn = true; w.value += "$(…)"; };
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    const n = src[i + 1];
    if (c === " " || c === "\t") { flush(); continue; }
    if (c === "\\") {
      if (n === "\n") { i++; continue; } // line continuation
      if (n !== undefined) { word().value += n; word().quoted = true; }
      i++;
      continue;
    }
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      word().quoted = true;
      if (end < 0) { ok = false; word().value += src.slice(i + 1); break; }
      word().value += src.slice(i + 1, end);
      i = end;
      continue;
    }
    if (c === '"') {
      const w = word();
      w.quoted = true;
      let j = i + 1;
      for (; j < src.length && src[j] !== '"'; j++) {
        const d = src[j]!;
        if (d === "\\" && j + 1 < src.length && '"\\$`\n'.includes(src[j + 1]!)) { w.value += src[++j]; continue; }
        if (d === "$" && src[j + 1] === "(") { const r = readParen(src, j + 1); if (!r) { ok = false; j = src.length; break; } sub(r[0]); j = r[1] - 1; continue; }
        if (d === "`") { const e = src.indexOf("`", j + 1); if (e < 0) { ok = false; j = src.length; break; } sub(src.slice(j + 1, e)); j = e; continue; }
        if (d === "$") w.dyn = true;
        w.value += d;
      }
      if (j >= src.length) { ok = false; break; }
      i = j;
      continue;
    }
    if (c === "#" && !cur) {
      const end = src.indexOf("\n", i);
      comments.push(src.slice(i + 1, end < 0 ? src.length : end));
      i = (end < 0 ? src.length : end) - 1;
      continue;
    }
    if (c === "$" && n === "(") { const r = readParen(src, i + 1); if (!r) { ok = false; break; } sub(r[0]); i = r[1] - 1; continue; }
    if ((c === "<" || c === ">") && n === "(") { // process substitution
      const r = readParen(src, i + 1); if (!r) { ok = false; break; }
      flush(); subs.push(r[0]); toks.push({ t: "w", w: { value: "<(…)", dyn: true, quoted: false } }); i = r[1] - 1; continue;
    }
    if (c === "`") { const e = src.indexOf("`", i + 1); if (e < 0) { ok = false; break; } sub(src.slice(i + 1, e)); i = e; continue; }
    if (c === "$") { word().dyn = true; word().value += c; continue; }
    if (c === "<" && n === "<") {
      // <<< here-string, <<[-] here-document
      if (cur && /^\d+$/.test(cur.value) && !cur.dyn) cur = undefined; else flush();
      if (src[i + 2] === "<") { pending = { kind: "herestring" }; i += 2; continue; }
      const strip = src[i + 2] === "-";
      pending = { kind: "heredoc", strip };
      i += strip ? 2 : 1;
      continue;
    }
    if (c === "<" || c === ">") {
      // Redirection: drop a pending fd number ("2>"), skip operator chars, the next word is its target.
      if (cur && /^\d+$/.test(cur.value) && !cur.dyn) cur = undefined; else flush();
      const op: ">" | ">>" | "<" = c === "<" ? "<" : n === ">" ? ">>" : ">";
      while (src[i + 1] === ">" || src[i + 1] === "<" || src[i + 1] === "&" || src[i + 1] === "|") i++;
      if (/^\d$/.test(src[i + 1] ?? "") && src[i] === "&") { i++; continue; } // >&2
      pending = { kind: "redir", op };
      continue;
    }
    if (c === "\n" || c === ";" || c === "&" || c === "|" || c === "(" || c === ")") {
      flush();
      let op = c;
      if ((c === "&" && n === "&") || (c === "|" && n === "|") || (c === ";" && n === ";") || (c === "|" && n === "&") || (c === ";" && n === "&")) { op += n; i++; }
      toks.push({ t: "op", v: op });
      // Here-document bodies start on the line after their operator.
      if (c === "\n" && heredocs.length) {
        for (const h of heredocs.splice(0)) {
          const lines: string[] = [];
          let k = i + 1;
          for (;;) {
            if (k > src.length) { ok = false; break; }
            const e = src.indexOf("\n", k);
            const line = src.slice(k, e < 0 ? src.length : e);
            k = e < 0 ? src.length + 1 : e + 1;
            if ((h.strip ? line.replace(/^\t+/, "") : line) === h.delim) break;
            lines.push(line);
            if (e < 0) { ok = false; break; }
          }
          h.tok.body = lines.join("\n");
          i = Math.min(k, src.length) - 1;
        }
      }
      continue;
    }
    word().value += c;
  }
  flush();
  if (heredocs.length) ok = false; // a here-document with no body
  return { toks, comments, subs, ok };
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "ash", "mksh", "pwsh", "powershell", "busybox-sh"]);
const INTERPRETERS = new Set(["python", "python2", "python3", "perl", "ruby", "node", "nodejs", "deno", "bun", "php", "lua", "luajit", "osascript", "Rscript", "tclsh", "pypy", "pypy3"]);
const AWKS = new Set(["awk", "gawk", "mawk", "nawk", "busybox-awk"]);
/** Shell reserved words that may precede a command in a simple-command position. */
const LEADING_RESERVED = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "{", "(", "time", "in", "coproc"]);
const CLOSERS = new Set(["fi", "done", "esac", "}", ")"]);
/** git -c keys that make git run another program. */
const GIT_RUNS_COMMAND = /(^|\.)(pager|editor|sshcommand|askpass|hookspath|fsmonitor|textconv|externaldiff|external)$|^alias\.|^core\.(pager|editor|sshcommand|askpass|hookspath|fsmonitor|gitproxy)$|^(diff|merge|filter)\.|^credential\.helper$|^gpg\.program$|^sequence\.editor$/i;
const base = (cmd: string) => cmd.replace(/^.*\//, "");
const isAssign = (w: Word) => /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/.test(w.value);
const lit = (value: string): Word => ({ value, dyn: false, quoted: false });

/** Options taking a separate argument, per wrapper (anything else starting with "-" is a flag). */
const OPT_ARGS: Record<string, string[]> = {
  sudo: ["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-U", "-T", "--user", "--group", "--chdir"],
  doas: ["-u", "-C"],
  env: ["-u", "-C", "--unset", "--chdir"],
  timeout: ["-s", "-k", "--signal", "--kill-after"],
  nice: ["-n", "--adjustment"],
  ionice: ["-c", "-n", "--class", "--classdata"],
  stdbuf: ["-i", "-o", "-e", "--input", "--output", "--error"],
  time: ["-f", "-o", "--format", "--output"],
  exec: ["-a"],
  xargs: ["-I", "-n", "-P", "-d", "-E", "-L", "-s", "-a", "-e", "--delimiter", "--max-args", "--max-procs", "--arg-file"],
  flock: ["-w", "-E", "--timeout", "--conflict-exit-code"],
  chroot: ["--userspec", "--groups"],
  strace: ["-o", "-e", "-p", "-s", "-u", "-a", "-b", "-E", "-O", "-S", "-P", "-I"],
  ltrace: ["-o", "-e", "-p", "-s", "-u", "-a", "-n"],
  taskset: [], setsid: [], nohup: [], builtin: [], command: [], unbuffer: [], busybox: [], watch: ["-n", "-d", "--interval"],
  runuser: ["-u", "-g", "-G", "--user", "--group"], su: ["-c", "-s", "-g", "-G"], chrt: [], cgexec: ["-g"], unshare: [], nsenter: ["-t"],
  faketime: [], torsocks: [], proxychains: ["-f"], proxychains4: ["-f"], firejail: [], parallel: [],
  "sandbox-exec": ["-f", "-p", "-n", "-D"],
};
/** Wrappers whose first non-option argument is not the command (a duration, a root dir, a lock file, a cpu mask, …). */
const SKIP_POSITIONAL: Record<string, number> = { timeout: 1, chroot: 1, flock: 1, taskset: 1, chrt: 1, faketime: 1 };

/** Split a wrapper's arguments: its options, then the wrapped command. undefined = it doesn't run a command
 *  (`command -v`, `ionice -p`). */
function unwrap(name: string, args: Word[]): { rest: Word[]; inner?: Word[] } | undefined {
  const withArg = OPT_ARGS[name] ?? [];
  let i = 0;
  let positional = SKIP_POSITIONAL[name] ?? 0;
  while (i < args.length) {
    const a = args[i]!.value;
    if (a === "--") { i++; break; }
    if (name === "env" && isAssign(args[i]!)) { i++; continue; }
    if (name === "env" && (a === "-S" || a === "--split-string")) return { rest: [], inner: args.slice(i + 1) };
    if (name === "command" && (a === "-v" || a === "-V")) return undefined;
    if (name === "ionice" && a === "-p") return undefined;
    if (name === "flock" && (a === "-c" || a === "--command")) return { rest: [], inner: args.slice(i + 1, i + 2) };
    if (name === "su" && a === "-c") return { rest: [], inner: args.slice(i + 1, i + 2) };
    if (a.startsWith("-") && a.length > 1) {
      const key = a.includes("=") ? a.slice(0, a.indexOf("=")) : a;
      i += withArg.includes(key) && !a.includes("=") && !(key.length === 2 && a.length > 2) ? 2 : 1;
      continue;
    }
    if (positional > 0) { positional--; i++; continue; }
    break;
  }
  let rest = args.slice(i);
  if (name === "parallel") { const k = rest.findIndex((w) => w.value === ":::"); if (k >= 0) rest = rest.slice(0, k); }
  if (name === "watch") return { rest: [], inner: rest };
  return { rest };
}

/** bwrap options and how many arguments each takes. */
const BWRAP_ARGS: Record<string, number> = {
  "--bind": 2, "--ro-bind": 2, "--dev-bind": 2, "--bind-try": 2, "--ro-bind-try": 2, "--dev-bind-try": 2, "--symlink": 2, "--setenv": 2, "--file": 2, "--bind-data": 2, "--ro-bind-data": 2,
  "--chdir": 1, "--tmpfs": 1, "--proc": 1, "--dev": 1, "--dir": 1, "--unsetenv": 1, "--uid": 1, "--gid": 1, "--hostname": 1, "--remount-ro": 1, "--seccomp": 1, "--info-fd": 1,
  "--json-status-fd": 1, "--sync-fd": 1, "--block-fd": 1, "--userns-block-fd": 1, "--lock-file": 1, "--argv0": 1, "--cap-add": 1, "--cap-drop": 1, "--perms": 1, "--size": 1, "--exec-label": 1, "--file-label": 1,
};
/** docker/podman run|exec options that take an argument. */
const DOCKER_ARGS = new Set(["-e", "--env", "-v", "--volume", "-w", "--workdir", "-u", "--user", "--name", "-p", "--publish", "--network", "--net", "--entrypoint",
  "--mount", "-l", "--label", "--env-file", "--hostname", "-h", "--platform", "--pull", "--restart", "--memory", "-m", "--cpus", "--gpus", "--device", "--add-host",
  "--cap-add", "--cap-drop", "--security-opt", "--ipc", "--pid", "--ulimit", "--tmpfs", "--log-driver", "--log-opt", "--shm-size", "--group-add", "--detach-keys", "--stop-signal"]);
const SSH_OPT_ARGS = new Set(["-p", "-i", "-l", "-o", "-F", "-J", "-L", "-R", "-D", "-W", "-b", "-c", "-E", "-e", "-I", "-m", "-O", "-Q", "-S", "-w", "-B"]);

const emptyAnalysis = (dialect: ShellDialect): ShellAnalysis => ({
  commands: [], remote: [], comments: [], redirects: [], segments: 0, hasSubstitution: false, hasPipeToShell: false, wrappers: [],
  unresolvable: false, unresolvableReasons: [], dialect, parsed: isParsedDialect(dialect), dialectSwitches: [],
});

/**
 * Analyse a shell command line in its dialect (recursing into substitutions, here-documents, `sh -c` / `eval` /
 * `env -S` / `flock -c` strings, wrappers, `find -exec` and remote commands) and return every simple command it
 * would run, with its structure.
 */
export function analyzeShell(src: string, dialect: ShellDialect = "bash", depth = 0): ShellAnalysis {
  const out = emptyAnalysis(dialect);
  const unres = (why: string) => { out.unresolvable = true; if (!out.unresolvableReasons.includes(why)) out.unresolvableReasons.push(why); };
  if (depth > 8) { unres("nested too deep"); return out; }
  if (!isParsedDialect(dialect)) { unres(`${dialect} is not parsed`); return out; }
  if (dialect === "zsh" && /(^|[\s;&|(])=[A-Za-z_]|\$\{[~=^(#]|[*?\]]\([^)\s]*\)|=\(|<\(\(|\$\{\(/.test(src)) unres("zsh-specific syntax");
  const { toks, comments, subs, ok } = tokenize(src);
  out.comments.push(...comments);
  if (!ok) unres("unbalanced quotes or here-document");
  for (const t of toks) if (t.t === "redir") out.redirects.push({ op: t.op, target: t.target });
  const merge = (a: ShellAnalysis) => {
    out.commands.push(...a.commands); out.comments.push(...a.comments); out.redirects.push(...a.redirects); out.remote.push(...a.remote);
    out.hasSubstitution ||= a.hasSubstitution; out.hasPipeToShell ||= a.hasPipeToShell;
    for (const r of a.unresolvableReasons) unres(r);
    out.wrappers.push(...a.wrappers); out.dialectSwitches.push(...a.dialectSwitches);
  };
  if (subs.length) out.hasSubstitution = true;
  for (const s of subs) merge(analyzeShell(s, dialect, depth + 1));
  // Simple commands: words between separators, with what feeds their stdin.
  type Seg = { words: Word[]; piped: boolean; heredocs: string[]; herestrings: Word[]; stdinFile: boolean };
  let seg: Seg = { words: [], piped: false, heredocs: [], herestrings: [], stdinFile: false };
  const segments: Seg[] = [];
  const close = (next: Seg) => { if (seg.words.length) segments.push(seg); seg = next; };
  for (const t of toks) {
    if (t.t === "op" && SEP_OPS.has(t.v)) { close({ words: [], piped: t.v === "|" || t.v === "|&", heredocs: [], herestrings: [], stdinFile: false }); continue; }
    if (t.t === "w") seg.words.push(t.w);
    else if (t.t === "heredoc") seg.heredocs.push(t.body);
    else if (t.t === "herestring") seg.herestrings.push(t.w);
    else if (t.t === "redir" && t.op === "<") seg.stdinFile = true;
  }
  close(seg);
  for (const s of segments) runSimple(s, dialect, depth, out, merge, unres);
  out.segments = out.commands.length + out.remote.reduce((n, r) => n + r.commands.length, 0);
  out.wrappers = [...new Set(out.wrappers)];
  out.dialectSwitches = [...new Set(out.dialectSwitches)];
  return out;
}

/** `{a,b}c` → ["ac", "bc"] (one level, comma lists); undefined = no expansion; null = can't (ranges, nesting). */
function braceExpand(w: Word): string[] | undefined | null {
  if (w.quoted || w.dyn) return undefined;
  const m = /^(.*?)\{([^{}]*)\}(.*)$/.exec(w.value);
  if (!m) return undefined;
  if (/\.\./.test(m[2]!) || /[{}]/.test(m[1]! + m[3]!)) return null;
  if (!m[2]!.includes(",")) return undefined;
  return m[2]!.split(",").map((alt) => m[1]! + alt + m[3]!);
}

function runSimple(seg: { words: Word[]; piped: boolean; heredocs: string[]; herestrings: Word[]; stdinFile: boolean }, dialect: ShellDialect, depth: number,
  out: ShellAnalysis, merge: (a: ShellAnalysis) => void, unres: (why: string) => void) {
  let words = seg.words;
  const stdinCode = () => [...seg.heredocs, ...seg.herestrings.map((w) => { if (w.dyn) unres("here-string with substitution"); return w.value; })];
  for (let guard = 0; guard < 16; guard++) {
    // Reserved words and grouping are syntax, not commands; loop / case headers run nothing themselves.
    while (words.length && LEADING_RESERVED.has(words[0]!.value) && !words[0]!.dyn && !words[0]!.quoted) {
      const kw = words[0]!.value;
      words = words.slice(1);
      if (kw === "time" && words[0]?.value === "-p") words = words.slice(1); // `time -p cmd`
    }
    while (words.length && CLOSERS.has(words.at(-1)!.value) && !words.at(-1)!.dyn && !words.at(-1)!.quoted) words = words.slice(0, -1);
    if (words.length && ["for", "select", "case"].includes(words[0]!.value) && !words[0]!.quoted) return;
    if (words.length && words[0]!.value === "function" && !words[0]!.quoted) { words = words.slice(2); continue; }
    if (words.length && CLOSERS.has(words[0]!.value) && words.length === 1) return;
    while (words.length && isAssign(words[0]!)) words = words.slice(1);
    if (!words.length) return;
    // Brace expansion of the command word: {r,}m → rm m.
    const exp = braceExpand(words[0]!);
    if (exp === null) { unres("brace expansion in the command word"); out.commands.push(words.map((w) => w.value)); return; }
    if (exp) { words = [...exp.map(lit), ...words.slice(1)]; continue; }
    const first = words[0]!;
    if (first.dyn || !first.value) { unres("command word from a variable or substitution"); out.commands.push(words.map((w) => w.value)); return; }
    if (dialect === "zsh" && first.value.startsWith("=")) { unres("zsh =command expansion"); out.commands.push(words.map((w) => w.value)); return; }
    const name = base(first.value);
    const args = words.slice(1);
    const cmd = [name, ...args.map((w) => w.value)];
    if (SHELLS.has(name)) {
      const inner = dialectOfShell(name === "busybox-sh" ? "sh" : name);
      if (inner === "powershell") {
        out.dialectSwitches.push(`${name} -Command`); unres(`${name} code is not parsed`); out.commands.push(cmd); return;
      }
      const ci = args.findIndex((w) => /^-[A-Za-z]*c[A-Za-z]*$/.test(w.value) || w.value === "--command");
      if (ci >= 0) {
        out.wrappers.push(`${name} -c`);
        if (family(inner) !== family(dialect)) out.dialectSwitches.push(`${name} -c`);
        const str = args.slice(ci + 1).find((w) => !w.value.startsWith("-"));
        if (!str) { unres(`${name} -c without a command`); return; }
        if (str.dyn) unres(`${name} -c string with substitution`);
        merge(analyzeShell(str.value, inner, depth + 1));
        return;
      }
      out.commands.push(cmd);
      const code = stdinCode();
      if (code.length) { out.wrappers.push(`${name} <<`); if (family(inner) !== family(dialect)) out.dialectSwitches.push(`${name} <<`); for (const c of code) merge(analyzeShell(c, inner, depth + 1)); return; }
      const script = args.find((w) => !w.value.startsWith("-"));
      if (seg.piped && !script) { out.hasPipeToShell = true; unres(`${name} reads commands from a pipe`); return; }
      if (seg.stdinFile && !script) { unres(`${name} reads commands from a file`); return; }
      if (script) { unres(`${name} runs a script file`); return; }
      return; // an interactive shell
    }
    if (INTERPRETERS.has(name)) {
      out.commands.push(cmd);
      const inline = args.some((w) => /^(-[A-Za-z]*[ceE]|-r|--eval|-p|--print|eval)$/.test(w.value) && !(name.startsWith("python") && /^-[A-Za-z]*[eE]$/.test(w.value)));
      if (inline) unres(`inline ${name} code`);
      else if (stdinCode().length || args.some((w) => w.value === "-") || ((seg.piped || seg.stdinFile) && !args.some((w) => !w.value.startsWith("-")))) unres(`${name} reads code from stdin`);
      return;
    }
    if (AWKS.has(name)) {
      out.commands.push(cmd);
      if (args.some((w) => /\bsystem\s*\(|\|\s*getline|\|\s*"|print[^;}]*\|/.test(w.value))) unres("awk runs commands");
      return;
    }
    if (name === "git") {
      for (let k = 0; k + 1 < args.length && args[k]!.value.startsWith("-"); k++) {
        if (args[k]!.value === "-c" && GIT_RUNS_COMMAND.test((args[k + 1]!.value.split("=")[0] ?? "").trim())) unres(`git -c ${args[k + 1]!.value.split("=")[0]} runs a command`);
        if (args[k]!.value.startsWith("--config-env")) unres("git --config-env");
      }
      out.commands.push(cmd);
      return;
    }
    if (name === "eval") {
      out.wrappers.push("eval");
      if (args.some((w) => w.dyn)) unres("eval of non-literal text");
      merge(analyzeShell(args.map((w) => w.value).join(" "), dialect, depth + 1));
      return;
    }
    // Remote / container execution: what runs there is analysed as POSIX (the remote shell is unknown).
    if (name === "ssh" || name === "mosh") {
      out.commands.push(cmd);
      let i = 0;
      while (i < args.length && args[i]!.value.startsWith("-")) i += SSH_OPT_ARGS.has(args[i]!.value) ? 2 : 1;
      const host = args[i]?.value;
      const rest = args.slice(i + 1);
      if (!host || !rest.length) return;
      out.wrappers.push("ssh");
      if (rest.some((w) => w.dyn)) unres("ssh remote command with substitution");
      const a = analyzeShell(rest.map((w) => w.value).join(" "), "unknown", depth + 1);
      out.remote.push({ via: name, host, commands: [...a.commands, ...a.remote.flatMap((r) => r.commands)] });
      for (const r of a.unresolvableReasons) unres(r);
      return;
    }
    if ((name === "docker" || name === "podman" || name === "kubectl" || name === "nerdctl") && ["exec", "run"].includes(args.find((w) => !w.value.startsWith("-"))?.value ?? "")) {
      out.commands.push(cmd);
      const sub = args.findIndex((w) => w.value === "exec" || w.value === "run");
      const verb = args[sub]!.value;
      const r = args.slice(sub + 1);
      let i = 0;
      let inner: Word[] = [];
      let host = "?";
      if (name === "kubectl") {
        const dd = r.findIndex((w) => w.value === "--");
        const KARGS = new Set(["-n", "--namespace", "-c", "--container", "--context", "--kubeconfig", "--cluster", "--user", "-f", "--filename"]);
        for (let k = 0; k < (dd >= 0 ? dd : r.length); k++) { if (KARGS.has(r[k]!.value)) { k++; continue; } if (!r[k]!.value.startsWith("-")) { host = r[k]!.value; break; } }
        inner = dd >= 0 ? r.slice(dd + 1) : [];
      } else {
        while (i < r.length && r[i]!.value.startsWith("-")) i += DOCKER_ARGS.has(r[i]!.value) ? 2 : 1;
        host = r[i]?.value ?? "?"; // container (exec) or image (run)
        inner = r.slice(i + 1);
      }
      if (!inner.length) return;
      out.wrappers.push(`${name} ${verb}`);
      if (inner.some((w) => w.dyn)) unres(`${name} ${verb} command with substitution`);
      const sub2 = emptyAnalysis("unknown");
      runSimple({ words: inner, piped: false, heredocs: [], herestrings: [], stdinFile: false }, "unknown", depth + 1, sub2,
        (a) => { sub2.commands.push(...a.commands, ...a.remote.flatMap((x) => x.commands)); a.unresolvableReasons.forEach(unres); a.dialectSwitches.forEach((d) => out.dialectSwitches.push(d)); }, unres);
      out.remote.push({ via: `${name} ${verb}`, host, commands: sub2.commands });
      out.dialectSwitches.push(...sub2.dialectSwitches);
      return;
    }
    if (name === "bwrap") {
      out.wrappers.push("bwrap");
      let i = 0;
      while (i < args.length && args[i]!.value.startsWith("--")) { if (args[i]!.value === "--") { i++; break; } i += 1 + (BWRAP_ARGS[args[i]!.value] ?? 0); }
      words = args.slice(i);
      continue;
    }
    if (name === "firejail") {
      out.wrappers.push("firejail");
      const k = args.findIndex((w) => !w.value.startsWith("-"));
      words = k >= 0 ? args.slice(k) : [];
      continue;
    }
    if (name in OPT_ARGS) {
      const u = unwrap(name, args);
      out.wrappers.push(name);
      if (!u) { out.commands.push(cmd); return; }
      if (u.inner) {
        if (u.inner.some((w) => w.dyn)) unres(`${name} command with substitution`);
        merge(analyzeShell(u.inner.map((w) => w.value).join(" "), dialect, depth + 1));
        return;
      }
      if (!u.rest.length) { out.commands.push(cmd); return; }
      words = u.rest;
      continue;
    }
    out.commands.push(cmd);
    // find -exec / -execdir / -ok … ; runs a command per file.
    if (name === "find") {
      for (let k = 0; k < args.length; k++) {
        if (!["-exec", "-execdir", "-ok", "-okdir"].includes(args[k]!.value)) continue;
        const end = args.findIndex((w, j) => j > k && (w.value === ";" || w.value === "+"));
        const inner = args.slice(k + 1, end < 0 ? undefined : end);
        if (inner.length) { out.wrappers.push("find -exec"); runSimple({ words: inner, piped: false, heredocs: [], herestrings: [], stdinFile: false }, dialect, depth, out, merge, unres); }
      }
    }
    return;
  }
}
