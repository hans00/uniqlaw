// Memory recall hints (docs §8.7): before a turn, words of the incoming message that are rare in memory get a
// one-line pointer to the memory file that has them, so the agent knows to look before answering as if it never
// discussed them. No list of names or words: a token is a hit only when few memory files contain it (common words
// are in many files; names never written to memory are in none) and, unless it is a CJK phrase of ≥ 4 characters,
// memory writes it like a name somewhere (see lookup). Nothing is added when nothing matches.
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
  // A URL's scheme and host name a site, not the subject: only its path counts (huggingface.co/Cloudflare/clairic → cloudflare, clairic).
  const lower = text.toLowerCase().replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s/?#]*/g, " ");
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
  /** Name signals. Words: `strong` = written like a name at least once (capitalised mid-sentence, mixed case, all
   *  caps, letters with digits, in `backticks`); `caps` = how often written capitalised anywhere. CJK has no case:
   *  the CJK text of the file's path and headings. */
  strong: Set<string>; caps: Map<string, number>; namedCjk: string;
}

/** Sentence or line start before a capital: no name signal (The, Weekly…). */
const SENTENCE_START = /(^|[.!?。！？:：\n#>*"'“「(\[-])\s*$/u;

function digest(path: string, content: string): Omit<FileEntry, "mtime" | "size"> {
  const text = content.replace(/<!--[\s\S]*?-->/g, " ");
  const lower = text.toLowerCase();
  const words = new Map<string, number>();
  for (const m of lower.matchAll(WORD_RUN)) words.set(m[0], (words.get(m[0]) ?? 0) + 1);
  const strong = new Set<string>();
  const caps = new Map<string, number>();
  for (const m of text.matchAll(WORD_RUN)) {
    const w = m[0];
    if (!/^\p{Lu}/u.test(w) && !/\p{N}/u.test(w)) continue;
    const k = w.toLowerCase();
    const rest = w.slice(1);
    if (/^\p{Lu}/u.test(w)) caps.set(k, (caps.get(k) ?? 0) + 1);
    if ((/\p{Lu}/u.test(rest) && /\p{Ll}/u.test(rest)) || (/^\p{Lu}/u.test(w) && !/\p{Ll}/u.test(w)) || (/\p{L}/u.test(w) && /\p{N}/u.test(w))
      || (/^\p{Lu}/u.test(w) && !SENTENCE_START.test(text.slice(Math.max(0, m.index! - 8), m.index!)))) strong.add(k);
  }
  for (const m of text.matchAll(/`([^`\n]{1,60})`/g)) for (const w of m[1]!.toLowerCase().match(WORD_RUN) ?? []) strong.add(w);
  const headings = text.split("\n").filter((l) => /^\s*#/.test(l)).join("\n");
  return { words, cjk: (lower.match(CJK_RUN) ?? []).join("\n"), strong, caps, namedCjk: (`${path}\n${headings}`.toLowerCase().match(CJK_RUN) ?? []).join("\n") };
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

  /** Re-read changed files, drop deleted ones. MEMORY.md is left out: it is in the prompt already. */
  refresh(): void {
    const seen = new Set<string>();
    for (const abs of this.memory.files()) {
      const path = this.memory.rel(abs);
      if (path === MEMORY_FILE) continue;
      let st;
      try { st = statSync(abs); } catch { continue; }
      if (st.size > MAX_FILE_BYTES) continue;
      seen.add(path);
      const k = this.files.get(path);
      const mtime = Math.floor(st.mtimeMs);
      if (k && k.mtime === mtime && k.size === st.size) continue;
      try { this.files.set(path, { mtime, size: st.size, ...digest(path, readFileSync(abs, "utf8")) }); } catch { this.files.delete(path); }
    }
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
    type Found = { tok: MessageToken; df: number; best: string; named: boolean };
    const found: Found[] = [];
    const dfOf = (gram: string) => {
      let d = 0;
      for (const f of this.files.values()) if (f.cjk.includes(gram) && ++d > maxDf) break;
      return d;
    };
    for (const tok of toks) {
      // A trigram that contains a common word (今天天 ⊃ 今天) is a phrase around that word, not a name.
      if (tok.cjk && [...tok.token].length === 3) {
        const c = [...tok.token];
        if (dfOf(c[0]! + c[1]!) > maxDf || dfOf(c[1]! + c[2]!) > maxDf) continue;
      }
      const hits: { path: string; count: number }[] = [];
      for (const [path, f] of this.files) {
        const c = tok.cjk ? (f.cjk.includes(tok.token) ? countIn(f.cjk, tok.token) : 0) : (f.words.get(tok.token) ?? 0);
        if (!c) continue;
        hits.push({ path, count: c });
        if (hits.length > maxDf) break; // common: not a hit
      }
      if (!hits.length || hits.length > maxDf) continue;
      // Topic files before daily notes, then most occurrences, then name.
      hits.sort((a, b) => Number(DAILY_RE.test(a.path)) - Number(DAILY_RE.test(b.path)) || b.count - a.count || a.path.localeCompare(b.path));
      let named: boolean;
      if (tok.cjk) named = hits.some((h) => this.files.get(h.path)!.namedCjk.includes(tok.token));
      else {
        const fs = hits.map((h) => this.files.get(h.path)!);
        const capCount = fs.reduce((a, f) => a + (f.caps.get(tok.token) ?? 0), 0);
        const all = hits.reduce((a, h) => a + h.count, 0);
        named = fs.some((f) => f.strong.has(tok.token)) || (capCount >= 2 && capCount * 2 >= all);
      }
      found.push({ tok, df: hits.length, best: hits[0]!.path, named });
    }
    // Labels: a word, or adjacent CJK trigrams of one run with the same best file joined into one phrase.
    //  - A CJK phrase of ≥ 4 characters counts on rarity alone: a verbatim phrase shared with one note.
    //  - A lone trigram inside a longer run counts only with the CJK name signal below: otherwise it is mostly the end
    //    of one word plus the start of the next (麼改比, 近還好), and those are rare in any corpus too.
    //  - Anything else (a word, a 2-3 character CJK run) counts only if memory writes it like a name: a word capitalised
    //    mid-sentence, in mixed case, all caps, with digits or in backticks somewhere, or capitalised at least twice
    //    and at least as often as not; a CJK run in a file's path or a heading. Rarity alone is not enough there: in a
    //    mostly-Chinese memory, everyday English words (check, project) and short chat words (收到, 好的) are rare too.
    type Label = { text: string; path: string; df: number; first: number; run?: number; end?: number; named: boolean };
    const labels: Label[] = [];
    found.forEach((f, i) => {
      const last = labels.at(-1);
      if (f.tok.cjk && last && last.run === f.tok.run && last.path === f.best && last.end !== undefined && f.tok.at === last.end + 1) {
        last.text += [...f.tok.token].at(-1);
        last.end = f.tok.at;
        last.df = Math.min(last.df, f.df);
        return;
      }
      labels.push({ text: f.tok.token, path: f.best, df: f.df, first: i, named: f.named,
        ...(f.tok.cjk ? { run: f.tok.run!, end: f.tok.at! } : {}) });
    });
    const groups = new Map<string, { labels: Label[]; df: number; spread: number; first: number }>();
    for (const l of labels) {
      const long = l.run !== undefined && [...l.text].length >= 4;
      // CJK: a lone trigram in a longer run counts too when a file's path or heading has it (明天跟林志遠約了, people_林志遠.md).
      if (!long && !l.named) continue;
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
