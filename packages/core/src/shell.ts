// Shell command normalization for the approval judge (docs §10.4). Not a shell: a conservative reader that turns a
// command line into the simple commands it would run, so deny rules can't be dodged by quoting (`r''m`, `"rm"`,
// `\rm`), grouping (`(rm …)`, `{ rm …; }`, `! rm`), wrappers (`sudo`, `env`, `timeout`, `xargs`, `sh -c '…'`, …) or
// substitution (`echo $(rm …)`). What it cannot resolve (a command word from a variable or substitution, `eval` of
// non-literal text, unbalanced quotes) is flagged `unresolvable`.

/** Structure of a shell command line, passed to the judge as typed, code-computed data. */
export interface ShellShape {
  /** Simple commands found, including those inside substitutions and `sh -c` / `eval` strings. */
  segments: number;
  hasSubstitution: boolean;
  /** Output piped into a shell (`curl … | sh`). */
  hasPipeToShell: boolean;
  /** Wrappers that were unwrapped (sudo, env, timeout, sh -c, …), in order of appearance. */
  wrappers: string[];
  /** Something decides what runs that code can't see: a command word from a variable or substitution, `eval` of
   *  non-literal text, unbalanced quotes. */
  unresolvable: boolean;
}

export interface ShellAnalysis extends ShellShape {
  /** Each simple command as its unquoted words, command word reduced to its base name (`/bin/rm` → `rm`). */
  commands: string[][];
  /** Text of `#` comments (outside quotes). */
  comments: string[];
  /** File redirections and their targets (`> out.txt` overwrites, `>> log` appends, `< in` reads). */
  redirects: { op: ">" | ">>" | "<"; target: string }[];
}

interface Word { value: string; dyn: boolean }
type Tok = { t: "w"; w: Word } | { t: "op"; v: string };

const SEP_OPS = new Set([";", "&&", "||", "|", "|&", "&", "\n", ";;", "(", ")"]);

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

function tokenize(src: string): { toks: Tok[]; comments: string[]; subs: string[]; redirects: ShellAnalysis["redirects"]; ok: boolean } {
  const toks: Tok[] = [];
  const comments: string[] = [];
  const subs: string[] = [];
  const redirects: ShellAnalysis["redirects"] = [];
  let redirOp: ">" | ">>" | "<" = ">";
  let ok = true;
  let cur: Word | undefined;
  const flush = () => { if (cur) toks.push({ t: "w", w: cur }); cur = undefined; };
  const word = () => (cur ??= { value: "", dyn: false });
  let skipNextWord = false; // a redirection's target is not a command word
  const pushWordOrSkip = () => {
    if (skipNextWord && cur) { redirects.push({ op: redirOp, target: cur.value }); cur = undefined; skipNextWord = false; return; }
    flush();
  };
  const sub = (body: string) => { subs.push(body); const w = word(); w.dyn = true; w.value += "$(…)"; };
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    const n = src[i + 1];
    if (c === " " || c === "\t") { pushWordOrSkip(); continue; }
    if (c === "\\") {
      if (n === "\n") { i++; continue; } // line continuation
      if (n !== undefined) word().value += n;
      i++;
      continue;
    }
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      if (end < 0) { ok = false; word().value += src.slice(i + 1); break; }
      word().value += src.slice(i + 1, end);
      i = end;
      continue;
    }
    if (c === '"') {
      const w = word();
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
      pushWordOrSkip(); subs.push(r[0]); toks.push({ t: "w", w: { value: "<(…)", dyn: true } }); i = r[1] - 1; continue;
    }
    if (c === "`") { const e = src.indexOf("`", i + 1); if (e < 0) { ok = false; break; } sub(src.slice(i + 1, e)); i = e; continue; }
    if (c === "$") { word().dyn = true; word().value += c; continue; }
    if (c === "<" || c === ">") {
      // Redirection: drop a pending fd number ("2>"), skip operator chars, the next word is its target.
      if (cur && /^\d+$/.test(cur.value) && !cur.dyn) cur = undefined; else pushWordOrSkip();
      redirOp = c === "<" ? "<" : src[i + 1] === ">" ? ">>" : ">";
      while (src[i + 1] === ">" || src[i + 1] === "<" || src[i + 1] === "&" || src[i + 1] === "|") i++;
      if (/^\d$/.test(src[i + 1] ?? "") && src[i] === "&") { i++; continue; } // >&2
      skipNextWord = true;
      continue;
    }
    if (c === "\n" || c === ";" || c === "&" || c === "|" || c === "(" || c === ")") {
      pushWordOrSkip();
      let op = c;
      if ((c === "&" && n === "&") || (c === "|" && n === "|") || (c === ";" && n === ";") || (c === "|" && n === "&")) { op += n; i++; }
      toks.push({ t: "op", v: op });
      continue;
    }
    word().value += c;
  }
  pushWordOrSkip();
  return { toks, comments, subs, redirects, ok };
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "ash", "mksh"]);
const base = (cmd: string) => cmd.replace(/^.*\//, "");
const isAssign = (w: Word) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w.value);

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

/**
 * Analyse a shell command line (recursing into substitutions, `sh -c` / `bash -c` / `eval` / `env -S` / `flock -c`
 * strings, `find -exec`) and return every simple command it would run, with its structure.
 */
export function analyzeShell(src: string, depth = 0): ShellAnalysis {
  const out: ShellAnalysis = { commands: [], comments: [], redirects: [], segments: 0, hasSubstitution: false, hasPipeToShell: false, wrappers: [], unresolvable: false };
  if (depth > 8) { out.unresolvable = true; return out; }
  const { toks, comments, subs, redirects, ok } = tokenize(src);
  out.comments.push(...comments);
  out.redirects.push(...redirects);
  if (!ok) out.unresolvable = true;
  const merge = (a: ShellAnalysis) => {
    out.commands.push(...a.commands); out.comments.push(...a.comments); out.redirects.push(...a.redirects);
    out.hasSubstitution ||= a.hasSubstitution; out.hasPipeToShell ||= a.hasPipeToShell; out.unresolvable ||= a.unresolvable;
    out.wrappers.push(...a.wrappers);
  };
  if (subs.length) out.hasSubstitution = true;
  for (const s of subs) merge(analyzeShell(s, depth + 1));
  // Simple commands: words between separators; remember whether one is fed by a pipe.
  let words: Word[] = [];
  let piped = false;
  const segments: { words: Word[]; piped: boolean }[] = [];
  for (const t of toks) {
    if (t.t === "op" && SEP_OPS.has(t.v)) {
      if (words.length) segments.push({ words, piped });
      words = [];
      piped = t.v === "|" || t.v === "|&";
      continue;
    }
    if (t.t === "w") words.push(t.w);
  }
  if (words.length) segments.push({ words, piped });
  for (const seg of segments) runSimple(seg.words, seg.piped, depth, out, merge);
  out.segments = out.commands.length;
  out.wrappers = [...new Set(out.wrappers)];
  return out;
}

function runSimple(input: Word[], piped: boolean, depth: number, out: ShellAnalysis, merge: (a: ShellAnalysis) => void) {
  let words = input;
  for (let guard = 0; guard < 16; guard++) {
    // Grouping and negation are syntax, not commands.
    while (words.length && ["{", "}", "!", "(", ")"].includes(words[0]!.value) && !words[0]!.dyn) words = words.slice(1);
    while (words.length && ["}", ")"].includes(words.at(-1)!.value) && !words.at(-1)!.dyn) words = words.slice(0, -1);
    while (words.length && isAssign(words[0]!)) words = words.slice(1);
    if (!words.length) return;
    const first = words[0]!;
    if (first.dyn || !first.value) { out.unresolvable = true; out.commands.push(words.map((w) => w.value)); return; }
    const name = base(first.value);
    const args = words.slice(1);
    if (SHELLS.has(name)) {
      const ci = args.findIndex((w) => /^-[A-Za-z]*c[A-Za-z]*$/.test(w.value));
      if (ci >= 0) {
        out.wrappers.push(`${name} -c`);
        const str = args.slice(ci + 1).find((w) => !w.value.startsWith("-"));
        if (!str) { out.unresolvable = true; return; }
        merge(analyzeShell(str.value, depth + 1));
        return;
      }
      if (piped && !args.some((w) => !w.value.startsWith("-"))) out.hasPipeToShell = true;
      out.commands.push([name, ...args.map((w) => w.value)]);
      return;
    }
    if (name === "eval") {
      out.wrappers.push("eval");
      if (args.some((w) => w.dyn)) out.unresolvable = true;
      merge(analyzeShell(args.map((w) => w.value).join(" "), depth + 1));
      return;
    }
    if (name in OPT_ARGS) {
      const u = unwrap(name, args);
      out.wrappers.push(name);
      if (!u) { out.commands.push([name, ...args.map((w) => w.value)]); return; }
      if (u.inner) {
        if (u.inner.some((w) => w.dyn)) out.unresolvable = true;
        merge(analyzeShell(u.inner.map((w) => w.value).join(" "), depth + 1));
        return;
      }
      if (!u.rest.length) { out.commands.push([name, ...args.map((w) => w.value)]); return; }
      words = u.rest;
      continue;
    }
    const cmd = [name, ...args.map((w) => w.value)];
    out.commands.push(cmd);
    // find -exec / -execdir / -ok … ; runs a command per file.
    if (name === "find") {
      for (let k = 0; k < args.length; k++) {
        if (!["-exec", "-execdir", "-ok", "-okdir"].includes(args[k]!.value)) continue;
        const end = args.findIndex((w, j) => j > k && (w.value === ";" || w.value === "+"));
        const inner = args.slice(k + 1, end < 0 ? undefined : end);
        if (inner.length) { out.wrappers.push("find -exec"); runSimple(inner, false, depth, out, merge); }
      }
    }
    return;
  }
}
