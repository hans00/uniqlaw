// Memory recall hints (docs §8.7): rare-in-memory words of a message get a one-line pointer to the memory file.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ChannelManager, DEFAULT_RECALL_HINTS, DICTIONARY_NAME_SHARE, MemoryStore, NAME_SHARE, RECALL_HINT_HEADER, RecallHinter, StateStore, isCommonCjk, isDictionaryWord, messageTokens, segmentCjk, parseSettings, silentLogger,
  type InboundMessage, type Origin, type Profile, type RecallHintOptions,
} from "../src/index.ts";
import { FakePlatform, FakeProvider } from "./fakes.ts";
import {
  GENERIC_MESSAGES, HOLDOUT_GENERIC, HOLDOUT_NAMED, PRECISION_MESSAGES, REAL_MESSAGES, writeHoldoutFixture, writePrecisionFixture, writeRealShapeFixture, writeRecallFixture,
} from "./recall-fixture.ts";

const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

const CLAIRIC_MSG = "話說 clairic 發佈了，請看一下他們是怎麼做的 https://huggingface.co/Cloudflare/clairic";
const human: Origin = { kind: "human", platform: "tg", channelKey: "tg:1", sender: { id: "1", name: "Hans" }, replyTarget: { platform: "tg", chatId: "1" },
  ref: { platform: "tg", chatId: "1", messageId: "1" }, trusted: true };
const cron: Origin = { kind: "scheduler", job: "daily" };
const peer: Origin = { kind: "peer", fromSession: "tg:2", hop: 1, mode: "ask", taskId: "t1" };

/** hint() + commit(): the block as the agent would see it. */
function show(h: RecallHinter, session: string, origin: Origin, text: string): string | undefined {
  const r = h.hint(session, origin, text);
  r?.commit();
  return r?.block;
}

function setup(opts: Partial<RecallHintOptions> = {}) {
  const root = mkdtempSync(join(tmpdir(), "uq-recall-"));
  const store = new StateStore(join(root, "state.db"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }), () => store.close());
  const dir = writeRecallFixture(root);
  let now = 1_000_000;
  const mem = new MemoryStore(root, store);
  const hinter = new RecallHinter(mem, { ...DEFAULT_RECALL_HINTS, ...opts }, () => now);
  return { root, dir, hinter, advance: (ms: number) => { now += ms; } };
}

describe("tokens", () => {
  test("words lower-cased, split at URL and file-name punctuation, ≥ 3 chars, no pure numbers, no URL scheme/host, no local paths; CJK 2/3-char runs whole, longer runs as trigrams", () => {
    const t = messageTokens("話說 Clairic v2 發佈了 https://huggingface.co/Cloudflare/clairic ref_paper_261023 林志遠 /tmp/claude-1000/-home-hans-Projects/ ~/notes x").map((x) => x.token);
    expect(t).toEqual(["clairic", "cloudflare", "ref", "paper", "話說", "發佈了", "林志遠"]);
    expect(messageTokens("今天天氣如何").map((x) => x.token)).toEqual(["今天天", "天天氣", "天氣如", "氣如何"]);
  });

  test("a URL path segment joined by - _ . is one token (an org or repo slug); query and fragment are left out", () => {
    const t = messageTokens("看 https://github.com/vercel-labs/skills/pull/2470?utm_source=feed#issuecomment-1 和 mybigday-bricks");
    expect(t.map((x) => [x.token, !!x.compound])).toEqual([["vercel-labs", true], ["skills", false], ["pull", false], ["mybigday", false], ["bricks", false]]);
    // A URL ends at CJK or full-width punctuation glued to it; a file name's extension is dropped.
    expect(messageTokens("看 https://huggingface.co/Cloudflare/clairic，克立淨的空清機").map((x) => x.token))
      .toEqual(["cloudflare", "clairic", "克立淨", "立淨的", "淨的空", "的空清", "空清機"]);
    expect(messageTokens("https://github.com/x/codec.cpp/blob/main/README.md https://a.io/b/my-tool.json").map((x) => x.token))
      .toEqual(["codec", "blob", "main", "readme", "my-tool"]);
  });
});

describe("recall hints", () => {
  test("regression: a name only in topic files → exactly one pointer, to the topic file", () => {
    const { hinter } = setup();
    const block = show(hinter, "tg:1", human, CLAIRIC_MSG);
    // "Clairic" is in 3 of 30 files; the paper note wins over the daily note and topics/ref_models.md: its heading
    // names it. "Cloudflare" is only inside the model-card URL (no prose use: case there says nothing, and the
    // heading doesn't name it); huggingface.co is a host: no token.
    expect(block).toBe(`${RECALL_HINT_HEADER}\n- clairic → memory/ref_paper_261023_clairic_extraction.md (+2 more files)`);
  });

  test("a generic message adds nothing at all", () => {
    const { hinter } = setup();
    expect(show(hinter, "tg:1", human, "今天天氣如何，幫我看一下")).toBeUndefined();
  });

  test("no false hit on 24 everyday messages (all-bigram CJK tokens without the name signal: 17)", () => {
    const { hinter } = setup();
    expect(GENERIC_MESSAGES.filter((m) => hinter.lookup(m).length)).toEqual([]);
  });

  test("real failure shapes: the 20 operator messages give only the name hits, each to the right file", () => {
    const root = mkdtempSync(join(tmpdir(), "uq-recall-real-"));
    const store = new StateStore(join(root, "state.db"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }), () => store.close());
    writeRealShapeFixture(root);
    // maxDf 6 of 40 files: everyday words in a few files pass the rarity test, as with df ≤ 15 of 304 on the real memory.
    const hinter = new RecallHinter(new MemoryStore(root, store), { ...DEFAULT_RECALL_HINTS, maxDf: 6 });
    for (const [m, want] of REAL_MESSAGES) expect([m, hinter.lookup(m).map((h) => h.path)]).toEqual([m, want]);
    expect(hinter.lookup("克立淨的空清機又連不上了")[0]!.tokens).toEqual(["克立淨", "空清機"]);
    // SNAC: most occurrences are in the lecture note; the codec project's front matter names it, so it wins.
    expect(hinter.lookup("SNAC")[0]!.path).toBe("project_codec_cpp.md");
    // Words of MEMORY.md (in the prompt) are never pointed out, even when rare and name-like elsewhere.
    expect(hinter.lookup("Gemini 的 Codex 設定")).toEqual([]);
  });

  test("production false hits (2026-11-23): everyday English words and URL slug parts; names still found", () => {
    const root = mkdtempSync(join(tmpdir(), "uq-recall-prec-"));
    const store = new StateStore(join(root, "state.db"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }), () => store.close());
    const dir = writePrecisionFixture(root);
    const hinter = new RecallHinter(new MemoryStore(root, store));
    for (const [m, want] of PRECISION_MESSAGES) expect([m, hinter.lookup(m).map((h) => h.path)]).toEqual([m, want]);
    // Each false line, and which rule stops it. labs / contribution / overview: dictionary words, capitalised in a
    // lab's name, a title-case phrase, an "## Overview" heading; no file's H1 or front matter name is about them.
    expect(["labs", "contribution", "overview", "activity", "tunnel"].map(isDictionaryWord)).toEqual([true, true, true, true, true]);
    expect(hinter.lookup("labs contribution overview activity")).toEqual([]);
    // vercel: not a dictionary word, capitalised in a note; written as a word it still points. In the URL it is
    // part of the slug vercel-labs, which memory doesn't have.
    expect(isDictionaryWord("vercel")).toBe(false);
    expect(hinter.lookup("vercel 的預覽壞了").map((h) => h.path)).toEqual(["project_bricks_evidence_plane.md"]);
    expect(hinter.lookup("https://github.com/vercel-labs/skills")).toEqual([]);
    // A slug memory has, whole, points (no name signal needed); one made only of everyday words doesn't.
    writeFileSync(join(dir, "ref_skills_cli.md"), "# skills CLI\n\n- 來源：vercel-labs/skills，open-source 的 skills 安裝器。\n");
    expect(hinter.lookup("https://github.com/vercel-labs/skills/pull/2470").map((h) => [h.tokens, h.path])).toEqual([[["vercel-labs"], "ref_skills_cli.md"]]);
    expect(hinter.lookup("https://example.com/docs/open-source")).toEqual([]);
    // File names in a URL: the extension is not a part that makes the slug specific.
    writeFileSync(join(dir, "2026-10-03.md"), "# 2026-10-03\n\n- 10:00 改了 README.md 和 package.json。\n");
    expect(hinter.lookup("https://github.com/x/y/blob/main/README.md https://github.com/x/y/blob/main/package.json")).toEqual([]);
    // The title must be the word alone: "# Evidence plane", "# Activity Overview", "# 課程 Overview" don't count.
    writeFileSync(join(dir, "n1.md"), "# 課程 Overview\n\n- x\n");
    writeFileSync(join(dir, "n2.md"), "# Activity Overview\n\n- y\n");
    expect(hinter.lookup("evidence plane overview activity")).toEqual([]);
    // Names: not dictionary words (cloudflare, clairic, snac); a product named by one (Ember) points through its
    // front matter name and H1, capitalised in all prose uses (≥ DICTIONARY_NAME_SHARE).
    expect(["cloudflare", "clairic", "snac", "bestrand"].map(isDictionaryWord)).toEqual([false, false, false, false]);
    expect(isDictionaryWord("ember")).toBe(true);
    expect(DICTIONARY_NAME_SHARE).toBe(0.9);
    writeFileSync(join(dir, "2026-10-02.md"), "# 2026-10-02\n\n- 10:00 the ember of the fire, and the ember glow.\n");
    expect(hinter.lookup("ember 的圖表")).toEqual([]); // its only telling prose uses are lower case
  });

  test("common words of any language (tokenizer vocabulary): a CJK heading that contains one is no name signal", () => {
    const { dir, hinter } = setup();
    // Production (2026-11-25): 「一個有趣的思路」 → 有趣的, from the heading 「最有趣的反轉」.
    writeFileSync(join(dir, "ref_speechlab_xiaojin_0608_names.md"), "# 語音實驗室 0608\n\n## 最有趣的反轉\n\n- 結論和預期相反。\n");
    expect(segmentCjk("一個有趣的思路")).toEqual(["一個", "有趣的", "思路"]);
    expect(isCommonCjk("有趣的")).toBe(true);
    expect(hinter.lookup("一個有趣的思路")).toEqual([]);
    expect(hinter.lookup("有趣的")).toEqual([]);
    // How names segment: a name no token knows falls apart into characters and stays eligible; one that is a
    // vocabulary word (小金, 雷神) is common and points only from a file whose H1, front matter name or path is it.
    expect(["克立淨", "小金", "李宏毅", "雷神"].map((w) => [w, segmentCjk(w).join("|"), isCommonCjk(w)]))
      .toEqual([["克立淨", "克|立|淨", false], ["小金", "小金", true], ["李宏毅", "李|宏|毅", false], ["雷神", "雷神", true]]);
    writeFileSync(join(dir, "topics", "people_李宏毅.md"), "# 李宏毅老師的課\n\n- 生成式 AI 導論。\n");
    expect(hinter.lookup("李宏毅 的新影片").map((h) => h.path)).toEqual(["topics/people_李宏毅.md"]);
    writeFileSync(join(dir, "topics", "people_xiaojin.md"), "# 小金老師\n\n- 每週的影片。\n");
    expect(hinter.lookup("小金 的影片")).toEqual([]); // H1 「小金老師」 is not the word alone
    writeFileSync(join(dir, "topics", "people_小金.md"), "- 小金老師每週出影片。\n");
    expect(hinter.lookup("小金 的影片").map((h) => h.path)).toEqual(["topics/people_小金.md"]); // the path is
    // Rare Latin names are no tokens: still hit.
    expect(["clairic", "jevling"].map(isDictionaryWord)).toEqual([false, false]);
    writeFileSync(join(dir, "topics", "proj_jevling.md"), "# Jevling evals\n\n- The Jevling E2B eval runs nightly.\n");
    expect(hinter.lookup("Jevling 的 eval 跑完了嗎").map((h) => h.path)).toEqual(["topics/proj_jevling.md"]);
    expect(hinter.lookup("clairic").map((h) => h.path)).toEqual(["ref_paper_261023_clairic_extraction.md"]);
    // Other languages: French, German, Japanese, Korean common words are common too.
    expect(["bonjour", "toujours", "zusammen", "straße"].map(isDictionaryWord)).toEqual([true, true, true, true]);
    expect(["ありがとう", "大丈夫", "勉強", "사람"].map(isCommonCjk)).toEqual([true, true, true, true]);
    writeFileSync(join(dir, "n_fr.md"), "## Notes Zusammen\n\n- 他說 Bonjour 就走了，隔天又說 Bonjour。\n");
    writeFileSync(join(dir, "n_ja.md"), "## 大丈夫な理由\n\n- 勉強會的筆記。\n");
    expect(hinter.lookup("bonjour zusammen 大丈夫 勉強")).toEqual([]);
  });

  test("held-out notes and messages: no false hit, every name found", () => {
    const root = mkdtempSync(join(tmpdir(), "uq-recall-holdout-"));
    const store = new StateStore(join(root, "state.db"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }), () => store.close());
    writeHoldoutFixture(root);
    const hinter = new RecallHinter(new MemoryStore(root, store));
    expect(HOLDOUT_GENERIC.filter((m) => hinter.lookup(m).length)).toEqual([]);
    for (const [m, path] of HOLDOUT_NAMED) expect(hinter.lookup(m).map((h) => h.path)).toEqual([path]);
  });

  test("name signal: the share of prose uses written like a name, over all of memory", () => {
    const { dir, hinter } = setup({ maxDf: 6 });
    // Everyday words: sentence-initial capitals, NO_REPLY, paths and code spans don't count; lower-case prose does.
    writeFileSync(join(dir, "n1.md"), "- 10:00 Message from the operator: the reply was late.\n- 11:00 Cleaned /tmp/x and `tmp`; the message queue is fine.\n");
    writeFileSync(join(dir, "n2.md"), "- 10:00 The NO_REPLY turn left a message behind.\n- Request: check the history.\n- History was kept; the request went through.\n");
    // Names: capitalised wherever they appear (one lower-case use is fine), mixed case, all caps, letters with digits.
    writeFileSync(join(dir, "n3.md"), "- 10:00 Read about Zorblax today; zorblax has two stages.\n- Ported it to GitQuarry; the ABCD codec and the E2B eval.\n- Asked Zorblax people.\n");
    writeFileSync(join(dir, "n4.md"), "# Kestrel\n\n- Kestrel is the budget app.\n");
    expect(hinter.lookup("message reply tmp request history check")).toEqual([]);
    expect(hinter.lookup("zorblax gitquarry abcd e2b").flatMap((h) => h.tokens).sort()).toEqual(["abcd", "e2b", "gitquarry", "zorblax"]);
    // Only sentence-initial or in a heading: no prose use tells, so the heading decides.
    expect(hinter.lookup("kestrel").map((h) => h.path)).toEqual(["n4.md"]);
    // 收到 is rare here but only in body text: CJK needs the target file's heading, path or front matter.
    writeFileSync(join(dir, "n5.md"), "- 收到了新的硬碟。\n");
    expect(hinter.lookup("收到")).toEqual([]);
    expect(NAME_SHARE).toBe(0.5);
  });

  test("a word in most files is no hit; a word not in memory is no hit; MEMORY.md is not a target and its words are skipped", () => {
    const { dir, hinter } = setup();
    expect(hinter.lookup("uniqlaw 使用者")).toEqual([]);
    expect(hinter.lookup("zebracorn quokkafish")).toEqual([]);
    writeFileSync(join(dir, "MEMORY.md"), "# Memory\n\n- only-here word: Florbinate\n");
    expect(hinter.lookup("florbinate")).toEqual([]);
    expect(hinter.lookup("clairic")).toHaveLength(1);
    writeFileSync(join(dir, "MEMORY.md"), "# Memory\n\n- Clairic: see ref_paper_261023_clairic_extraction.md\n");
    utimesSync(join(dir, "MEMORY.md"), new Date(), new Date(Date.now() + 5000));
    expect(hinter.lookup("clairic")).toEqual([]);
  });

  test("the rarity threshold scales with the number of files (max(maxDf, ratio × files))", () => {
    const { hinter } = setup({ maxDf: 2, maxDfRatio: 0 });
    expect(hinter.lookup("clairic")).toEqual([]); // in 3 files > 2
    const h2 = setup({ maxDf: 1, maxDfRatio: 0.1 }).hinter; // 30 files × 0.1 = 3
    expect(h2.lookup("clairic").map((h) => h.path)).toEqual(["ref_paper_261023_clairic_extraction.md"]);
  });

  test("CJK: the best file's heading or path must name it; a name only in note bodies is not found", () => {
    const { dir, hinter } = setup();
    writeFileSync(join(dir, "topics", "people_lin.md"), "# 林志遠\n\n- 林志遠負責語音轉寫服務的部署，常和王大明一起。\n");
    // "做法" is rare in this memory but only in body text: no name signal, no hit.
    expect(hinter.lookup("clairic 的做法")).toEqual([{ path: "ref_paper_261023_clairic_extraction.md", df: 3, spread: 3, tokens: ["clairic"] }]);
    expect(hinter.lookup("林志遠 下週會來嗎")).toEqual([{ path: "topics/people_lin.md", df: 1, spread: 1, tokens: ["林志遠"] }]);
    expect(hinter.lookup("明天跟林志遠約了")).toEqual([{ path: "topics/people_lin.md", df: 1, spread: 1, tokens: ["林志遠"] }]);
    expect(hinter.lookup("那個語音轉寫服務還在跑嗎")).toEqual([]);
    // A heading run that merely contains the token (a phrase, not a name) is no signal: the token must be at least
    // half of the run. 話說 in 「用自己的話換句話說」 no; 林志遠 in 「林志遠」 and 克立淨 in 「克立淨空清機」 yes.
    writeFileSync(join(dir, "topics", "ref_lecture_forgetting.md"), "# Post-training\n\n### (3) Paraphrase（用自己的話換句話說）\n\n- 話說回來，這招有用。\n");
    expect(hinter.lookup("話說 clairic 發佈了")).toEqual([{ path: "ref_paper_261023_clairic_extraction.md", df: 3, spread: 3, tokens: ["clairic"] }]);
    writeFileSync(join(dir, "topics", "proj_air.md"), "# 克立淨空清機 逆向\n\n- 克立淨的空清機連線不穩。\n");
    expect(hinter.lookup("克立淨的空清機又連不上了")).toEqual([{ path: "topics/proj_air.md", df: 1, spread: 1, tokens: ["克立淨", "空清機"] }]);
    // Only in body text (no heading, no path): without case or a dictionary it looks like any rare pair of words.
    expect(hinter.lookup("王大明 來了嗎")).toEqual([]);
    expect(hinter.lookup("明天跟王大明約了")).toEqual([]);
  });

  test("pointed out only after commit(): an uncommitted hint (failed steer) is offered again", () => {
    const { hinter } = setup();
    expect(hinter.hint("tg:1", human, "clairic?")).toBeDefined();
    expect(hinter.hint("tg:1", human, "clairic?")).toBeDefined();
    hinter.hint("tg:1", human, "clairic?")!.commit();
    expect(hinter.hint("tg:1", human, "clairic?")).toBeUndefined();
  });

  test("a voice transcript's label is not the human's words", () => {
    const { dir, hinter } = setup();
    writeFileSync(join(dir, "topics", "voice.md"), "# Voice\n\n- The Voice Transcript Ogg pipeline.\n");
    expect(hinter.lookup("[Voice message transcript (voice.ogg): 幫我看一下明天的行程]".replace(/\[(?:Voice message|Audio) transcript(?: \([^)]*\))?: /g, " "))).toEqual([]);
    expect(show(hinter, "tg:1", human, "[Voice message transcript (voice.ogg): 幫我看一下明天的行程]")).toBeUndefined();
  });

  test("not repeated in the same session; other sessions, forget() and the TTL bring it back", () => {
    const { hinter, advance } = setup();
    expect(show(hinter, "tg:1", human, CLAIRIC_MSG)).toBeDefined();
    expect(show(hinter, "tg:1", human, "clairic 的結果呢")).toBeUndefined();
    expect(show(hinter, "tg:2", human, "clairic 的結果呢")).toBeDefined();
    hinter.forget("tg:1");
    expect(show(hinter, "tg:1", human, "clairic?")).toBeDefined();
    advance(239 * 60_000);
    expect(show(hinter, "tg:1", human, "clairic?")).toBeUndefined();
    advance(60_000);
    expect(show(hinter, "tg:1", human, "clairic?")).toBeDefined();
  });

  test("cron and agent messages get no hint by default; `sources` opts them in; disabled = nothing", () => {
    expect(show(setup().hinter, "tg:1", cron, CLAIRIC_MSG)).toBeUndefined();
    expect(show(setup().hinter, "tg:1", peer, CLAIRIC_MSG)).toBeUndefined();
    expect(show(setup({ sources: ["human", "scheduler"] }).hinter, "cron:daily", cron, CLAIRIC_MSG)).toBeDefined();
    expect(show(setup({ enabled: false }).hinter, "tg:1", human, CLAIRIC_MSG)).toBeUndefined();
  });

  test("the index picks up a new file, a changed file and a deleted one", () => {
    const { dir, hinter } = setup();
    expect(hinter.lookup("zephyrine")).toEqual([]);
    writeFileSync(join(dir, "proj_zephyrine.md"), "# Zephyrine\n\n- Zephyrine is the new backup box.\n");
    expect(hinter.lookup("zephyrine").map((h) => h.path)).toEqual(["proj_zephyrine.md"]);
    writeFileSync(join(dir, "proj_zephyrine.md"), "# Box\n\n- renamed to Quillhaven.\n");
    utimesSync(join(dir, "proj_zephyrine.md"), new Date(), new Date(Date.now() + 5000));
    expect(hinter.lookup("zephyrine")).toEqual([]);
    expect(hinter.lookup("quillhaven").map((h) => h.path)).toEqual(["proj_zephyrine.md"]);
    unlinkSync(join(dir, "proj_zephyrine.md"));
    expect(hinter.lookup("quillhaven")).toEqual([]);
  });

  test("at most maxHits lines, rarest first", () => {
    const { dir, hinter } = setup({ maxHits: 2 });
    writeFileSync(join(dir, "a.md"), "- see Alphaword and Betaword\n");
    writeFileSync(join(dir, "b.md"), "- see Betaword and Gammaword\n");
    writeFileSync(join(dir, "c.md"), "- see Gammaword\n");
    writeFileSync(join(dir, "d.md"), "- see Gammaword and Deltaword\n");
    const block = show(hinter, "tg:1", human, "gammaword betaword alphaword deltaword")!;
    expect(block.split("\n").slice(1)).toEqual(["- alphaword, betaword → memory/a.md (+1 more file)", "- deltaword → memory/d.md"]);
  });
});

describe("in a turn", () => {
  test("a chat message gets the block before Message:, once per session; a cron turn and a session without memory_search get none", async () => {
    const root = mkdtempSync(join(tmpdir(), "uq-recall-mgr-"));
    const store = new StateStore(join(root, "state.db"));
    writeRecallFixture(root);
    const hinter = new RecallHinter(new MemoryStore(root, store));
    const settings = parseSettings({ profiles: { main: { provider: "fake" } }, queue: { debounceMs: 0 }, timezone: "UTC" });
    const seen: string[] = [];
    const provider = new FakeProvider((input, s) => { seen.push(input.text); s.emit({ type: "turn_end", turnId: s.turnId(), reason: "done" }); });
    const profile: Profile = { name: "main", provider: "fake", permissions: settings.profiles.main!.permissions, options: {} };
    const mgr = new ChannelManager({ log: silentLogger, settings, store, projectDir: root, instanceId: "t", providers: new Map([["fake", provider]]),
      platforms: new Map([["tg", new FakePlatform()]]), profiles: new Map([["main", profile]]),
      gatewayFor: (k) => ({ url: "http://x", token: "t", toolNames: k === "tg:9" ? ["notify"] : ["memory_search", "memory_get"] }),
      systemPrompt: async () => ({ fragments: [] }), providerEnv: async () => ({}),
      recall: { hint: (k, o, t) => hinter.hint(k, o, t), forget: (k) => hinter.forget(k) } });
    cleanups.push(() => rmSync(root, { recursive: true, force: true }), () => store.close(), () => mgr.stop());
    const msg = (key: string, text: string): InboundMessage => ({ platform: "tg", channelKey: key, replyTarget: { platform: "tg", chatId: key.slice(3) },
      ref: { platform: "tg", chatId: key.slice(3), messageId: String(seen.length) }, sender: { id: "1", name: "Hans" }, trusted: true, multiparty: false,
      text, attachments: [], receivedAt: Date.now() });
    const next = async (n: number) => { for (let i = 0; i < 400 && seen.length < n; i++) await Bun.sleep(5); expect(seen.length).toBe(n); return seen[n - 1]!; };

    await mgr.handleInbound(msg("tg:1", CLAIRIC_MSG));
    expect(await next(1)).toContain(`[Tg from Hans (1)]\n${RECALL_HINT_HEADER}\n- clairic → memory/ref_paper_261023_clairic_extraction.md (+2 more files)\nMessage: 話說 clairic`);
    await mgr.handleInbound(msg("tg:1", "clairic 還有什麼？"));
    expect(await next(2)).not.toContain("Memory recall hint");
    await mgr.handleInbound(msg("tg:1", "今天天氣如何，幫我看一下"));
    expect(await next(3)).not.toContain("Memory recall hint");
    await mgr.fireScheduled({ channelKey: "cron:x", job: "x", text: CLAIRIC_MSG, sourceLine: "[x]", raw: true });
    expect(await next(4)).not.toContain("Memory recall hint");
    await mgr.handleInbound(msg("tg:9", CLAIRIC_MSG));
    expect(await next(5)).not.toContain("Memory recall hint");
    // /new forgets what was pointed out in that session.
    await mgr.handleInbound(msg("tg:1", "/new"));
    await mgr.handleInbound(msg("tg:1", "clairic again"));
    expect(await next(6)).toContain("- clairic → memory/ref_paper_261023_clairic_extraction.md");
  });
});

test("a message steered into a running turn gets its hint; a failed steer leaves it for the queued turn", async () => {
  const root = mkdtempSync(join(tmpdir(), "uq-recall-steer-"));
  const store = new StateStore(join(root, "state.db"));
  writeRecallFixture(root);
  const hinter = new RecallHinter(new MemoryStore(root, store));
  const settings = parseSettings({ profiles: { main: { provider: "fake" } }, queue: { debounceMs: 0, mode: "steer" }, timezone: "UTC" });
  const sent: string[] = [];
  let finish!: () => void;
  const provider = new FakeProvider((input, s) => {
    sent.push(input.text);
    finish = () => s.emit({ type: "turn_end", turnId: s.turnId(), reason: "done" });
  });
  const profile: Profile = { name: "main", provider: "fake", permissions: settings.profiles.main!.permissions, options: {} };
  const mgr = new ChannelManager({ log: silentLogger, settings, store, projectDir: root, instanceId: "t", providers: new Map([["fake", provider]]),
    platforms: new Map([["tg", new FakePlatform()]]), profiles: new Map([["main", profile]]),
    gatewayFor: () => ({ url: "http://x", token: "t", toolNames: ["memory_search"] }), systemPrompt: async () => ({ fragments: [] }), providerEnv: async () => ({}),
    recall: { hint: (k, o, t) => hinter.hint(k, o, t), forget: (k) => hinter.forget(k) } });
  cleanups.push(() => rmSync(root, { recursive: true, force: true }), () => store.close(), () => mgr.stop());
  let n = 0;
  const msg = (text: string): InboundMessage => ({ platform: "tg", channelKey: "tg:1", replyTarget: { platform: "tg", chatId: "1" },
    ref: { platform: "tg", chatId: "1", messageId: String(++n) }, sender: { id: "1", name: "Hans" }, trusted: true, multiparty: false, text, attachments: [], receivedAt: Date.now() });
  const wait = async (f: () => boolean) => { for (let i = 0; i < 400 && !f(); i++) await Bun.sleep(5); expect(f()).toBe(true); };

  await mgr.handleInbound(msg("hello"));
  await wait(() => sent.length === 1);
  const session = provider.sessions.get("tg:1")!;
  await mgr.handleInbound(msg("btw clairic?"));
  await wait(() => session.steered.length === 1);
  expect(session.steered[0]!.text).toContain("- clairic → memory/ref_paper_261023_clairic_extraction.md");

  // Steer fails → the input is queued and the next turn carries the hint (it was not marked as shown).
  writeFileSync(join(root, "memory", "proj_zephyrine.md"), "# Box\n\n- the backup box is called Zephyrine.\n");
  session.steer = async () => { throw new Error("no steer now"); };
  await mgr.handleInbound(msg("and zephyrine?"));
  finish();
  await wait(() => sent.length === 2);
  expect(sent[1]).toContain("- zephyrine → memory/proj_zephyrine.md");
});
