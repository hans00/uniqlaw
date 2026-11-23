// Synthetic memory directory for recall-hint tests: 30 files of everyday Chinese / English work-chat notes
// (written for these tests, not copied from a real memory), sharing vocabulary with the generic test messages.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SENTENCES = [
  "今天幫使用者看了一下部署的問題，原因是設定檔少了一個欄位。",
  "下午討論了模型的選擇，最後決定先用比較便宜的版本試試看。",
  "使用者說天氣很熱，不想出門，所以會議改成線上。",
  "整理了一下這週的進度：重構完成一半，測試還沒補。",
  "晚上幫忙檢查日誌，發現排程任務在凌晨失敗了兩次。",
  "使用者問如何設定提醒，我建議用排程工具每天早上通知。",
  "把文件的格式統一了，標題和清單都改成一樣的寫法。",
  "看了一下錯誤訊息，是網路逾時造成的，重試之後就好了。",
  "討論要不要換一個資料庫，目前的效能還可以，先不動。",
  "今天天氣不錯，使用者去散步，回來之後繼續寫程式。",
  "幫使用者整理會議記錄，重點是下週要交第一版。",
  "測試全部通過，可以合併到主分支了。",
  "使用者提到最近很忙，希望回覆可以簡短一點。",
  "這個功能先做最簡單的版本，之後再看需不需要擴充。",
  "檢查了權限設定，發現有一個目錄不應該開放寫入。",
  "修好一個小問題：時間格式在不同時區下顯示錯誤。",
  "使用者想知道怎麼備份資料，我寫了一個簡單的步驟說明。",
  "晚餐前幫忙看了一下報價，價格比上個月高了一點。",
  "今天主要在看文件，順便把過時的說明刪掉。",
  "討論了一下記憶的設計，決定每天寫一份筆記。",
  "Deployed the new build and checked the logs; nothing unusual.",
  "The user asked for a summary of the meeting, sent it in the chat.",
  "Fixed a typo in the settings documentation and ran the tests again.",
  "Looked at the error report: a timeout while calling the API, retried fine.",
];

/** One-off notes (each in exactly one file): the long tail of a real memory, reusing the generic messages' words
 *  in other combinations, which is where n-gram schemes produce false hits. */
const TAIL = [
  "今天的天氣有點冷，使用者感冒了。", "幫我把錯誤整理成表格，這是使用者的要求。", "格式有點亂，之後再統一。", "那份文件要重寫，時間不太夠。",
  "會議改到下週，記錄先放著。", "測試沒過，先不要合併。", "設定檔被改壞了，從備份還原。", "日誌太多，晚上再看。",
  "第一版的範圍縮小了一點。", "資料庫備份每天凌晨跑一次。", "回覆太長，使用者說簡短就好。", "部署之後記得通知大家。",
  "明天早上要開會，提醒已經設好。", "訊息的意思不清楚，問了使用者才知道。", "進度落後一天，週末補上。", "重點是先讓它能動。",
  "錯誤訊息裡有一個奇怪的路徑。", "天氣預報說週末會下雨。", "幫忙看一下帳單，金額沒問題。", "整理完照片，順便清掉重複的。",
  "簡單的步驟寫在說明裡了。", "怎麼改比較好還在討論。", "列出來的清單太長，刪掉一半。", "今天幫我看了三個問題。",
  "檢查一下權限，結果都正常。", "時間夠的話再加測試。", "第一次用這個工具，有點不習慣。", "效能最近還好，沒有變慢。",
  "九點開會改成十點。", "合併之前要先跑一次測試。",
];
/** More one-offs, appended to some files: short chat words, English notes, links. */
const TAIL2 = [
  "使用者回了「好的，謝謝」，事情就結束了。", "收到通知之後重新部署。", "沒問題的部分先跳過。", "對了，下次記得先備份。",
  "Ordered a new keyboard; it arrives on Friday.", "The backup script now uses rsync over ssh.", "Weekly sync moved to Thursday afternoon.",
  "Model list: https://huggingface.co/models — check before choosing.", "Repo: https://github.com/example/uniqlaw-notes for the drafts.",
  "Read the release notes of the new version, nothing urgent.", "Asked whether the invoice was paid; it was.", "辛苦了，今天先到這裡。",
];

/** Deterministic pick of `k` distinct sentences for file `i` (mulberry32). */
function pick(i: number, k: number): string[] {
  let a = (i + 1) * 0x9e3779b9;
  const rnd = () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const pool = [...SENTENCES];
  const out: string[] = [];
  for (let j = 0; j < k && pool.length; j++) out.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0]!);
  return out;
}

/** Writes `<root>/memory/…` (30 files + MEMORY.md) and returns the memory dir. "Clairic" is in 3 files; the
 *  words "uniqlaw" and "使用者" are in every file. */
export function writeRecallFixture(root: string): string {
  const dir = join(root, "memory");
  mkdirSync(join(dir, "topics"), { recursive: true });
  // 22 daily notes
  for (let i = 0; i < 22; i++) {
    const day = `2026-10-${String(i + 1).padStart(2, "0")}`;
    const extra = i === 4 ? ["- 10:12 看了 Clairic 的論文摘要，晚點再細讀。 <!-- m:aa11 -->"] : [];
    writeFileSync(join(dir, `${day}.md`), [`# ${day}`, "", ...[...pick(i, 6), TAIL[i]!, ...(i < TAIL2.length ? [TAIL2[i]!] : [])].map((s, j) => `- ${String(9 + j).padStart(2, "0")}:00 ${s} uniqlaw <!-- m:${i}x${j} -->`), ...extra, ""].join("\n"));
  }
  // 7 topic files + the paper note
  const topics = ["user_preferences", "project_uniqlaw", "ops_backup", "ref_models", "people_team", "ref_tools", "ideas"];
  topics.forEach((t, i) => {
    const extra = t === "ref_models" ? ["- 另外 Clairic 也有一版小模型，可以和其他模型比較。"] : [];
    writeFileSync(join(dir, "topics", `${t}.md`), [`# ${t}`, "", ...[...pick(100 + i, 8), TAIL[22 + i]!].map((s) => `- ${s} (uniqlaw)`), ...extra, ""].join("\n"));
  });
  writeFileSync(join(dir, "ref_paper_261023_clairic_extraction.md"), [
    "# Clairic: document extraction paper (2026-10-23)",
    "",
    "- Clairic 是一個文件抽取模型，使用者想參考它的做法。",
    "- Clairic 的訓練資料以掃描文件為主；uniqlaw 這邊可以借用它的評估方式。",
    "- 重點：clairic extraction pipeline 分成版面分析和欄位抽取兩段。",
    "- Model card: https://huggingface.co/Cloudflare/clairic",
    "",
  ].join("\n"));
  // MEMORY.md is in the prompt already: never a hint target, and its words are never pointed out.
  writeFileSync(join(dir, "MEMORY.md"), "# Memory\n\n- 使用者 likes short answers. Backups: see topics/ops_backup.md\n");
  return dir;
}

/** Everyday messages that should not produce a hint (they share vocabulary with the notes above). */
export const GENERIC_MESSAGES = [
  "今天天氣如何，幫我看一下",
  "幫我看一下這個錯誤訊息是什麼意思",
  "可以幫我整理一下今天的進度嗎",
  "會議記錄寫好了沒？重點幫我列出來",
  "測試有通過嗎？可以合併了嗎",
  "這個設定檔要怎麼改比較好",
  "晚上有空幫我檢查一下日誌",
  "下週要交第一版，時間夠嗎",
  "資料庫效能最近還好嗎",
  "幫我寫一個簡單的備份步驟",
  "最近很忙，回覆簡短一點就好",
  "部署完成之後通知我一聲",
  "Can you check the logs and tell me if the deploy worked?",
  "Please summarize the meeting for me",
  "提醒我明天早上九點開會",
  "文件的格式要統一嗎？",
  "好的，謝謝",
  "對了，晚點再說",
  "收到",
  "沒問題，就這樣",
  "辛苦了！",
  "看一下這個 https://github.com/someone/project",
  "Thanks, that works. Anything else on the backup?",
  "[Voice message transcript (voice.ogg): 幫我看一下明天的行程]",
];

/** Held-out set: notes and messages written after the rules were tuned on the set above, then run once.
 *  Result: 0 of 20 false hits, 4 of 5 names. The fifth, a name inside a longer CJK run, led to the heading/path
 *  signal for lone trigrams. Topic files name three subjects; daily notes are about everyday life. */
export function writeHoldoutFixture(root: string): string {
  const dir = join(root, "memory");
  mkdirSync(join(dir, "topics"), { recursive: true });
  const notes = [
    "使用者今天在整理書櫃，順便問了幾本書的心得。", "幫忙比較兩款耳機，最後選了降噪比較好的那款。", "晚上討論旅行計畫，可能十二月去日本。",
    "修改了排程的時間，改成每週一早上提醒。", "使用者想學做菜，先從簡單的炒飯開始。", "看了一篇關於睡眠的文章，建議固定時間起床。",
    "家裡的網路又斷了，重開路由器之後恢復。", "整理了信用卡帳單，這個月花比較多在交通。", "使用者說最近在跑步，每週三次。",
    "討論了要不要換手機，結論是再等半年。", "Renewed the domain for another year.", "The NAS ran out of space; deleted old snapshots.",
    "Booked a dentist appointment for next Tuesday.", "Tried a new coffee shop near the station, decent espresso.", "使用者生日快到了，提醒要訂蛋糕。",
    "今天下雨，取消了原本的戶外行程。", "幫忙寫了一封請假的信。", "把相簿備份到外接硬碟。", "使用者問了一些稅務的問題，建議找會計師。", "週末打掃了房間，丟掉很多舊衣服。",
  ];
  notes.forEach((n, i) => {
    const day = `2026-09-${String(i + 1).padStart(2, "0")}`;
    writeFileSync(join(dir, `${day}.md`), `# ${day}\n\n- 10:00 ${n}\n- 11:00 ${notes[(i * 7 + 3) % notes.length]}\n`);
  });
  writeFileSync(join(dir, "topics", "proj_kestrel.md"), "# Kestrel\n\n- Kestrel 是使用者的個人記帳專案，用 SQLite。\n- 下一步想加上圖表。\n");
  writeFileSync(join(dir, "topics", "people_陳柏宇.md"), "# 陳柏宇\n\n- 使用者的大學同學，在做硬體設計。\n");
  writeFileSync(join(dir, "topics", "ref_orvane.md"), "# Orvane router notes\n\n- The Orvane AX3 needs a firmware update every few months.\n");
  return dir;
}

export const HOLDOUT_GENERIC = ["最近有什麼好看的書嗎", "幫我查一下明天會不會下雨", "我想訂一間餐廳", "晚上要吃什麼好", "提醒我週五繳電話費", "網路好慢，怎麼辦",
  "幫我寫一封感謝信", "這個月的花費多嗎", "我今天跑了五公里", "推薦一款耳機", "Did the backup finish?", "Remind me to call mom tonight",
  "What should I cook for dinner?", "好累，想睡覺", "週末要去哪裡玩", "幫我算一下這筆帳", "相簿的照片有備份嗎", "我的手機電池壞了", "收到，謝謝你", "ok 沒問題"];
export const HOLDOUT_NAMED: [string, string][] = [
  ["kestrel 的圖表做了嗎", "topics/proj_kestrel.md"], ["陳柏宇 最近怎樣", "topics/people_陳柏宇.md"], ["orvane 要更新韌體了嗎", "topics/ref_orvane.md"],
  ["the Orvane router is acting up again", "topics/ref_orvane.md"], ["跟陳柏宇約了吃飯", "topics/people_陳柏宇.md"],
];

/** The shapes behind the false hits seen on a real memory (304 files, mostly English daily notes): everyday words
 *  rare enough to pass the df test (each in ≤ 3 of 40 files) written sentence-initially ("Message from …"), in
 *  NO_REPLY, in /tmp/ and Projects paths, in code spans; a 2-character CJK word (話說) and a 4-character phrase
 *  (專有名詞) only in note bodies. Names: Clairic (one lower-case use), SNAC (most often in a lecture note, named in
 *  the codec project's front matter), 克立淨 / 空清機 (in a project heading). Written for these tests. */
export function writeRealShapeFixture(root: string): string {
  const dir = join(root, "memory");
  mkdirSync(dir, { recursive: true });
  const filler = ["Checked the daemon logs, nothing unusual.", "Ran the test suite; all green.", "Updated the settings docs.", "使用者今天比較忙，回覆簡短。",
    "Looked at the queue debounce again.", "Reviewed the worker roots.", "整理了一下排程。", "Wrote the weekly summary."];
  const rare = [
    "Message from the operator: the cron job ran twice.", "Request timed out; retried it.", "History of the session was handed over.",
    "The tool-status bubble stayed after a NO_REPLY turn.", "Cleaned /tmp/claude-1000/-home-hans-Projects/ worker dirs.", "Ran `tmp` cleanup and checked `message_id`.",
    "話說回來，這個設定之前討論過。", "討論了專有名詞要不要翻譯。", "the reply went to the wrong chat.", "Read the request log and the history file.",
    "Each message edits one bubble now.", "Moved ~/Projects/old to the archive.",
  ];
  for (let i = 0; i < 40; i++) {
    const day = `2026-08-${String(1 + (i % 28)).padStart(2, "0")}${i >= 28 ? `-${i}` : ""}`;
    const body = [filler[i % filler.length]!, filler[(i + 3) % filler.length]!, ...(i < 36 ? [rare[i % rare.length]!] : [])];
    if (i === 7) body.push("Read the Clairic paper; the clairic pipeline has two stages.");
    if (i === 9) body.push("Compared Clairic and SNAC tokens for the speech model.");
    writeFileSync(join(dir, `${day}.md`), [`# ${day}`, "", ...body.map((l, j) => `- ${10 + j}:00 ${l}`), ""].join("\n"));
  }
  writeFileSync(join(dir, "ref_paper_261023_clairic_extraction.md"), "# Clairic extraction paper\n\n- The paper behind Clairic splits layout analysis and field extraction.\n- Model card: https://huggingface.co/Cloudflare/clairic\n");
  writeFileSync(join(dir, "ref_lecture_L12_speech_lm.md"), "# Lecture 12: speech LMs\n\n- Codec tokens such as SNAC, EnCodec and Mimi.\n- SNAC uses three scales; SNAC tokens are interleaved.\n");
  writeFileSync(join(dir, "project_codec_cpp.md"), "---\nname: codec.cpp\ndescription: C++ port of neural audio codecs (SNAC first)\n---\n\n# codec.cpp\n\n- Started with the decoder.\n");
  writeFileSync(join(dir, "project_ecover_cleanstation_re.md"), "# 克立淨空清機 (ecover cleanstation) 逆向\n\n- 克立淨的空清機用雲端 API，連線不穩。\n");
  writeFileSync(join(dir, "MEMORY.md"), "# Memory\n\n- Operator prefers short answers. Workers: Codex and Gemini profiles.\n");
  return dir;
}

/** The 20 real operator messages the real-memory run used, with the hit (file) each should give. */
export const REAL_MESSAGES: [string, string[]][] = [
  ["話說 clairic 發佈了，請看一下他們是怎麼做的 https://huggingface.co/Cloudflare/clairic", ["ref_paper_261023_clairic_extraction.md"]],
  ["手機解鎖了", []], ["直接開工修正... 這還需要問？", []], ["Google 新出了 Neon，看看能不能再補上", []], ["怎麼突然都說英文了", []], ["Hydrogen 有的話也加", []],
  ["話說你應該有幾個 worker 的暫存目錄在 /tmp/claude-1000/-home-hans-Projects/ ，可以刪除嗎？", []], ["為什麼跳了一大堆權限確認又取消掉？", []],
  ["看起來應該是系統對於「Claude Code will automatically block this request in XX:XX」的偵測問題", []],
  ["對了，目前 Discord channel 上有發現一些問題 1. 執行指令之類的非最終訊息會大量洗頻 2. 最終沒有發出訊息的 cron 或 \"NO_REPLY\" 會導致前面發的 tool call history message 殘留", []],
  ["是說，妳要反省一下如何避免以後又出現記憶搜尋的問題", []],
  ["我這次並沒有說是「新發布」誒 然後妳長期工作下來 Clairic 本來就只是小小的一件事情，不值得永久在長期記憶", ["ref_paper_261023_clairic_extraction.md"]],
  ["如何定義「專有名詞」，實際上新名稱永遠做不完", []], ["可以", []], ["Jevling 的 E2B 那邊 eval 跑完了嗎", []], ["BRICKS 的 ctor-bench 資安題再跑一次", []],
  ["小金老師今天的影片看了嗎", []], ["克立淨的空清機又連不上了", ["project_ecover_cleanstation_re.md"]],
  ["codec.cpp 的 SNAC 支援做到哪", ["project_codec_cpp.md"]], ["火箭那個 PoC 的顫振還沒做吧", []],
];

/** The shapes behind two production false hits (2026-11-23) in a mostly-Chinese memory: dictionary words that
 *  English prose capitalises (a lab's name "Airun Intelligence Labs", title case "Contribution guide", "Activity
 *  Overview", an "## Overview" heading) and a GitHub org in a URL path (vercel-labs) whose part "Vercel" is
 *  capitalised in a note. Each word is in ≤ 3 files, so it passes the rarity test. Written for these tests. */
export function writePrecisionFixture(root: string): string {
  const dir = join(root, "memory");
  mkdirSync(dir, { recursive: true });
  const filler = ["今天整理了排程，沒有異常。", "使用者問了天氣，回覆簡短。", "跑了一次測試，全部通過。", "幫忙改了一段文件。", "討論了下週的行程。",
    "檢查了 daemon 的日誌。", "看了一下佇列的設定。", "寫了每週摘要。"];
  for (let i = 0; i < 36; i++) {
    const day = `2026-10-${String(1 + (i % 28)).padStart(2, "0")}${i >= 28 ? `-${i}` : ""}`;
    writeFileSync(join(dir, `${day}.md`), `# ${day}\n\n- 10:00 ${filler[i % filler.length]}\n- 11:00 ${filler[(i + 3) % filler.length]}\n`);
  }
  writeFileSync(join(dir, "project_bricks_evidence_plane.md"), "---\nname: bricks evidence plane\ndescription: 證據平面的設計與部署\n---\n\n# Evidence plane\n\n- 預覽環境放在 Vercel 上，正式環境另外部署。\n- 下一步：補上權限檢查。\n");
  writeFileSync(join(dir, "ref_paper_261102_glance_generator_reranker.md"), "# Glance: generator + reranker\n\n- 作者來自 Airun Intelligence Labs，方法是先生成再重排。\n- 實驗用了三個資料集。\n");
  writeFileSync(join(dir, "feedback_bricks_oss_practices.md"), "# 開源專案的做法\n\n- 發 PR 前先讀對方的 Contribution guide，照格式寫描述。\n- 不要一次改太多檔案。\n");
  writeFileSync(join(dir, "ref_stanford_cs329a_self_improving_agents.md"), "# CS329A self-improving agents\n\n## Overview\n\n- 課程的 Activity Overview 頁面列了每週主題。\n- 期末專題要做 agent 的自我改進。\n");
  writeFileSync(join(dir, "ref_course_notes.md"), "# 課程筆記\n\n## Overview\n\n- 這門課的 Overview 寫得很清楚。\n");
  // Names that must keep working: not dictionary words, capitalised in prose; one only in a URL path elsewhere.
  writeFileSync(join(dir, "ref_clairic.md"), "# Clairic\n\n- Clairic 把版面分析和欄位擷取分開。\n- 模型卡：https://huggingface.co/Cloudflare/clairic\n");
  writeFileSync(join(dir, "project_codec_cpp.md"), "---\nname: codec.cpp\ndescription: C++ port of neural audio codecs (SNAC first)\n---\n\n# codec.cpp\n\n- 先做 SNAC 的 decoder，之後是 Mimi。\n");
  writeFileSync(join(dir, "ops_cloudflare_tunnel.md"), "# 對外連線\n\n- 用 Cloudflare Tunnel 把 webhook 接出去。\n");
  // A product named with a dictionary word: its front matter names it, so it still points.
  writeFileSync(join(dir, "project_ember.md"), "---\nname: Ember\ndescription: 個人記帳 app\n---\n\n# Ember\n\n- Ember 用 SQLite，下一步加圖表。\n");
  writeFileSync(join(dir, "MEMORY.md"), "# Memory\n\n- 使用者偏好簡短回答。\n");
  return dir;
}

/** The two production messages (false lines: vercel, labs; contribution, overview) and named controls. */
export const PRECISION_MESSAGES: [string, string[]][] = [
  ["https://github.com/vercel-labs/skills/pull/2470 之前我對 skills 套件發的 PR 被拒絕了，他們要求要支援通用的 skills 路徑。幫我轉成 mybigday-bricks 內部的 issue — 支援通用 skills 路徑", []],
  ["下面有 Activity overview 跟 Contribution activity ，雖然沒有展開的資料", []],
  ["clairic 的論文看完了嗎", ["ref_clairic.md"]],
  ["SNAC 的 decoder 做到哪", ["project_codec_cpp.md"]],
  ["cloudflare tunnel 又斷了", ["ops_cloudflare_tunnel.md"]],
  ["ember 的圖表做了嗎", ["project_ember.md"]],
];
