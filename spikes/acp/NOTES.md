# 通用 ACP adapter spike（`@agentclientprotocol/sdk` 2.2.0，ACP v1）

PoC：`poc.ts`（`bun poc.ts <agent> [S1..S7]`）是**一個**通用 client，各 agent 只差 `AGENTS` 表裡的啟動指令和 env。
結果：`out/<agent>/result.md`。

## 實測涵蓋範圍

| agent | 狀態 |
|---|---|
| `opencode acp`（1.19.0） | S1–S7 全部跑完（結果見 `out/opencode/result.md`） |
| `gemini --experimental-acp`（0.28.2） | 只到 `initialize`。`session/new` 失敗：「This client is no longer supported for Gemini Code Assist for individuals… migrate to Antigravity」。這台機器沒有 `GEMINI_API_KEY` / Vertex → 無法跑 turn。另外 0.28.2 **沒有 `--acp`**，只有 `--experimental-acp` |
| `agy`（Antigravity CLI 1.4.12） | **沒有原生 ACP 模式**。`agy --help` 有的是 `--print` + `--input-format stream-json --output-format stream-json`、`--conversation <id>`（resume）、`--remote-control`、`agy mcp`、`--dangerously-skip-permissions`、`--mode`、`--model`。`~/.gemini/antigravity-acp/`（含 token 檔與 conversations db）看起來是某個社群 ACP bridge 留下的狀態，沒有對應的可執行檔可以驗證。agy 的深入調查交給另一個 fork |
| `cursor-agent` | 未登入、版本舊（2026.01），沒有 ACP 子命令 → 跳過 |

**結論：通用 ACP client 的協定層在 opencode 上完整驗證通過；其他 ACP agent 在這台機器上受限於帳號 / 版本，無法實測。**

## SDK 用法重點（2.2.0）

- `acp.client({name}).onNotification(...).onRequest(...).connect(acp.ndJsonStream(stdinWritable, stdoutReadable))`
  → `ClientConnection`；呼叫 agent 用 `conn.agent.request(method, params)` / `conn.agent.notify(...)`。
- **handler 收到的是 context `{ method, params, signal, agent }`，不是 params 本身**（第一版 PoC 因為這樣漏掉所有 `session/update`）。
- stable 入口沒有 `session/set_model`；model 選擇走 **`session/set_config_option`**（`configOptions` 裡 `category:"model"` 的選項）。
  unstable 入口另外有 `session/resume|close|fork|list|delete`、`providers/*`、`elicitation/*`。
- client 宣告 `fs`/`terminal` 能力為 false → agent 用自己的工具讀寫檔、執行指令（uniqlaw 要的就是這樣）。

## 原生事件 → `AgentEvent`

| ACP | AgentEvent | 備註 |
|---|---|---|
| `session/new` 回傳 `sessionId` | `session` | |
| client 送出 `session/prompt` | `turn_start` | ACP 沒有 turn start 事件，由 client 自己產生 |
| `session/update` `agent_message_chunk` | `text{delta}` | 在 tool_call 或 turn 結束時把累積的文字 flush 成 `text{final}` |
| `agent_thought_chunk` | `thinking` | |
| `tool_call` | `tool_start` | `kind`（execute/edit/read/…）、`title`、`rawInput` |
| `tool_call_update` status=completed/failed | `tool_end` | |
| `session/request_permission`（agent→client request） | `permission_request` | options 有 kind：`allow_once/allow_always/reject_once/reject_always`；回 `{outcome:{outcome:"selected",optionId}}` |
| `session/prompt` resolve `stopReason` | `turn_end` | `end_turn`→done、`cancelled`→interrupted；`usage` 有 token 數 |
| `session/prompt` reject | `error` + `turn_end{error}` | |
| `available_commands_update` | （無；可餵給平台的 slash command 註冊） | |
| `elicitation/create`（unstable） | （缺）→ 建議 `input_request` | |

## 情境結論（opencode acp）

- S1 ✅ 逐 chunk 串流、`usage` 有回傳。
- S2 ✅ `session/request_permission` allow/reject 都正確（需要用 `OPENCODE_CONFIG_CONTENT` 把 bash/edit 設成 `ask`）。
- S3 ✅ `session/cancel`（notification）→ prompt 回傳 `stopReason:"cancelled"`，session 可以繼續用。
- S4：**ACP v1 沒有 steer 方法**。但 turn 進行中**同時再送一個 `session/prompt`**，opencode 會把它收進當前的 run loop
  （等於 steer），兩個 prompt 都以 `end_turn` 結束，最終回覆帶 INJECTED。
  → 這是 **agent 自己定義的行為**，協定沒有保證。其他 agent 可能回錯誤、排隊、或取消前一個。
  adapter 不能假設；capability 要以合約測試實測值為準（預設 `inject: false`，測過才升級）。
- S5 ✅ 新 process + `session/load` → 歷史以 `session/update` 重播（client 要把重播的內容丟掉，不能轉發到平台），接著可以繼續對話。
  opencode 另外宣告 `sessionCapabilities.resume`（unstable `session/resume`，不重播）。
- S6 ❌ **重大發現：ACP 語意上 `mcpServers` 是 per-session 的，但 opencode acp 實作上是 process 共用**：
  - 兩個 session 在同一個 process 都用名稱 `uniqlaw` → 後註冊的蓋掉前面的，**session A 呼叫到的是 B 的 token**（身分外洩）。
  - 名稱改成每個 session 唯一（`uniqlaw_<token>`）→ 呼叫結果正確，但 **A 的工具清單裡也看得到 B 的工具**
    （模型列出 `uniqlaw_acpA_uniqlaw_ping` 和 `uniqlaw_acpB_uniqlaw_ping`），只是剛好選對。
  - → 通用 ACP adapter **不能相信 agent 的 per-session MCP 隔離**。預設：**一個 uniqlaw session = 一個 agent process**。
    只有通過「跨 session MCP 隔離」合約測試的 agent，才允許多個 session 共用 process。
- S7 ✅ `session/set_config_option {configId:"model", value}` → 立即生效，回傳更新後的 configOptions。

## Capability（§5 格式）

通用 ACP adapter 的**保守預設**（實際值依 `initialize` 回應和合約測試結果調整）：

```ts
acp: {
  streaming: "token",                 // agent_message_chunk（實際粒度由 agent 決定）
  interrupt: true,                    // session/cancel
  inject: false,                      // 協定沒有 steer；併發 prompt 的行為由 agent 定義（opencode 測得 steer）
  resume: "native",                   // 需要 agentCapabilities.loadSession（或 unstable sessionCapabilities.resume）
  modelSwitch: "live",                // 需要 configOptions 裡有 category:"model"；否則 false
  permissionCallback: true,           // session/request_permission
  mcp: "per-process",                 // 協定是 per-session，但實作不可信（opencode 實測會外洩）
  nativeTools: false,
  attachments: ["image"],             // 依 promptCapabilities
  slashCommands: true,                // available_commands_update
}
```

opencode 經由 ACP 的實測值：`inject: "steer"`（併發 prompt）、其餘同上。

## 對設計文件的修正建議

1. §5.1 acp 那一列：「`session/new` 可帶 mcpServers（per-session）」改成「協定上 per-session，但實作不可信；預設一個 session 一個 process」。
2. §6：ACP 的 inject 實際由 agent 決定。adapter 在啟動時（或用合約測試）偵測：併發 `session/prompt` 會 steer、排隊還是回錯。
   不要寫死 `inject=false`；但沒測過的 agent 預設要用 `queue` 模式（polyfill）。
3. §6 新增一列：`resume` 用 `session/load` 時會**重播歷史**，adapter 必須抑制重播的事件，不能讓它們進到 Output Pipeline。
4. §5 `AgentEvent`：新增 `input_request`（`elicitation/create`）。
5. Antigravity：`agy` 沒有原生 ACP → 只剩兩條路：專用的 `provider-agy`（stream-json，另一個 fork 驗證），或社群 bridge。
   Gemini CLI 對個人 OAuth 帳號已不可用（要 API key 或 Vertex）→ 文件裡把 Gemini CLI 從「主要 ACP 目標」降級。
6. 合約測試新增：**跨 session MCP 隔離**（兩個 session 各自掛 gateway token，檢查 A 的工具清單裡沒有 B 的工具、A 的呼叫只會帶 A 的 token）。
   這條要套用到**所有** provider（opencode serve 也是 instance 共用）。
