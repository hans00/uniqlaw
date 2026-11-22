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
  // MEMORY.md is in the prompt already: never a hint target, even though it names Clairic.
  writeFileSync(join(dir, "MEMORY.md"), "# Memory\n\n- 使用者 likes short answers. Clairic paper notes: see ref_paper_261023_clairic_extraction.md\n");
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
