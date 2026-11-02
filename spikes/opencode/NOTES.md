# OpenCode spike（`opencode serve` 1.19.0，raw HTTP + SSE）

PoC：`poc.ts`（`bun poc.ts [S1..S7]`）。結果：`out/result.md`。原始事件：`out/S*/raw.jsonl`。
Model：`opencode/nemotron-3.5-lightning-free`（OpenCode Zen 的免費 model）。另一個 model：`nemotron-3.5-super-vl-free`。

結果：S1–S7 全部 ✅。

## 控制介面

- 一個 `opencode serve` = 一個 instance。用 `?directory=<abs>` 指定專案。SSE 用 `GET /event?directory=`。
- 開 session：`POST /session { title, permission?: PermissionRule[], model?, agent? }` → `ses_…`
- 送訊息：`POST /session/:id/prompt_async { parts, model?, agent?, system?, tools?: {id:bool}, noReply? }` → 204
- 中斷：`POST /session/:id/abort`
- 權限：SSE `permission.asked` → `POST /permission/:requestID/reply { reply: once|always|reject }`。
  舊路徑 `/session/:id/permissions/:id` 也還在，另外還有 `permission.v2.asked`。
- MCP：`POST /mcp { name, config: {type:"remote", url, headers?, oauth:false} }`，在執行期動態加入，**整個 instance 共用**。
  也可以啟動時用 `OPENCODE_CONFIG_CONTENT` 設定。
- 另外有 `question.asked`（agent 主動問使用者，屬於 `question` 工具）→ 目前的 `AgentEvent` 沒有對應型別（見下方修正建議）。

## 原生事件 → `AgentEvent`

| OpenCode | AgentEvent | 備註 |
|---|---|---|
| `POST /session` 回傳 id | `session` | session id 在 server 重啟後仍有效（存在 `~/.local/share/opencode`） |
| `session.status {busy}`（送出後第一次） | `turn_start` | **不要用 `step-start` part**：一個 run loop 裡每個 LLM step 都有一個 |
| `message.part.delta`（part type=text） | `text{delta}` | 逐 token 串流 |
| `message.part.updated`（text，`time.end` 已設） | `text{final}` | |
| `message.part.updated`（reasoning 結束） | `thinking` | |
| `message.part.updated`（tool，state=pending/running） | `tool_start` | `input` 在 pending 時常是 `{}`，到 running 才完整 |
| `message.part.updated`（tool，state=completed/error） | `tool_end` | 拒絕權限 → error「The user rejected permission…」 |
| `permission.asked` / `permission.v2.asked` | `permission_request` | `permission`=工具類別（bash/edit/…）、`patterns`=指令或路徑 |
| `session.error` | `error` | 也有 `ProviderModelNotFoundError` 等 |
| `session.idle` | `turn_end` | reason 看該 turn 的 assistant message 有沒有 `error.name=MessageAbortedError` |
| `question.asked` | （缺） | 建議新增 `input_request` |

### 陷阱（adapter 必須處理）

1. **abort 之後會出現重複或過期的 `session.idle`**。只能用「送出 → 看到 busy → 第一個 idle」來判斷 turn 結束，其餘 idle 一律丟掉。
2. 舊 assistant message 的 `error` 在 abort 後的下一個 turn 仍會被 `message.updated` 再推一次 → 要在 turn 開始（busy）時清掉 error 狀態。
3. **bash 工具的 `workdir` 預設是 git worktree 根目錄**，不是 `directory` 參數。S2 第一次跑時，檔案被寫到 repo 根目錄而不是 `work/`。
   uniqlaw 的 session cwd 通常就是專案根目錄，所以多半不是問題；但如果要做「每個 session 一個子目錄」的隔離，不能依賴 `directory`。
4. 免費 model 的清單會在執行期刷新（`nemotron-3-ultra-free` 在測試中途消失）。model 不存在時，回應是 `session.error` + 立刻 idle → adapter 應回報 `error`，不要讓 turn 卡住。

## 情境結論

- **S4 inject = steer**：turn 進行中呼叫 `prompt_async` → 新的 user message 在**下一個 step 邊界**被收進同一個 run loop
  （模型在第 2 個 step 的思考中就看到了），整個過程只有一次 idle。最終回覆是 `DONE INJECTED`。
  → `inject: "steer"`（粒度是 step 邊界，不是 tool 執行中途）。
- **S6 MCP 是 instance 層級**：
  - `POST /session` 沒有 mcp 參數。`POST /mcp` 加進去的 server，**所有 session 都看得到**（tool id 會變成 `<server>_<tool>`）。
  - 隔離方法 1：同一個 instance、每個 session 一個 MCP server 名稱（`uc_<sessionKey>`），再用 session 的
    permission ruleset `[{permission:"uc_<other>_*", pattern:"*", action:"deny"}]` 擋掉別人的。實測：A 只打到 sessA。
    缺點：未驗證 deny 是否會把工具從模型的工具清單移除（若只是呼叫時擋下，模型仍看得到別人的工具），而且 session 越多，規則越多。
  - 隔離方法 2：每則訊息用 `tools: {"uc_B_uniqlaw_ping": false}` 關掉別人的工具。實測可行，但要每次送訊息都帶。
  - 隔離方法 3：**每個 uniqlaw session 一個 `opencode serve`**，用 `OPENCODE_CONFIG_CONTENT` 帶自己的 MCP（實測 sessC 正確）。
    最乾淨，代價是每個 process 約一個 Bun runtime 的記憶體。
  - 建議：預設用方法 3（`mcp: "per-process"`）；方法 1 留作多 session 共用 instance 的最佳化選項。
- **S7**：`prompt_async` 的 `model` 欄位可以每則訊息不同 → `modelSwitch: "live"`（其實是 per-message）。
- **S2**：權限 ruleset 可以 per-session 設定（`POST /session {permission}`、`PATCH /session/:id`）→ 對應 uniqlaw 的 PermissionPolicy 很直接。

## Capability（§5 格式）

```ts
opencode: {
  streaming: "token",
  interrupt: true,                 // POST /session/:id/abort
  inject: "steer",                 // prompt_async while busy → admitted at next step boundary
  resume: "native",                // session id persists across server restarts
  modelSwitch: "live",             // per-message model
  permissionCallback: true,        // permission.asked + /permission/:id/reply
  mcp: "per-process",              // instance-wide; per-session needs 1 serve/session (or deny-rules)
  nativeTools: false,              // (plugins exist, but out of process)
  attachments: ["image", "file"],  // FilePartInput（未在此 spike 實測）
  slashCommands: true,             // GET /command, POST /session/:id/command（未實測）
}
```

## 對設計文件的修正建議

1. §5.1 opencode 那一列：MCP 確認是 instance 層級 → 「每個 session 一個 serve」是預設做法，不是待驗證的選項。另外補充 `POST /mcp` 動態加入，以及 deny-ruleset 的替代方案。
2. §6：opencode 的 `inject` 實測是 `steer`（step 邊界），不是 `queue`。
3. §5 `AgentEvent`：新增 `{ type: "input_request"; id; question; options? }`，對應 OpenCode 的 `question.asked`、
   ACP 的 `elicitation/create`、Claude 的 AskUserQuestion。目前只有 permission_request，無法表達「agent 想問人類一個問題」。
4. adapter 合約測試要加：abort 後的重複 idle、abort 後下一個 turn 的狀態要乾淨。
