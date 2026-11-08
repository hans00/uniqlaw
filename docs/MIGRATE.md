# 從 ClaudeClaw v2 遷移到 UniQlaw（給 agent 的作業指南）

> 這份文件是寫給 **agent**（Claude Code、Codex…）照著做的，不是固定腳本。每個 v2 安裝都不太一樣（舊版留下的 key、手改過的檔案、v1 殘留），由 agent 讀實際檔案、對照下面的對應表、跟使用者確認後再寫入。
>
> 在 Claude Code 裡：`/uniqlaw:migrate`。

## 鐵則

1. **兩個程式不能同時用同一個 bot token。** Telegram 只允許一個 long-poller，Discord/Slack 也會重複回覆。寫入前、啟動前，v2 一定要先停掉。
2. **v2 的檔案只讀不改**（`.claude/claudeclaw/`、`prompts/`、`CLAUDE.md`）。所有輸出都寫在 `.uniqlaw/`，要退回 v2 時才能直接退。
3. **不要把 token / secret 印出來**（包括摘要、diff、log）。提到時只說「telegram.token：已複製」之類。
4. **先給使用者看計畫，確認後才寫入**；`.uniqlaw/settings.json` 已存在時，先比對差異再問要不要覆蓋。
5. 寫完一定要跑 `uniqlaw doctor` 檢查。

## 0. 前置檢查

假設 v2 專案在 `$V2`（通常就是要跑 UniQlaw 的同一個目錄，例如 `~/claudeclaw`）。

- `$V2/.claude/claudeclaw/settings.json` 存在才是 v2 專案。
- v2 是否在跑：`$V2/.claude/claudeclaw/daemon.pid` 裡的 pid 是否還活著（`kill -0 <pid>`）。在跑的話可以先讀、先做計畫，但**寫入前請使用者停掉**（`/claudeclaw2:stop` 或 `kill -TERM <pid>`）。
- 看到 `$V2/.claude/claudeclaw/session.json`，或 `sessions.json` 是 `{ "threads": … }` 這種 v1 形狀：那是 v1 殘留。先請使用者用 v2 的 `/claudeclaw2:migrate` 升到 v2；這份指南不處理 v1。

## 1. 要讀的 v2 檔案

| v2 檔案 | 內容 | 去處 |
|---|---|---|
| `.claude/claudeclaw/settings.json` | 全部設定 | `.uniqlaw/settings.json`（§2） |
| `.claude/claudeclaw/sessions.json` | channelKey → Claude session | `.uniqlaw/state.db` 的 `sessions` 表（§3） |
| `.claude/claudeclaw/inbox/*.jsonl` | 還沒送進 session 的訊息 | `state.db` 的 `pending_input`（§4，可選） |
| `.claude/claudeclaw/jobs/*.md` | cron 工作 | 複製到 `.uniqlaw/jobs/`（格式相同） |
| `prompts/**` | IDENTITY / USER / SOUL… | 同目錄就不用動；不同目錄時複製過去 |
| `CLAUDE.md` | 專案指示 | 不用動，claude 會從 cwd 自己讀 |

## 2. settings.json 對應表

UniQlaw 的完整 schema 在 `packages/core/src/config.ts`；各 plugin 的設定在各自 package 的 `configSchema`。v2 沒寫的欄位就讓 UniQlaw 用預設值，不要硬填。

| v2 | UniQlaw | 備註 |
|---|---|---|
| `timezone` | `timezone` | 照抄。v2 的 `"UTC+8"` 這種格式 cron 讀得懂，但建議問使用者要不要改成 IANA 名稱（`"Asia/Taipei"`） |
| `model` | `profiles.main.model` | `profiles.main.provider` 用 `"claude-tmux"`（行為跟 v2 一樣） |
| `agentic`（modes、hysteresis…） | `profiles.main.options.agentic` | 整個區塊照抄，模型路由直接讀這個格式 |
| `security.level` | `profiles.main.permissions.level` | locked / strict / moderate / unrestricted，其他值當 moderate |
| `security.allowedTools` / `disallowedTools` | `permissions.allowTools` / `denyTools` | |
| `security.skipPermissions: true` | `permissions.approval.mode: "auto-allow"` | 要跟使用者講清楚：所有工具都自動核准 |
| `approval.enabled: false` | `permissions.approval.mode: "auto-deny"` | v2 會讓對話框一直掛著，UniQlaw 改成直接拒絕 |
| 其他情況 | `permissions.approval.mode: "ask-operator"` | |
| `approval.timeoutSeconds` | `permissions.approval.timeoutSec` | |
| `approval.survey` | （不用） | claude-tmux 自己處理（預設略過） |
| `queue.mode` | `queue.mode` | **`"native"` → `"steer"`**（v2 的 native 其實就是 mid-turn steer）；其他值 queue / interrupt 照抄 |
| `queue.debounceMs` / `cap` / `dropPolicy` | 同名 | |
| `sessionCleanup.*` | `sessionCleanup.*` | 同名 |
| `backgroundNotify.mode` | `backgroundNotify.mode` | last / all / off |
| `web.enabled` / `host` / `port` | `web.*` | 沿用 v2 的 4632，舊 skill 打的 `/api/send`、`/api/trigger` 就能照用 |
| `telegram.messageStream.mode` | `output.stream` | UniQlaw 是全域設定；其他平台的 `messageStream` 留在各自的 plugin 區塊裡 |
| `telegram.token` | `plugins.telegram.token` | 見下方「secret」 |
| `telegram.allowedUserIds` | `plugins.telegram.allowedUserIds` | 轉成字串陣列。**空的就要問使用者**（見下方） |
| `telegramPollSeconds` | `plugins.telegram.pollSeconds` | |
| `discord` / `slack` / `line` 區塊 | `plugins.discord` / `plugins.slack` / `plugins.line` | 整塊照抄（adapter 接受 v2 的欄位名稱），再加上 `enabled`；有 token 才搬 |
| `heartbeat` | `plugins.heartbeat` | 照抄；`enabled` 依 v2 原本的值，或問使用者。**注意**：v2 的 heartbeat 跑在 `global`（就是私訊那段對話），UniQlaw 預設跑在自己的內部 session `heartbeat`，看不到私訊裡交代的事。要沿用 v2 行為，就把 `target` 設成使用者的私訊 key（例如 `telegram:<id>`）；要用獨立 session 的話，建議設 `replyTo` 指向使用者，或設 `"none"` 讓它自己用 `notify` / `agent_trigger` 決定要不要講 |
| `jobs/*.md` | `plugins.cron` | cron 預設就開，不用寫。**注意**：v2 的 job 沒寫 `target` 時跑在 `global`（私訊），UniQlaw 沒寫時跑在 job 自己的內部 session `cron:<job>`。如果某個 job 需要私訊的對話 context，就在那個 job 檔加上 `target: telegram:<id>`（問使用者） |
| `api`、`fallback`、`sessionTimeoutMs` | （不用） | v1 時代留下的 key，告訴使用者被略過了 |
| 其他沒看過的 key | （不用） | 列給使用者看，不要猜 |

最後加上 `"bindings": { "default": "main" }`。

**allowlist（最重要）**：v2 的空 `allowedUserIds` 代表「所有人都可以」，UniQlaw 的空清單代表「**所有人都拒絕**」（fail closed）。只要有平台的清單是空的，就要停下來問使用者要放哪些 user id。不要自己填，也不要為了讓它能動就留空。使用者也不知道的話，先把該平台設成 `enabled: false`。

**secret**：token 可以照抄成字串（schema 接受），但建議使用者改成 SecretRef，例如 `{"env": "TELEGRAM_BOT_TOKEN"}`、`{"file": "~/.config/uniqlaw/tg"}`、`{"command": "pass show tg"}`。要改的話，請使用者自己設定環境變數或檔案，agent 不要經手 token 的值。

寫完先驗證 schema（不會印出內容）：

```bash
bun -e 'import {parseSettings} from "<repo>/packages/core/src/config.ts"; parseSettings(JSON.parse(await Bun.file(".uniqlaw/settings.json").text())); console.log("ok")'
```

## 3. 接回 v2 的 Claude session

v2 的 `sessions.json` 長這樣（key 就是 channelKey：`global`、`telegram:<chatId>`、`discord:<channelId>`、`slack:<channel>[:<thread>]`、`line:<id>`）：

```json
{ "telegram:-100123": { "sessionId": "<uuid>", "tmuxSession": "claudeclaw-…", "createdAt": "…", "lastActivityAt": "…", "multiparty": true } }
```

每一筆寫成 `state.db` 的一列 session，`provider` 是 `claude-tmux`，`providerSessionId` 是 v2 的 `sessionId`。`state.db` 已經有同一個 channelKey 的話就跳過，不要覆蓋。範例（依實際內容調整）：

```bash
bun -e '
import { StateStore } from "<repo>/packages/core/src/state.ts";
const v2 = JSON.parse(await Bun.file(".claude/claudeclaw/sessions.json").text());
const store = new StateStore(".uniqlaw/state.db");
const have = new Set(store.listSessions().map((s) => s.channelKey));
const ms = (v, d) => typeof v === "number" ? v : (Date.parse(v) || d);
const target = (k) => { const m = k.match(/^(telegram|discord|line):(.+)$/); if (m) return { platform: m[1], chatId: m[2] };
  const s = k.match(/^slack:([^:]+)(?::(.+))?$/); return s ? { platform: "slack", chatId: s[1], ...(s[2] ? { threadId: s[2] } : {}) } : null; };
for (const [key, v] of Object.entries(v2)) {
  if (!v?.sessionId) continue;
  const channelKey = v.channelKey || key;
  if (have.has(channelKey)) { console.log("skip", channelKey); continue; }
  const created = ms(v.createdAt, Date.now()), t = target(channelKey);
  store.upsertSession({ channelKey, profile: "main", provider: "claude-tmux", providerSessionId: v.sessionId,
    multiparty: v.multiparty === true, createdAt: created, lastActivityAt: ms(v.lastActivityAt, created),
    lastTarget: t ? JSON.stringify(t) : null, adapterState: JSON.stringify({ v2TmuxSession: v.tmuxSession ?? null }) });
  console.log("imported", channelKey);
}
store.close();'
```

**v2 的 `global`（私訊）要改名。** v2 把所有私訊收斂到 `global`；UniQlaw 的每個私訊都是自己的 session（`telegram:<userId>`、`discord:dm:<userId>`、`slack:dm:<userId>`、`line:<userId>`），所以照抄的話，沒有任何私訊會再進到 `global`。匯入時：

- 只有一個人在私訊 bot（通常就是 `allowedUserIds` 只有一個 id）：把 `global` 那一列的 channelKey 改成那個人的私訊 key（例如 `telegram:<那個 id>`），`lastTarget` 也指向他。這樣他下一次私訊就會接回原本的對話。
- 有好幾個人：問使用者要把舊對話接給誰；其他人從新的 session 開始。
- 使用者不想接：就照抄成 `global`，它會變成一個內部 session（`agents_list` 看得到，可以 `agent_ask` 它），但不會再收到私訊。

第一則訊息進來時，claude-tmux 會在 UniQlaw 自己的 tmux socket（`tmux -L uniqlaw-<instanceId>`）用 `--resume <sessionId>` 接回對話。v2 留下的 tmux session 如果還在跑同一個 session，會先被關掉，避免兩個 claude 寫同一個 jsonl。對話歷史都在 `~/.claude/projects/*/<sessionId>.jsonl`，不會遺失。

## 4. inbox（可選）

`inbox/*.jsonl` 是 v2 還沒送進 session 的訊息（檔名是 channelKey，`:` 換成 `_`，例如 `telegram_-100123.jsonl` → `telegram:-100123`；slack 的 `_` 都還原成 `:`）。通常是空的或是很舊的東西，先把筆數和時間給使用者看，問要不要帶過去。要的話，每行寫一筆：

```ts
store.pushPending(channelKey, "external", { source: "v2-inbox", ts, kind, from, text, note });
```

下一輪對話開始時，runtime 會用 v2 的格式（「you sent…」、「trigger response…」）把它們放進 prompt。

## 5. 驗證、啟動

```bash
uniqlaw doctor --project "$V2"   # 工具、憑證、port、bot token 衝突、v2 是否還在跑
uniqlaw start  --project "$V2"
uniqlaw status --project "$V2"
uniqlaw logs   --project "$V2"
```

最後跟使用者回報：搬了什麼、略過什麼（還有原因）、哪些需要他們自己處理（allowlist、SecretRef、時區）。

## 退回 v2

v2 的檔案完全沒動，所以：

```bash
uniqlaw stop --project "$V2"
tmux -L uniqlaw-<instanceId> kill-server   # instanceId 見 `uniqlaw status`
# 再用 /claudeclaw2:start 啟動 v2
```
