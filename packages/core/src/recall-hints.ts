// Memory recall hints (docs §8.7): before a turn, words of the incoming message that are rare in memory get a
// one-line pointer to the memory file that has them, so the agent knows to look before answering as if it never
// discussed them. No list of names or words: a token is a hit only when few memory files contain it (common words
// are in many files; names never written to memory are in none) and memory consistently treats it as a name (see
// lookup). Words already in MEMORY.md (the prompt) are skipped. Nothing is added when nothing matches.
import { readFileSync, statSync } from "node:fs";
import { MEMORY_FILE, type MemoryStore } from "./memory.ts";
import type { Origin } from "./origin.ts";

export type RecallHintSource = "human" | "scheduler" | "peer";

export interface RecallHintOptions {
  enabled: boolean;
  /** Pointer lines per message at most. */
  maxHits: number;
  /** A token is rare when at most max(maxDf, maxDfRatio × files) memory files contain it. */
  maxDf: number;
  maxDfRatio: number;
  /** Origins whose messages get hints (a2a never: those sessions have no memory). */
  sources: RecallHintSource[];
  /** The same token is not pointed out again in a session for this long (also forgotten on /new, /clear, /compact). */
  repeatAfterMinutes: number;
}

export const DEFAULT_RECALL_HINTS: RecallHintOptions = { enabled: true, maxHits: 3, maxDf: 3, maxDfRatio: 0.05, sources: ["human"], repeatAfterMinutes: 240 };

const DAILY_RE = /(^|\/)\d{4}-\d{2}-\d{2}(-[a-z0-9._-]+)?\.md$/;
const CJK = "\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}ー々";
const CJK_RUN = new RegExp(`[${CJK}]+`, "gu");
/** Letter/digit runs that are not CJK (Latin, Cyrillic, Greek…). Splits on `_ - . /` too, so URL slugs and
 *  file names come apart: huggingface.co/Cloudflare/clairic → huggingface, cloudflare, clairic. */
const WORD_RUN = new RegExp(`(?:(?![${CJK}])[\\p{L}\\p{N}\\p{M}])+`, "gu");
const MAX_MESSAGE_TOKENS = 200;
const MAX_FILE_BYTES = 2_000_000;

export interface MessageToken {
  token: string;
  cjk: boolean;
  /** CJK n-grams: run index and offset in the run (adjacent grams of a run are joined). */
  run?: number;
  at?: number;
}

/**
 * Tokens of a message, in order, unique. Words: lower case, ≥ 3 characters, not all digits; a URL's scheme and host
 * are left out. CJK (Han, kana, Hangul; no word boundaries): a run of 2 or 3 characters set off by spaces,
 * punctuation or Latin text gives itself; a longer run gives its character trigrams. Overlapping bigrams of long runs
 * are not used: most straddle two words, and such pairs are rare in any corpus, so the rarity test lets them through.
 * Which matches count is decided in lookup().
 */
export function messageTokens(text: string): MessageToken[] {
  const out: MessageToken[] = [];
  const seen = new Set<string>();
  const add = (t: MessageToken) => { if (out.length < MAX_MESSAGE_TOKENS && !seen.has(t.token)) { seen.add(t.token); out.push(t); } };
  // A URL's scheme and host name a site, not the subject: only its path counts (huggingface.co/Cloudflare/clairic →
  // cloudflare, clairic). A local path (/tmp/…, ~/…, ./…) names a place on disk: none of it counts.
  const lower = text.toLowerCase().replace(/(^|\s)[~.]{0,2}\/\S*/g, " ").replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s/?#]*/g, " ");
  for (const m of lower.matchAll(WORD_RUN)) if ([...m[0]].length >= 3 && !/^\p{N}+$/u.test(m[0])) add({ token: m[0], cjk: false });
  let run = 0;
  for (const m of lower.matchAll(CJK_RUN)) {
    const ch = [...m[0]];
    if (ch.length === 2) add({ token: m[0], cjk: true, run, at: 0 });
    else for (let i = 0; i + 3 <= ch.length; i++) add({ token: ch.slice(i, i + 3).join(""), cjk: true, run, at: i });
    run++;
  }
  return out;
}

interface FileEntry {
  mtime: number; size: number;
  /** Word counts, and the CJK text (runs joined by "\n") for n-gram lookup. */
  words: Map<string, number>; cjk: string;
  /** How each word is written in running prose: `named` = like a name (capitalised mid-sentence, mixed case, all caps,
   *  letters with digits), `plain` = all lower case. Sentence-initial capitals, headings, front matter, code spans,
   *  URLs, paths and snake_case identifiers count as neither: case there says nothing about the word. */
  named: Map<string, number>; plain: Map<string, number>;
  /** What the file says it is about: CJK runs of its path, headings and front matter `name:` / `description:` /
   *  `title:`, and of that front matter alone (lower case); for words, the words of its headings and that front matter. */
  titleRuns: string[]; frontRuns: string[]; titleWords: Set<string>; frontWords: Set<string>;
}

/** Text before a word that makes it sentence-initial: list marker / number / time stamp at line start, or a
 *  sentence-ending or opening punctuation mark. */
const INITIAL_PREFIX = /^\s*(?:[-*+]|\d+[.)])?\s*(?:\d{1,2}:\d{2}\s*)?(?:\*\*|__)?\s*$/u;
const INITIAL_PUNCT = /[.!?。！？:：>"'“「（(\[—–-]\s*$/u;
/** A whitespace-separated chunk that is a path, URL, file name or identifier. */
const CODE_CHUNK = /[\/\\_]|:\/\/|\p{L}\.\p{L}/u;

function frontMatter(text: string): string {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  return m ? m[1]!.split("\n").filter((l) => /^\s*(name|description|title)\s*:/i.test(l)).join("\n") : "";
}

function digest(path: string, content: string): Omit<FileEntry, "mtime" | "size"> {
  const text = content.replace(/<!--[\s\S]*?-->/g, " ");
  const lower = text.toLowerCase();
  const words = new Map<string, number>();
  for (const m of lower.matchAll(WORD_RUN)) words.set(m[0], (words.get(m[0]) ?? 0) + 1);
  const front = frontMatter(text);
  const body = (front ? text.replace(/^---\n[\s\S]*?\n---/, "") : text)
    .replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ").replace(/\b[a-z][a-z0-9+.-]*:\/\/\S*/gi, " ");
  const named = new Map<string, number>();
  const plain = new Map<string, number>();
  const headings: string[] = [];
  for (const line of body.split("\n")) {
    if (/^\s*#/.test(line)) { headings.push(line); continue; }
    for (const m of line.matchAll(WORD_RUN)) {
      const w = m[0];
      const i = m.index!;
      let a = i, z = i + w.length;
      while (a > 0 && !/\s/.test(line[a - 1]!)) a--;
      while (z < line.length && !/\s/.test(line[z]!)) z++;
      if (CODE_CHUNK.test(line.slice(a, z))) continue;
      const k = w.toLowerCase();
      if (w === k) { if (/\p{L}/u.test(w)) plain.set(k, (plain.get(k) ?? 0) + 1); continue; }
      const rest = w.slice(1);
      const before = line.slice(0, i);
      const nameLike = (/\p{Lu}/u.test(rest) && /\p{Ll}/u.test(rest)) || (w.length >= 2 && !/\p{Ll}/u.test(w)) || (/\p{L}/u.test(w) && /\p{N}/u.test(w))
        || !(INITIAL_PREFIX.test(before) || INITIAL_PUNCT.test(before));
      if (nameLike) named.set(k, (named.get(k) ?? 0) + 1);
    }
  }
  const title = `${path}\n${headings.join("\n")}\n${front}`.toLowerCase();
  // Words of headings and front matter (not of the path, not inside identifiers like project_uniqlaw: file-name
  // prefixes such as project_, ref_, ops_ are generic).
  const proseWords = (t: string) => t.toLowerCase().split(/\s+/).filter((c) => !CODE_CHUNK.test(c)).flatMap((c) => c.match(WORD_RUN) ?? []);
  return { words, cjk: (lower.match(CJK_RUN) ?? []).join("\n"), named, plain,
    titleRuns: title.match(CJK_RUN) ?? [], frontRuns: front.toLowerCase().match(CJK_RUN) ?? [],
    titleWords: new Set(proseWords(`${headings.join("\n")}\n${front.replace(/^\s*\w+\s*:/gm, " ")}`)), frontWords: new Set(proseWords(front.replace(/^\s*\w+\s*:/gm, " "))) };
}

/** Share of a word's prose occurrences, over all memory files that hold it, that must be written like a name.
 *  Everyday words are lower case in running prose and capitalised mostly at sentence starts, which don't count:
 *  their share sits near 0 (message, request, history, reply: 0.00 in the English-notes test corpus). Names are
 *  capitalised wherever they appear but are now and then written in lower case (clairic 0.67, snac 1.00 there).
 *  0.5 sits between the two: a name may be lower case as often as not. */
export const NAME_SHARE = 0.5;

/** A heading / path / front-matter CJK run names `token` when the token is at least half of it: 克立淨 in
 *  「克立淨空清機」 (two names run together) yes, 話說 in 「用自己的話換句話說」 (a phrase that happens to contain it) no. */
function namesCjk(runs: string[], token: string): boolean {
  const n = [...token].length;
  return runs.some((r) => r.includes(token) && [...r].length <= 2 * n);
}

function countIn(hay: string, needle: string): number {
  let n = 0;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
}

/** `df`: files holding the rarest of `tokens` (ranking); `spread`: files holding the most widespread one (the pointer's "+N more files"). */
export interface RecallHit { tokens: string[]; path: string; df: number; spread: number }

/** Per-session dedupe and the in-memory index over the memory directory (refreshed by mtime/size on each lookup). */
export class RecallHinter {
  private files = new Map<string, FileEntry>();
  private hinted = new Map<string, Map<string, number>>();

  constructor(private memory: Pick<MemoryStore, "dir" | "files" | "rel">, private opts: RecallHintOptions = DEFAULT_RECALL_HINTS,
    private now: () => number = Date.now) {}

  /** Words and CJK text of MEMORY.md: already in the agent's prompt, so never pointed out. */
  private inPrompt: { mtime: number; size: number; words: Set<string>; cjk: string } | undefined;

  /** Re-read changed files, drop deleted ones. MEMORY.md is not a target: it is in the prompt already. */
  refresh(): void {
    const seen = new Set<string>();
    let memSeen = false;
    for (const abs of this.memory.files()) {
      const path = this.memory.rel(abs);
      let st;
      try { st = statSync(abs); } catch { continue; }
      if (st.size > MAX_FILE_BYTES) continue;
      const mtime = Math.floor(st.mtimeMs);
      if (path === MEMORY_FILE) {
        memSeen = true;
        if (this.inPrompt?.mtime === mtime && this.inPrompt.size === st.size) continue;
        try {
          const lower = readFileSync(abs, "utf8").toLowerCase();
          this.inPrompt = { mtime, size: st.size, words: new Set(lower.match(WORD_RUN) ?? []), cjk: (lower.match(CJK_RUN) ?? []).join("\n") };
        } catch { this.inPrompt = undefined; }
        continue;
      }
      seen.add(path);
      const k = this.files.get(path);
      if (k && k.mtime === mtime && k.size === st.size) continue;
      try { this.files.set(path, { mtime, size: st.size, ...digest(path, readFileSync(abs, "utf8")) }); } catch { this.files.delete(path); }
    }
    if (!memSeen) this.inPrompt = undefined;
    for (const p of this.files.keys()) if (!seen.has(p)) this.files.delete(p);
  }

  /** Rare-in-memory tokens of `text` with the best file for each, merged by file, rarest first. No dedupe. */
  lookup(text: string): RecallHit[] {
    const toks = messageTokens(text);
    if (!toks.length) return [];
    this.refresh();
    const n = this.files.size;
    if (!n) return [];
    const maxDf = Math.max(this.opts.maxDf, Math.floor(this.opts.maxDfRatio * n));
    type Found = { tok: MessageToken; df: number; best: string };
    const found: Found[] = [];
    const dfOf = (gram: string) => {
      let d = 0;
      for (const f of this.files.values()) if (f.cjk.includes(gram) && ++d > maxDf) break;
      return d;
    };
    for (const tok of toks) {
      // Already in the prompt (MEMORY.md): the hint would say "not in your context" about something that is.
      if (tok.cjk ? this.inPrompt?.cjk.includes(tok.token) : this.inPrompt?.words.has(tok.token)) continue;
      // A trigram that contains a common word (今天天 ⊃ 今天) is a phrase around that word, not a name.
      if (tok.cjk && [...tok.token].length === 3) {
        const c = [...tok.token];
        if (dfOf(c[0]! + c[1]!) > maxDf || dfOf(c[1]! + c[2]!) > maxDf) continue;
      }
      const hits: { path: string; f: FileEntry; count: number; front: boolean; title: boolean }[] = [];
      for (const [path, f] of this.files) {
        const c = tok.cjk ? (f.cjk.includes(tok.token) ? countIn(f.cjk, tok.token) : 0) : (f.words.get(tok.token) ?? 0);
        if (!c) continue;
        hits.push({ path, f, count: c, front: tok.cjk ? namesCjk(f.frontRuns, tok.token) : f.frontWords.has(tok.token),
          title: tok.cjk ? namesCjk(f.titleRuns, tok.token) : f.titleWords.has(tok.token) });
        if (hits.length > maxDf) break; // common: not a hit
      }
      if (!hits.length || hits.length > maxDf) continue;
      // The name signal (see below the loop).
      if (tok.cjk) {
        // CJK has no case: a run of the target file's path, headings or front matter must be at least half this token (namesCjk).
        if (!hits.some((h) => h.title)) continue;
      } else {
        const nameLike = hits.reduce((a, h) => a + (h.f.named.get(tok.token) ?? 0), 0);
        const plain = hits.reduce((a, h) => a + (h.f.plain.get(tok.token) ?? 0), 0);
        // No prose occurrence that tells (only sentence starts, headings, code): the file's title decides.
        if (!nameLike && !plain) { if (!hits.some((h) => h.title)) continue; }
        else if (nameLike < NAME_SHARE * (nameLike + plain)) continue;
      }
      // Best file: front matter names it, then path/heading names it, then topic files before daily notes, then
      // most occurrences, then path.
      hits.sort((a, b) => Number(b.front) - Number(a.front) || Number(b.title) - Number(a.title)
        || Number(DAILY_RE.test(a.path)) - Number(DAILY_RE.test(b.path)) || b.count - a.count || a.path.localeCompare(b.path));
      found.push({ tok, df: hits.length, best: hits[0]!.path });
    }
    // A token is a hit when it is rare (df ≤ maxDf) and memory treats it as a name. Rarity alone is not enough: a
    // memory of a few hundred files has many everyday words in ≤ 5% of them (message, request, 話說, 專有名詞).
    //  - Latin words: at least NAME_SHARE of their prose occurrences across memory are written like a name; with no
    //    telling occurrence at all (only at sentence starts, in headings or code), a file holding it names it in its
    //    path, a heading or its front matter.
    //  - CJK: a run of the best file's path, headings or front matter that it makes up at least half of (namesCjk). A CJK name that is only in note bodies is
    //    not found: without case or word boundaries it looks like any rare pair of words.
    // Adjacent CJK trigrams of one run with the same best file are joined into one phrase.
    type Label = { text: string; path: string; df: number; first: number; run?: number; end?: number };
    const labels: Label[] = [];
    found.forEach((f, i) => {
      const last = labels.at(-1);
      if (f.tok.cjk && last && last.run === f.tok.run && last.path === f.best && last.end !== undefined && f.tok.at === last.end + 1) {
        last.text += [...f.tok.token].at(-1);
        last.end = f.tok.at;
        last.df = Math.min(last.df, f.df);
        return;
      }
      labels.push({ text: f.tok.token, path: f.best, df: f.df, first: i, ...(f.tok.cjk ? { run: f.tok.run!, end: f.tok.at! } : {}) });
    });
    const groups = new Map<string, { labels: Label[]; df: number; spread: number; first: number }>();
    for (const l of labels) {
      const g = groups.get(l.path) ?? { labels: [], df: l.df, spread: l.df, first: l.first };
      g.labels.push(l);
      g.df = Math.min(g.df, l.df);
      g.spread = Math.max(g.spread, l.df);
      groups.set(l.path, g);
    }
    return [...groups].sort(([, a], [, b]) => a.df - b.df || a.first - b.first)
      .map(([path, g]) => ({ path, df: g.df, spread: g.spread, tokens: g.labels.sort((a, b) => a.df - b.df).map((l) => l.text) }));
  }

  /** The hint block for a message to `session`, or undefined (nothing rare, or all pointed out recently).
   *  The words count as pointed out only once `commit()` is called (the text reached the agent). */
  hint(session: string, origin: Origin, text: string): { block: string; commit(): void } | undefined {
    if (!this.opts.enabled || !(this.opts.sources as string[]).includes(origin.kind)) return undefined;
    const now = this.now();
    const ttl = this.opts.repeatAfterMinutes * 60_000;
    const done = this.hinted.get(session);
    if (done) for (const [t, at] of done) if (now - at >= ttl) done.delete(t);
    const lines: string[] = [];
    const shown: string[] = [];
    for (const h of this.lookup(text.replace(TRANSCRIPT_LABEL_RE, " "))) {
      const fresh = h.tokens.filter((t) => !done?.has(t));
      if (!fresh.length) continue;
      shown.push(...fresh);
      lines.push(`- ${fresh.slice(0, 3).join(", ")} → memory/${h.path}${h.spread > 1 ? ` (+${h.spread - 1} more file${h.spread > 2 ? "s" : ""})` : ""}`);
      if (lines.length >= this.opts.maxHits) break;
    }
    if (!lines.length) return undefined;
    return {
      block: [RECALL_HINT_HEADER, ...lines].join("\n"),
      commit: () => {
        const m = this.hinted.get(session) ?? new Map<string, number>();
        for (const t of shown) m.set(t, now);
        this.hinted.set(session, m);
      },
    };
  }

  /** The session's context was reset (/new, /clear, /compact, a fresh provider session): point things out again. */
  forget(session: string): void { this.hinted.delete(session); }
}

/** The label of a voice/audio transcript added to a message (ChannelManager.transcribe): not the human's words. */
const TRANSCRIPT_LABEL_RE = /\[(?:Voice message|Audio) transcript(?: \([^)]*\))?: /g;

export const RECALL_HINT_HEADER = "[Memory recall hint: words in this message appear in memory files that are not in your context. Check them with memory_get / memory_search before answering, if relevant.]";
