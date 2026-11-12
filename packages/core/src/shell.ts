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
export type ShellDialect = "sh" | "bash" | "dash" | "zsh" | "fish" | "csh" | "powershell" | "argv" | "unknown";
const POSIX_DIALECTS = new Set<ShellDialect>(["sh", "bash", "dash", "argv", "unknown"]);
/** posix | zsh | unsupported: switching between POSIX shells (sh, bash, dash) is not a dialect switch. */
const family = (d: ShellDialect) => (POSIX_DIALECTS.has(d) ? "posix" : d === "zsh" ? "zsh" : "unsupported");
/** Dialects the normalizer reads (zsh: what it shares with POSIX). */
export const isParsedDialect = (d: ShellDialect) => POSIX_DIALECTS.has(d) || d === "zsh";

/** Dialect of a shell binary path or name (`/bin/zsh` → zsh, `pwsh` → powershell). */
export function dialectOfShell(shell: string | undefined): ShellDialect {
  // Versioned names (bash5.2, ksh93, zsh-5.9) are the same shell.
  const b = (shell ?? "").replace(/^.*[\\/]/, "").replace(/\.exe$/i, "").toLowerCase().replace(/-?\d+(\.\d+)*$/, "");
  if (b === "bash" || b === "sh" || b === "dash" || b === "zsh" || b === "fish") return b;
  if (b === "ash" || b === "ksh" || b === "mksh" || b === "yash" || b === "busybox" || b === "busybox-sh") return "sh";
  if (b === "csh" || b === "tcsh") return "csh";
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

function tokenize(src: string): { toks: Tok[]; comments: string[]; subs: string[]; ok: boolean; wordParen: boolean } {
  const toks: Tok[] = [];
  /** An unquoted "(" right after a word (`*(e:'…':)`, `x(+f)`): a zsh glob qualifier or pattern group. Not `f()`,
   *  `a=(…)`, `$(`, `<(`. */
  let wordParen = false;
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
      if (c === "(" && cur && (cur.value || cur.quoted) && n !== ")" && !cur.value.endsWith("=")) wordParen = true;
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
  return { toks, comments, subs, ok, wordParen };
}

// A deny list can never be complete, so the reader fails closed: anything that runs a string or a file as code, or
// changes what a command word resolves to, is flagged unresolvable (allowBlockers then keeps the request from being
// auto-allowed while a Bash deny rule exists). Names are matched by pattern, so versioned binaries count too.
/** Shells, versioned names included (bash5.2, ksh93). */
const SHELL_NAME = /^(sh|bash|zsh|dash|ksh|ksh93|fish|ash|mksh|yash|csh|tcsh|pwsh|powershell|busybox-sh)(-?\d+(\.\d+)*)?$/;
/** Interpreters, versioned names included (python3.12, node22, lua5.4, perl5.36). */
export const INTERPRETER_NAME = /^(python|pythonw|pypy|perl|ruby|irb|jruby|node|nodejs|deno|bun|php|lua|luajit|osascript|Rscript|tclsh|wish|expect|julia|guile|racket|sbcl|elixir|escript|groovy|jython|ts-node|tsx)(-?\d+(\.\d+)*)?$/;
const AWKS = new Set(["awk", "gawk", "mawk", "nawk", "busybox-awk"]);
/** Shell reserved words that may precede a command in a simple-command position. */
const LEADING_RESERVED = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "{", "(", "time", "in", "coproc", "always"]);
const CLOSERS = new Set(["fi", "done", "esac", "}", ")", "end"]);
/** git -c / git config keys that make git run another program or read more config. */
const GIT_RUNS_COMMAND = /(^|\.)(pager|editor|sshcommand|askpass|hookspath|fsmonitor|textconv|externaldiff|external|program|cmd|command|helper|tool)$|^alias\.|^core\.(pager|editor|sshcommand|askpass|hookspath|fsmonitor|gitproxy)$|^(diff|merge|filter|difftool|mergetool)\.|^credential\.|^gpg\.|^sequence\.editor$|^include\.|^includeif\./i;
/** git's own commands: anything else is an alias (`!sh …`) or an external git-<name> program. Aliases can't shadow these. */
const GIT_BUILTINS = new Set(("add am annotate apply archive backfill bisect blame branch bugreport bundle cat-file check-attr check-ignore check-mailmap " +
  "check-ref-format checkout checkout-index cherry cherry-pick citool clean clone column commit commit-graph commit-tree config count-objects " +
  "credential describe diagnose diff diff-files diff-index diff-tree difftool fast-export fast-import fetch fetch-pack filter-branch " +
  "for-each-ref for-each-repo format-patch fsck gc get-tar-commit-id grep gui hash-object help hook index-pack init instaweb " +
  "interpret-trailers lfs log ls-files ls-remote ls-tree mailinfo mailsplit maintenance merge merge-base merge-file merge-index merge-tree " +
  "mergetool mktag mktree multi-pack-index mv name-rev notes pack-objects pack-refs patch-id prune prune-packed pull push range-diff read-tree " +
  "rebase reflog refs remote repack replace replay request-pull rerere reset restore rev-list rev-parse revert rm send-email shortlog show " +
  "show-branch show-index show-ref sparse-checkout stash status stripspace submodule switch symbolic-ref tag unpack-objects update-index " +
  "update-ref var verify-commit verify-pack verify-tag version whatchanged worktree write-tree").split(" "));
/** git global options that take a separate argument. */
const GIT_GLOBAL_ARGS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env", "--exec-path", "--list-cmds", "--attr-source"]);
/** Variables that make programs run other programs, load code or resolve commands differently (`PAGER=… git log`,
 *  `LD_PRELOAD=…`, `PATH=…`, `HOME=…` with its dotfiles). */
const HOOK_ENV = /^(BASH_ENV|ENV|ZDOTDIR|HOME|XDG_CONFIG_HOME|PROMPT_COMMAND|PS4|IFS|PATH|CDPATH|SHELL|BROWSER|LD_PRELOAD|LD_LIBRARY_PATH|LD_AUDIT|DYLD_\w+|PERL5OPT|PERL5LIB|PERLLIB|PYTHONSTARTUP|PYTHONPATH|PYTHONHOME|NODE_OPTIONS|NODE_PATH|RUBYOPT|RUBYLIB|LESSOPEN|LESSCLOSE|GIT_CONFIG\w*|GIT_EXEC_PATH|GIT_TEMPLATE_DIR|GIT_DIR|GIT_EXTERNAL_DIFF|\w*(PAGER|EDITOR|VISUAL|ASKPASS|_SSH|_COMMAND|_CMD|_PROGRAM|_HOOK|_RSH))$/;
/** ssh options that run a local command, load code or read more config. */
const SSH_RUNS = /^\s*(proxycommand|localcommand|knownhostscommand|match|include|pkcs11provider|securitykeyprovider)\b/i;
/** Options that make a program run a command or code given as a string or file, per program. */
const CODE_FLAGS: Record<string, RegExp> = {
  tar: /^--(to-command|use-compress-program|checkpoint-action|rsh-command|info-script|new-volume-script|rmt-command)(=|$)|^-[A-Za-z]*[IF]/,
  zip: /^(-TT|--unzip-command)(=|$)/,
  vi: /^(-c|--cmd|-S|\+(?!\d*$).+)$/, vim: /^(-c|--cmd|-S|\+(?!\d*$).+)$/, nvim: /^(-c|--cmd|-S|-l|\+(?!\d*$).+)$/, ex: /^(-c|--cmd|-S|\+(?!\d*$).+)$/, view: /^(-c|--cmd|-S|\+(?!\d*$).+)$/,
  emacs: /^(--eval|-l|--load|-f|--funcall|--batch|-batch|-x|--script)(=|$)/,
  gdb: /^(-ex|--ex|-x|--command|--eval-command|-iex|-ix|-batch|--batch)(=|$)/, lldb: /^(-o|-O|--one-line|-s|--source|-k|-S)(=|$)/,
  man: /^(-P|--pager|-H|--html)(=|$)/,
  scp: /^-[A-Za-z]*S/, sftp: /^-[A-Za-z]*[SD]/,
};
/** Command words in a standard system binary directory (a path elsewhere runs a file the agent may have written). */
const SYSTEM_BIN = /^\/(usr\/(local\/)?)?s?bin\/[^/]+$|^\/opt\/homebrew\/s?bin\/[^/]+$|^\/run\/current-system\/sw\/bin\/[^/]+$/;
const base = (cmd: string) => cmd.replace(/^.*\//, "");
const isAssign = (w: Word) => /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/.test(w.value);
const assignName = (w: Word) => w.value.replace(/(\[[^\]]*\])?\+?=.*$/s, "");
const lit = (value: string): Word => ({ value, dyn: false, quoted: false });
/** Does a sed script run commands (the `e` command, `1e cmd`, `/re/e`, or `s///e`)? Errs toward yes. */
const sedExecutes = (s: string) => /(^|[;\n{}!]|[\d$/]|^\s*)\s*e(\s|;|}|$)/.test(s) || /s([^\w\s\\])(?:\\.|(?!\1).)*\1(?:\\.|(?!\1).)*\1[gpIiMm0-9w]*e/.test(s);

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
  // zsh precommand modifiers (`-` runs the command with a dash-prefixed argv[0]).
  noglob: [], nocorrect: [], "-": [],
  "systemd-run": ["-u", "--unit", "-p", "--property", "--description", "--slice", "-E", "--setenv", "--uid", "--gid", "-M", "--machine", "-H", "--host",
    "--on-active", "--on-boot", "--on-startup", "--on-unit-active", "--on-unit-inactive", "--on-calendar", "--timer-property", "--path-property",
    "--socket-property", "--working-directory", "--nice", "--service-type"],
  run0: ["-u", "--user", "-g", "--group", "--unit", "--property", "--description", "--slice", "--setenv", "--nice", "-D", "--chdir"],
  pkexec: ["--user"],
  setpriv: ["--ruid", "--euid", "--reuid", "--rgid", "--egid", "--regid", "--groups", "--inh-caps", "--ambient-caps", "--bounding-set", "--securebits",
    "--pdeathsig", "--selinux-label", "--apparmor-profile", "--landlock-access", "--landlock-rule", "--seccomp-filter"],
  script: ["-T", "-I", "-O", "-B", "-E", "-o", "-m", "--log-timing", "--log-in", "--log-out", "--log-io", "--echo", "--output-limit", "--logging-format"],
  sg: [], runcon: [], gtimeout: ["-s", "-k", "--signal", "--kill-after"], eatmydata: [], fakeroot: ["-l", "--lib", "--faked", "-s", "-i", "-b"],
  "dbus-run-session": ["--config-file", "--dbus-daemon"], "xvfb-run": ["-n", "--server-num", "-e", "--error-file", "-f", "--auth-file", "-p", "--xauth-protocol", "-s", "--server-args"],
  "systemd-inhibit": ["--what", "--who", "--why", "--mode"], prlimit: ["-p", "--pid", "-o", "--output"], numactl: ["-C", "-N", "-m", "-p", "-i"],
  valgrind: [], catchsegv: [], caffeinate: ["-t", "-w"], "ssh-agent": ["-a", "-E", "-P", "-t"], cpulimit: ["-l", "--limit", "-p", "--pid", "-e", "--exe"],
  trickle: ["-u", "-d", "-w", "-t", "-l", "-n"], "aa-exec": ["-p", "--profile", "-n", "--namespace"], chpst: ["-u", "-U", "-e", "-/", "-n", "-l", "-L", "-m", "-d", "-o", "-p", "-f", "-c"],
};
/** Wrappers whose first non-option argument is not the command (a duration, a root dir, a lock file, a cpu mask, …). */
const SKIP_POSITIONAL: Record<string, number> = { timeout: 1, gtimeout: 1, chroot: 1, flock: 1, taskset: 1, chrt: 1, faketime: 1, sg: 1, runcon: 1 };

/** Split a wrapper's arguments: its options, then the wrapped command. undefined = it doesn't run a command
 *  (`command -v`, `ionice -p`). */
function unwrap(name: string, args: Word[]): { rest: Word[]; inner?: Word[] } | undefined {
  const withArg = OPT_ARGS[name] ?? [];
  if (name === "script") { // options may follow the file; without -c it starts an interactive shell
    const k = args.findIndex((w) => w.value === "-c" || w.value === "--command");
    if (k >= 0) return { rest: [], inner: args.slice(k + 1, k + 2) };
    const e = args.find((w) => w.value.startsWith("--command="));
    return e ? { rest: [], inner: [{ ...e, value: e.value.slice(10) }] } : undefined;
  }
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
    if ((name === "su" || name === "sg") && (a === "-c" || a === "--command")) return { rest: [], inner: args.slice(i + 1, i + 2) };
    if (a.startsWith("-") && a.length > 1) {
      const key = a.includes("=") ? a.slice(0, a.indexOf("=")) : a;
      i += withArg.includes(key) && !a.includes("=") && !(key.length === 2 && a.length > 2) ? 2 : 1;
      continue;
    }
    if (positional > 0) { positional--; i++; continue; }
    break;
  }
  let rest = args.slice(i);
  if (name === "parallel") { const k = rest.findIndex((w) => /^:::+$/.test(w.value)); if (k >= 0) rest = rest.slice(0, k); }
  // watch and parallel hand their arguments to a shell as one string.
  if (name === "watch" || name === "parallel") return { rest: [], inner: rest };
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
  const { toks, comments, subs, ok, wordParen } = tokenize(src);
  out.comments.push(...comments);
  if (!ok) unres("unbalanced quotes or here-document");
  // zsh glob qualifiers run code (`*(e:'…':)`, `*(+f)`); an unknown shell may be zsh.
  if (wordParen && (dialect === "zsh" || dialect === "unknown")) unres("zsh glob qualifier or pattern group");
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

type Seg = { words: Word[]; piped: boolean; heredocs: string[]; herestrings: Word[]; stdinFile: boolean };
const plainSeg = (words: Word[]): Seg => ({ words, piped: false, heredocs: [], herestrings: [], stdinFile: false });

/** Value of option `-x val` / `-xval` / `--long val` / `--long=val` at args[k], or undefined. `short`: the option's
 *  letter, matched also at the end of a cluster (`-avze ssh`). Returns [value, words consumed]. */
function optValue(args: Word[], k: number, short: string | undefined, long: string[]): [Word, number] | undefined {
  const v = args[k]!.value;
  for (const l of long) { if (v === l) return args[k + 1] ? [args[k + 1]!, 2] : undefined; if (v.startsWith(`${l}=`)) return [{ ...args[k]!, value: v.slice(l.length + 1) }, 1]; }
  if (short && /^-[A-Za-z0-9]+$/.test(v) && v.endsWith(short)) return args[k + 1] ? [args[k + 1]!, 2] : undefined;
  return undefined;
}

function runSimple(seg: Seg, dialect: ShellDialect, depth: number, out: ShellAnalysis, merge: (a: ShellAnalysis) => void, unres: (why: string) => void) {
  let words = seg.words;
  const stdinCode = () => [...seg.heredocs, ...seg.herestrings.map((w) => { if (w.dyn) unres("here-string with substitution"); return w.value; })];
  /** Analyse a string the command runs as shell code. */
  const code = (w: Word, what: string, d: ShellDialect = dialect) => { out.wrappers.push(what); if (w.dyn) unres(`${what} with substitution`); merge(analyzeShell(w.value, d, depth + 1)); };
  const hookEnv = (ws: Word[]) => { for (const w of ws) if (isAssign(w) && HOOK_ENV.test(assignName(w))) unres(`${assignName(w)}= changes what runs`); };
  const sshOpts = (args: Word[], via: string) => {
    for (let k = 0; k < args.length; k++) {
      const v = args[k]!.value;
      const o = v === "-o" ? args[k + 1]?.value : /^-o./.test(v) ? v.slice(2) : undefined;
      if (o !== undefined && SSH_RUNS.test(o)) unres(`${via} -o ${o.trim().split(/[\s=]/)[0]} runs a command`);
      if (v === "-F" || /^-F./.test(v)) unres(`${via} -F: a config file may run commands`);
    }
  };
  for (let guard = 0; guard < 24; guard++) {
    // Reserved words and grouping are syntax, not commands; loop / case headers run nothing themselves.
    while (words.length && !words[0]!.dyn && !words[0]!.quoted && (LEADING_RESERVED.has(words[0]!.value) || words[0]!.value === "repeat")) {
      const kw = words[0]!.value;
      words = words.slice(kw === "repeat" ? 2 : 1); // zsh `repeat N cmd`
      if (kw === "time" && words[0]?.value === "-p") words = words.slice(1); // `time -p cmd`
    }
    while (words.length && CLOSERS.has(words.at(-1)!.value) && !words.at(-1)!.dyn && !words.at(-1)!.quoted) words = words.slice(0, -1);
    if (words.length && ["for", "select", "case", "foreach"].includes(words[0]!.value) && !words[0]!.quoted) return;
    if (words.length && words[0]!.value === "function" && !words[0]!.quoted) { words = words.slice(2); continue; }
    if (words.length && CLOSERS.has(words[0]!.value) && words.length === 1) return;
    const k0 = words.findIndex((w) => !isAssign(w));
    hookEnv(k0 < 0 ? words : words.slice(0, k0));
    words = k0 < 0 ? [] : words.slice(k0);
    if (!words.length) return;
    // Brace expansion of the command word: {r,}m → rm m.
    const exp = braceExpand(words[0]!);
    if (exp === null) { unres("brace expansion in the command word"); out.commands.push(words.map((w) => w.value)); return; }
    if (exp) { words = [...exp.map(lit), ...words.slice(1)]; continue; }
    const first = words[0]!;
    if (first.dyn || !first.value) { unres("command word from a variable or substitution"); out.commands.push(words.map((w) => w.value)); return; }
    if (dialect === "zsh" && first.value.startsWith("=")) { unres("zsh =command expansion"); out.commands.push(words.map((w) => w.value)); return; }
    // A quoted command word with spaces (`sudo -s 'rm -rf x'`, a string meant for a shell): read it as code too.
    if (/\s/.test(first.value)) { unres("command word contains spaces"); merge(analyzeShell(first.value, dialect, depth + 1)); out.commands.push(words.map((w) => w.value)); return; }
    // A path outside the system binary directories runs a file (`./x.sh`, `bin/run`), like `bash x.sh`.
    if (first.value.includes("/") && !SYSTEM_BIN.test(first.value)) unres(`${first.value} runs a script file`);
    const name = base(first.value);
    const args = words.slice(1);
    const cmd = [name, ...args.map((w) => w.value)];
    if (SHELL_NAME.test(name)) {
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
      const sc = stdinCode();
      if (sc.length) { out.wrappers.push(`${name} <<`); if (family(inner) !== family(dialect)) out.dialectSwitches.push(`${name} <<`); for (const c of sc) merge(analyzeShell(c, inner, depth + 1)); return; }
      const script = args.find((w) => !w.value.startsWith("-"));
      if (seg.piped && !script) { out.hasPipeToShell = true; unres(`${name} reads commands from a pipe`); return; }
      if (seg.stdinFile && !script) { unres(`${name} reads commands from a file`); return; }
      if (script) { unres(`${name} runs a script file`); return; }
      return; // an interactive shell
    }
    if (INTERPRETER_NAME.test(name)) {
      out.commands.push(cmd);
      const inline = args.some((w) => /^(-[A-Za-z]*[ceE]|-r|--eval|-p|--print|eval)$/.test(w.value) && !(name.startsWith("python") && /^-[A-Za-z]*[eE]$/.test(w.value)));
      if (inline) unres(`inline ${name} code`);
      else if (stdinCode().length || args.some((w) => w.value === "-") || ((seg.piped || seg.stdinFile) && !args.some((w) => !w.value.startsWith("-")))) unres(`${name} reads code from stdin`);
      else if (args.some((w) => !w.value.startsWith("-") || w.value === "-m")) unres(`${name} runs a script file`);
      return;
    }
    if (name === "." || name === "source") { out.commands.push(cmd); unres(`${name} runs a script file`); return; }
    if (AWKS.has(name)) {
      out.commands.push(cmd);
      if (args.some((w) => /\bsystem\s*\(|\|\s*getline|\|\s*"|print[^;}]*\|/.test(w.value))) unres("awk runs commands");
      if (args.some((w) => w.value === "-f" || w.value.startsWith("--file"))) unres("awk runs a script file");
      return;
    }
    if (name === "sed" || name === "gsed") {
      out.commands.push(cmd);
      const scripts: Word[] = [];
      let explicit = false;
      for (let k = 0; k < args.length; k++) {
        const v = args[k]!.value;
        const e = optValue(args, k, "e", ["--expression"]);
        if (e) { scripts.push(e[0]); explicit = true; k += e[1] - 1; continue; }
        if (optValue(args, k, "f", ["--file"])) { unres("sed runs a script file"); explicit = true; k++; continue; }
        if (v === "-l" || v === "--line-length") { k++; continue; }
        if (!v.startsWith("-") && !explicit) { scripts.push(args[k]!); explicit = true; }
      }
      if (scripts.some((w) => w.dyn || sedExecutes(w.value))) unres("sed e command runs commands");
      return;
    }
    if (name === "trap") {
      out.commands.push(cmd);
      const k = args.findIndex((w) => !w.value.startsWith("-") || w.value === "-");
      if (k >= 0 && args[k]!.value !== "-" && args.length > k + 1) code(args[k]!, "trap");
      return;
    }
    if (name === "alias") { // alias x='…': what x would run
      out.commands.push(cmd);
      for (const w of args) if (/^[^=-][^=]*=/.test(w.value)) code({ ...w, value: w.value.slice(w.value.indexOf("=") + 1) }, "alias");
      return;
    }
    if (name === "export" || name === "declare" || name === "typeset" || name === "local" || name === "readonly") { out.commands.push(cmd); hookEnv(args); return; }
    if (name === "at" || name === "batch") {
      out.commands.push(cmd);
      const sc = stdinCode();
      if (sc.length) { out.wrappers.push(name); for (const c of sc) merge(analyzeShell(c, "sh", depth + 1)); return; }
      if (!args.some((w) => /^-[lrdc]$/.test(w.value))) unres(`${name} runs commands from stdin or a file`);
      return;
    }
    if (name === "crontab") { out.commands.push(cmd); if (!args.some((w) => /^-[lre]$/.test(w.value))) unres("crontab installs commands"); return; }
    if (name === "sched") { out.wrappers.push("sched"); words = args.slice(1); continue; } // zsh `sched +1 cmd`
    if (name === "git") {
      out.commands.push(cmd);
      let sub: Word | undefined;
      let k = 0;
      for (; k < args.length; k++) {
        const v = args[k]!.value;
        if (v === "-c" && args[k + 1]) { const key = (args[k + 1]!.value.split("=")[0] ?? "").trim(); if (GIT_RUNS_COMMAND.test(key)) unres(`git -c ${key} runs a command`); k++; continue; }
        if (v.startsWith("--config-env")) { unres("git --config-env"); if (!v.includes("=")) k++; continue; }
        if (v.startsWith("--exec-path=") || v === "--exec-path" && args[k + 1] && !args[k + 1]!.value.startsWith("-")) { unres("git --exec-path runs programs from a directory"); if (!v.includes("=")) k++; continue; }
        if (GIT_GLOBAL_ARGS.has(v)) { k++; continue; }
        if (v.startsWith("-")) continue;
        sub = args[k];
        break;
      }
      const rest = args.slice(k + 1);
      if (!sub) return;
      if (sub.dyn) { unres("git command from a variable or substitution"); return; }
      // -c given after the subcommand is not a config option for most commands, but scan anyway: it costs nothing.
      for (let j = 0; j + 1 < rest.length; j++) if (rest[j]!.value === "-c" && /=/.test(rest[j + 1]!.value) && GIT_RUNS_COMMAND.test(rest[j + 1]!.value.split("=")[0]!.trim())) unres(`git -c ${rest[j + 1]!.value.split("=")[0]} runs a command`);
      const s = sub.value;
      if (!GIT_BUILTINS.has(s)) unres(`git ${s}: an alias or external command`);
      if (s === "config") { for (const w of rest) if (!w.value.startsWith("-") && GIT_RUNS_COMMAND.test(w.value.trim())) { unres(`git config ${w.value} sets a command`); break; } }
      if (s === "submodule") { const f = rest.findIndex((w) => w.value === "foreach"); if (f >= 0) { const c = rest.slice(f + 1).filter((w) => !/^(--recursive|-q|--quiet)$/.test(w.value)); if (c.length) code({ value: c.map((w) => w.value).join(" "), dyn: c.some((w) => w.dyn), quoted: true }, "git submodule foreach"); } }
      if (s === "rebase") for (let j = 0; j < rest.length; j++) { const e = optValue(rest, j, "x", ["--exec"]); if (e) { code(e[0], "git rebase --exec"); j += e[1] - 1; } }
      if (s === "bisect" && rest[0]?.value === "run" && rest.length > 1) { out.wrappers.push("git bisect run"); words = rest.slice(1); continue; }
      if (s === "filter-branch" || s === "hook") unres(`git ${s} runs commands`);
      if ((s === "difftool" || s === "mergetool") && rest.some((w) => /^(-x|--extcmd|-t|--tool)(=|$)/.test(w.value))) unres(`git ${s} runs a tool command`);
      return;
    }
    if (name === "eval") {
      out.wrappers.push("eval");
      if (args.some((w) => w.dyn)) unres("eval of non-literal text");
      merge(analyzeShell(args.map((w) => w.value).join(" "), dialect, depth + 1));
      return;
    }
    // Remote / container execution: what runs there is analysed as POSIX (the remote shell is unknown).
    if (name === "ssh" || name === "mosh" || name === "autossh") {
      out.commands.push(cmd);
      sshOpts(args, name);
      if (args.some((w) => /^--ssh(=|$)/.test(w.value))) unres(`${name} --ssh runs a command`);
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
    if (name === "scp" || name === "sftp") sshOpts(args, name);
    if (name === "rsync") {
      out.commands.push(cmd);
      for (let k = 0; k < args.length; k++) {
        const v = args[k]!.value;
        const e = optValue(args, k, "e", ["--rsh"]);
        if (e) { code(e[0], "rsync -e"); k += e[1] - 1; continue; }
        if (/^-[A-Za-z0-9]*e[A-Za-z0-9]+$/.test(v) && !v.startsWith("--")) unres("rsync -e inside an option cluster");
        if (/^--rsync-path(=|$)/.test(v)) unres("rsync --rsync-path runs a remote command");
      }
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
      runSimple(plainSeg(inner), "unknown", depth + 1, sub2,
        (a) => { sub2.commands.push(...a.commands, ...a.remote.flatMap((x) => x.commands)); a.unresolvableReasons.forEach(unres); a.dialectSwitches.forEach((d) => out.dialectSwitches.push(d)); }, unres);
      out.remote.push({ via: `${name} ${verb}`, host, commands: sub2.commands });
      out.dialectSwitches.push(...sub2.dialectSwitches);
      return;
    }
    if (name === "ip" && args[0]?.value === "netns" && args[1]?.value === "exec" && args.length > 3) { out.wrappers.push("ip netns exec"); words = args.slice(3); continue; }
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
      if (name === "env") hookEnv(args);
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
    const flags = CODE_FLAGS[name];
    if (flags && args.some((w) => flags.test(w.value))) unres(`${name} runs a command given as an option`);
    // tar's old-style first argument (`tar xIf …`).
    if (name === "tar" && args[0] && !args[0].value.startsWith("-") && /^[A-Za-z]*[IF]/.test(args[0].value)) unres("tar runs a command given as an option");
    // find -exec / -execdir / -ok … ; runs a command per file.
    if (name === "find") {
      for (let k = 0; k < args.length; k++) {
        if (!["-exec", "-execdir", "-ok", "-okdir"].includes(args[k]!.value)) continue;
        const end = args.findIndex((w, j) => j > k && (w.value === ";" || w.value === "+"));
        const inner = args.slice(k + 1, end < 0 ? undefined : end);
        if (inner.length) { out.wrappers.push("find -exec"); runSimple(plainSeg(inner), dialect, depth, out, merge, unres); }
      }
    }
    return;
  }
  unres("too many nested wrappers");
}
