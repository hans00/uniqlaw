# pi（`@earendil-works/pi-coding-agent` 1.4.0 SDK）spike notes

## 前提：模型改用假 provider

這台機器沒有 pi 能直接使用的 LLM 憑證：
- `~/.pi/agent` 沒有 `auth.json`，也沒有任何 API key 環境變數。
- 本機沒有 OpenAI-compatible server（11434 / 8080 / 1234 / 8000 都沒開）。
- 我原本想檢查能不能沿用 codex 的 OAuth token、或 Vertex ADC，但 auto-mode 把這類讀取憑證的動作擋下了，我沒有繞過。

所以模型改用 pi-ai 內建的 **`fauxProvider`**。它的回應可以是 factory（根據 context、model 動態產生），等於一個可程式化的假 LLM。
- **驗證了**：harness 本身的機制，包括事件、tool gate、中斷、steer/followUp、保存與接回、MCP、native tool、切換 model、project trust。
- **沒驗證**：真實模型的行為，例如會不會照提示呼叫工具、Vertex 或 OpenAI 的認證流程。
- 要跑真實模型，需要以下其中一種（擇一）：
  - `OPENAI_API_KEY`
  - Vertex：`GOOGLE_CLOUD_PROJECT`、`GOOGLE_CLOUD_LOCATION` 加上 ADC
  - 在隔離的 agent dir 裡跑一次 `pi /login`（例如 openai-codex 或 github-copilot）
  - 一個本機的 OpenAI-compatible endpoint

## 結論：自建 harness 用 pi-coding-agent SDK 可行，而且能力最完整

| 項目 | 怎麼接 |
|---|---|
| 建立 session | `createAgentSession({ cwd, model, modelRuntime, resourceLoader, settingsManager, sessionManager, customTools })`，完全在同一個 process 內，不需要子程序 |
| 隔離 | 傳入自己的 `agentDir`、`SettingsManager.inMemory()`、`ModelRuntime.create({ authPath, modelsPath: null })`。⚠️ **還要設定 `PI_CODING_AGENT_DIR`**，因為 MCP OAuth store 會直接呼叫 `getAgentDir()`，不看 resource loader 的 `agentDir`。第一次跑時沒設，結果在使用者的 `~/.pi/agent/` 建立了一個 2 bytes 的 `mcp-auth.json`（應該是 `{}`）。我沒有讀它、也沒有刪，請使用者自己確認後刪除。 |
| 權限（Approval Broker） | 在 inline extension 裡寫 `pi.on("tool_call", async e => ok ? undefined : { block: true, reason })`。可以 `await` 任意久，所以能等 operator 按按鈕。built-in tool、native tool、MCP tool **全部**都會經過這個 hook。handler 丟例外時會 fail-closed（擋下）。 |
| 逐 session 掛 MCP | 在 inline extension 裡呼叫 `pi.registerMcpServer("uniqlaw", { url: gw.url(token), exposure: "direct" })`，再加上 `createMcpExtension()` 和 `session.bindExtensions({})`。**完全不用寫設定檔**。工具名稱是 `mcp__uniqlaw__uniqlaw_ping`。 |
| native tool | `customTools: [defineTool({ name, parameters: Type.Object(...), execute })]`（schema 用 typebox）。bus 工具可以直接用這種方式註冊，不必經過 MCP。 |
| project trust（M0 第 6 項） | SDK 模式**不會跳提示，也不會卡住**。⚠️ **沒傳 resolver 時，預設會載入** `.pi/` 下受保護的資源（實測 `.pi/APPEND_SYSTEM.md` 被載入，使用 in-memory settings 的情況）。要用程式控制，就呼叫 `resourceLoader.reload({ resolveProjectTrust: async () => boolean })`，實測 false 和 true 都照預期生效。另一種方式是讓 extension 處理 `project_trust` 事件。provider-pi **必須明確傳 resolver**，交給 uniqlaw 的 profile 設定決定，不能依賴預設值。 |

## 原生事件對應到 `AgentEvent`

| pi `AgentSessionEvent` | AgentEvent |
|---|---|
| （建立後）`session.sessionId` | `session` |
| `agent_start` | `turn_start` |
| `message_update` + `assistantMessageEvent.type=text_delta` | `text{delta}` |
| `message_update` + `thinking_delta` | `thinking` |
| `message_end`（assistant） | `text{final}`；`stopReason === "aborted"` 時把這個 turn 標成中斷 |
| `tool_execution_start` / `tool_execution_end{isError}` | `tool_start` / `tool_end` |
| 我們的 `tool_call` handler | `permission_request`（由 adapter 自己發出） |
| **`agent_settled{aborted}`** | `turn_end`。不要用 `agent_end`，因為後面可能還會有重試或排隊的工作 |
| `queue_update{steering, followUp}` | 可以拿來顯示「訊息已排隊」 |

## 實測結果（見 out/result.md，8/8 ✅）

| # | 結果 |
|---|---|
| S1 | text_delta 是逐 token 串流。 |
| S2 | 允許 → bash 執行，檔案有建立。拒絕 → tool result 變成 `isError`，模型會看到拒絕原因，檔案沒建立。 |
| S3 | `session.abort()` 會等到 session 回到 idle 才 resolve。assistant 訊息的 `stopReason` 是 `aborted`。同一個 session 可以直接繼續，不需要重開。 |
| S4 | `steer()` 和 `followUp()` 都回傳 `"queued"`。steer 的文字在**當前 tool batch 跑完後的下一次 LLM 呼叫**就出現（同一次 run，第 1 次呼叫）。followUp 要等這次 run 原本就要停下時，才以新的 run 出現（第 4 次呼叫）。兩種語意跟文件說的一樣。 |
| S5 | `SessionManager.create(cwd, sessionDir)` 寫成 JSONL，`SessionManager.open(file, sessionDir)` 接回後歷史有送進模型的 context，sessionId 相同。sessionDir 由宿主決定，所以可以統一放在 `.uniqlaw/` 底下。 |
| S6 | gateway 收到的 token 正確（逐 session 綁定身分）；native tool 也能用；gate 兩種工具都看得到。 |
| S7 | 兩個 turn 之間呼叫 `session.setModel()`，同一個 session、歷史保留。跨 provider 交接時，pi-ai 會自動丟掉另一家的 thinking block。 |

## Capability（§5 形狀）

```ts
{
  streaming: "token",
  interrupt: true,             // in-process abort(), no respawn
  inject: "steer",             // + followUp() for queue semantics
  resume: "native",            // pi SessionManager JSONL (host-chosen dir) — not core-managed
  modelSwitch: "live",
  permissionCallback: true,    // tool_call hook, async, fail-closed
  mcp: "per-session",          // pi.registerMcpServer() in an inline extension
  nativeTools: true,           // customTools / pi.registerTool
  attachments: ["image"],      // pi-ai image input (not exercised here)
  slashCommands: true,         // prompt() expands extension commands / prompt templates (not exercised)
}
```

## 對設計文件的修正建議

1. §5 provider-pi：`resume` 從原本設想的 `core-managed` 改成 `native`。pi 自己的 SessionManager 已經做好保存，只要指定 sessionDir。core-managed history 在第一版可能沒有任何 provider 需要。
2. §5 / §10：provider-pi 的權限 gate 確定可以完全由我們實作（fail-closed），是所有 provider 中權限控制最完整的。
3. §6：pi 同時支援 `steer` 和 `followUp`，所以 queue 模式的三種選項（queue / steer / interrupt）在 pi 上都是原生支援。
4. M0 第 6 項的結論：provider-pi 必須明確傳入 `resolveProjectTrust` 並設定 `PI_CODING_AGENT_DIR`，加進 adapter 的必要事項和合約測試。
5. 測試策略：`fauxProvider` 很適合當 **testkit 的 provider-pi 合約測試後端**，可以在 CI 裡不花額度、確定性地測完整條 harness。對其他 provider，也可以當 core 測試用的 mock LLM。
