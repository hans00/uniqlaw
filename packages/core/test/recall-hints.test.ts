// Memory recall hints (docs §8.7): rare-in-memory words of a message get a one-line pointer to the memory file.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ChannelManager, DEFAULT_RECALL_HINTS, MemoryStore, RECALL_HINT_HEADER, RecallHinter, StateStore, messageTokens, parseSettings, silentLogger,
  type InboundMessage, type Origin, type Profile, type RecallHintOptions,
} from "../src/index.ts";
import { FakePlatform, FakeProvider } from "./fakes.ts";
import { GENERIC_MESSAGES, HOLDOUT_GENERIC, HOLDOUT_NAMED, writeHoldoutFixture, writeRecallFixture } from "./recall-fixture.ts";

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
  test("words lower-cased, split at URL and file-name punctuation, ≥ 3 chars, no pure numbers, no URL scheme/host; CJK 2/3-char runs whole, longer runs as trigrams", () => {
    const t = messageTokens("話說 Clairic v2 發佈了 https://huggingface.co/Cloudflare/clairic ref_paper_261023 林志遠").map((x) => x.token);
    expect(t).toEqual(["clairic", "cloudflare", "ref", "paper", "話說", "發佈了", "林志遠"]);
    expect(messageTokens("今天天氣如何").map((x) => x.token)).toEqual(["今天天", "天天氣", "天氣如", "氣如何"]);
  });
});

describe("recall hints", () => {
  test("regression: a name only in topic files → exactly one pointer, to the topic file", () => {
    const { hinter } = setup();
    const block = show(hinter, "tg:1", human, CLAIRIC_MSG);
    // "Clairic" is in 3 of 30 files (MEMORY.md, which names it too, is left out); the paper note wins over the
    // daily note and topics/ref_models.md by being a topic file with the most occurrences. "Cloudflare" (from the
    // URL path) is only in the paper note's model-card link: same file, same line. huggingface.co is a host: no token.
    expect(block).toBe(`${RECALL_HINT_HEADER}\n- cloudflare, clairic → memory/ref_paper_261023_clairic_extraction.md (+2 more files)`);
  });

  test("a generic message adds nothing at all", () => {
    const { hinter } = setup();
    expect(show(hinter, "tg:1", human, "今天天氣如何，幫我看一下")).toBeUndefined();
  });

  test("false hits on everyday messages stay rare: 1 of 24 (all-bigram CJK tokens without the name signal: 17)", () => {
    const { hinter } = setup();
    const hits = GENERIC_MESSAGES.filter((m) => hinter.lookup(m).length);
    // The one left is a verbatim 4-character phrase from a single note ("九點開會改成十點").
    expect(hits).toEqual(["提醒我明天早上九點開會"]);
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

  test("short words need a name signal: everyday English and chat words rare in memory are no hit", () => {
    const { dir, hinter } = setup();
    writeFileSync(join(dir, "topics", "ops_extra.md"), "# Extra\n\n- the deploy check was green.\n- 收到了新的硬碟。\n");
    expect(hinter.lookup("check 收到")).toEqual([]);
    writeFileSync(join(dir, "topics", "ops_extra.md"), "# Extra\n\n- ran `check` on the box.\n");
    utimesSync(join(dir, "topics", "ops_extra.md"), new Date(), new Date(Date.now() + 5000));
    expect(hinter.lookup("check").map((h) => h.path)).toEqual(["topics/ops_extra.md"]); // in backticks: a name
  });

  test("a word in most files is no hit; a word not in memory is no hit; MEMORY.md is not a target", () => {
    const { dir, hinter } = setup();
    expect(hinter.lookup("uniqlaw 使用者")).toEqual([]);
    expect(hinter.lookup("zebracorn quokkafish")).toEqual([]);
    writeFileSync(join(dir, "MEMORY.md"), "# Memory\n\n- only-here word: florbinate\n");
    expect(hinter.lookup("florbinate")).toEqual([]);
  });

  test("the rarity threshold scales with the number of files (max(maxDf, ratio × files))", () => {
    const { hinter } = setup({ maxDf: 2, maxDfRatio: 0 });
    expect(hinter.lookup("clairic")).toEqual([]); // in 3 files > 2
    const h2 = setup({ maxDf: 1, maxDfRatio: 0.1 }).hinter; // 30 files × 0.1 = 3
    expect(h2.lookup("clairic").map((h) => h.path)).toEqual(["ref_paper_261023_clairic_extraction.md"]);
  });

  test("several words of one file share a line; CJK: ≥ 4 matching characters, or a name in a heading/path", () => {
    const { dir, hinter } = setup();
    writeFileSync(join(dir, "topics", "people_lin.md"), "# 林志遠\n\n- 林志遠負責語音轉寫服務的部署，常和王大明一起。\n");
    // "做法" is rare in this memory but only in body text: no name signal, no hit.
    expect(hinter.lookup("clairic 的做法")).toEqual([{ path: "ref_paper_261023_clairic_extraction.md", df: 3, spread: 3, tokens: ["clairic"] }]);
    expect(hinter.lookup("林志遠 下週會來嗎")).toEqual([{ path: "topics/people_lin.md", df: 1, spread: 1, tokens: ["林志遠"] }]);
    expect(hinter.lookup("明天跟林志遠約了")).toEqual([{ path: "topics/people_lin.md", df: 1, spread: 1, tokens: ["林志遠"] }]);
    expect(hinter.lookup("那個語音轉寫服務還在跑嗎")).toEqual([{ path: "topics/people_lin.md", df: 1, spread: 1, tokens: ["語音轉寫服務"] }]);
    // A CJK name only in body text (no heading, no path) is not found: without a dictionary it looks like any rare pair.
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
    expect(await next(1)).toContain(`[Tg from Hans (1)]\n${RECALL_HINT_HEADER}\n- cloudflare, clairic → memory/ref_paper_261023_clairic_extraction.md (+2 more files)\nMessage: 話說 clairic`);
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
  session.steer = async () => { throw new Error("no steer now"); };
  await mgr.handleInbound(msg("and Kestrel? no: cloudflare"));
  finish();
  await wait(() => sent.length === 2);
  expect(sent[1]).toContain("- cloudflare → memory/ref_paper_261023_clairic_extraction.md");
});
