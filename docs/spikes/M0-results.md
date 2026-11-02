# M0 Spike 結果（2026-11-02）

情境定義見 `spikes/README.md`（S1 basic、S2 tool + 權限、S3 interrupt、S4 inject、S5 resume、
S6 MCP 身分綁定、S7 model switch）。各 adapter 的原始紀錄、事件對應表、細節在
`spikes/<adapter>/{out/result.md, NOTES.md}`，Claude 兩個 adapter 的彙整在 `spikes/claude-SUMMARY.md`。

## 總表

| adapter | 版本 | S1 | S2 | S3 | S4 | S5 | S6 | S7 | 備註 |
|---|---|---|---|---|---|---|---|---|---|
| claude-sdk | SDK 0.3.x / CLI 2.1.316, haiku | ✅ | ✅ | ✅ | ✅ steer | ✅ | ✅ | ✅ live | 另驗：slash commands、plugins/skills/hooks 全載入 |
| claude-tmux | CLI 2.1.316, haiku | ✅ | ✅ pane | ✅ | ✅ steer | ✅ | ✅ | ✅ `/model` | 另驗：與 SDK 互相 resume ✅ |
| codex | app-server 0.166.0, gpt-6-luna | ✅ | ✅ | ✅ | ✅ steer | ✅ | ✅ per-session | ✅ per turn | 要關 `memories` |
| opencode | serve 1.19.0, nemotron 3.5（免費） | ✅ | ✅ | ✅ | ✅ steer | ✅ | ✅ per-process | ✅ per message | MCP 整個 instance 共用 |
| acp（通用） | SDK 2.2, `opencode acp` | ✅ | ✅ | ✅ | ✅（agent 行為，非協定保證） | ✅ load 會重播 | ❌ **身分外洩** | ✅ config option | Gemini CLI 已被 Antigravity CLI 取代，不列入支援 |
| agy | 1.4.12 stream-json | ✅ | ⚠️ 無 callback | ✅ SIGINT + 重開 | queue only | ✅ | ✅ cwd 檔 + shim | spawn | 官方 headless 存在 |
| pi | pi-coding-agent 1.4.0 | ✅ | ✅ | ✅ | ✅ steer + followUp | ✅ | ✅ per-session + native | ✅ live | **faux provider**，真模型待憑證 |

## M0 待驗項目的答案

| # | 問題 | 答案 |
|---|---|---|
| 0 | claude-tmux ↔ claude-sdk 能不能互相 resume | ✅ 兩個方向都可以，歷史保留。jsonl 要依 id glob 找（`~/.claude/projects/*/<id>.jsonl`） |
| 1 | claude-sdk 對 TUI 生態的完整度 | ✅ `settingSources: ["user","project","local"]` → 13 plugins / 134 skills / 188 slash commands / user MCP 全載入，hooks 會觸發，slash command 當 prompt 送就會執行 |
| 2 | 訂閱帳號在 SDK 下的授權 | 技術上可用（`apiKeySource=none`，走 CLI 的 claude.ai OAuth）。官方文件：「Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK.」→ 已決定：uniqlaw 只做相容與支援，使用由使用者自行負責（architecture 目標 8、§13 #6） |
| 3 | claude streaming input 的排隊語意 | 每則訊息可選 `priority`：`next`/未設 = turn 中途 steer、`later` = 排到 turn 後、`now` = 中斷後立刻執行 |
| 4 | codex `turn/steer` 參數 | `{threadId, expectedTurnId, input}`，真正的 mid-turn steer；閒置時回 `-32600 no active turn to steer` |
| 5 | agy 官方 headless | ✅ 存在：`--input-format stream-json --output-format stream-json -p=`。stdin 沒有控制通道（`control_request` 回 not supported yet）。沒查到程式化使用的條款限制（也沒查官方條款） |
| 6 | pi SDK 的 project trust | 不會跳提示也不會卡住，但**沒傳 resolver 時預設會載入 `.pi/` 受保護資源** → 必須傳 `reload({ resolveProjectTrust })` |

## 跨 adapter 的重要發現

1. **v2 的 `native` queue 模式其實是 steer。** Claude TUI 在 busy 時貼上的訊息會在 turn 中途送進去，不是排到 turn 結束。uniqlaw 把模式改成 `queue / steer / interrupt`，turn 邊界排隊一律由 core 做。
2. **「per-session MCP」不能相信宣告，要用測試證明。** ACP 協定說 MCP 是 per-session，但 `opencode acp` 實作上是 process 共用：兩個 session 用同一個名稱時，A 呼叫到 B 的 token。合約測試必須包含跨 session MCP 隔離；沒通過的 adapter 一律一個 session 一個 process。
3. **繞過 bus 的管道比預期多：**
   - Claude：`disallowedTools` 有效，但 `messaging_socket_path` 仍開著，可能收得到外部 session 的訊息。
   - Claude：user hooks（例如 claude-mem）在同一個 cwd 會跨 session 帶 context。
   - Codex：`memories` 會跨 thread 共用記憶。
4. **權限模式一定要由 adapter 明確指定。** 使用者全域設定 `defaultMode: "auto"` 會讓 Claude 直接跳過 `canUseTool`。
5. **拒絕權限的語意不一致**：claude-tmux 拒絕會結束整個 turn，其他 adapter 只讓該 tool 呼叫失敗 → 新增 `denyEndsTurn` 能力，由 core 補一個 turn 統一行為。
6. **resume 可能重播歷史**（ACP `session/load`），adapter 要抑制，不能讓重播事件進到 Output Pipeline。
7. **只能用檔案設定 MCP 的 provider**（agy）用 stdio shim + 環境變數 token 解決身分綁定，這個做法可以通用。
8. **bus 工具可能被延遲載入**（Claude 的 ToolSearch），要設 always-load 或在 system prompt 列出工具名稱。
9. **新事件 `input_request`**：ACP / MCP 的 elicitation 需要一個獨立於權限確認的「請 human 補資料」事件。

## 尚未驗證 / 後續

| 項目 | 何時 |
|---|---|
| pi 跑真模型（需要 OpenAI key / Vertex ADC / `pi /login`） | 拿到憑證後重跑 `spikes/pi/poc.ts` |
| agy 的 API key / Vertex 環境變數、設定目錄覆寫（多實例需要） | M3 |
| 各 adapter 的三大雲憑證實測（§10.1 表格） | M2–M3 |
| agy `--remote-control`（可能有權限 callback） | M3 |
| codex `dynamicToolCall` / `item/tool/call`（client 提供 native tool） | M3 |
| 關閉 Claude 原生訊息 socket 的方法 | M1 |
| Claude bus 工具 always-load 的設定方式 | M1 |
| 各 provider 的附件（image/file/audio）輸入 | M1–M3 各自 adapter 實作時 |

以上結論都已更新到 `docs/architecture.md`（v0.3）：§5 能力介面、§5.1 能力矩陣、§5.2、§6 polyfill、§8.3 shim、§13 新待決事項。
