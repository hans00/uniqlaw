# UniQlaw 架構設計（草案 v0.6）

> 目標：重做 claudeclaw-v2，做成全模組化。底層 agent 走通用 provider 介面，跨 session
> 通訊由我們自己掌握，並支援 A2A。
> 日期：2026-11-02（v0.2：納入 §13 決策；v0.3：納入 M0 實測，見 `docs/spikes/M0-results.md`；v0.4：憑證層、多實例隔離；v0.5：M1 實作回饋；v0.6：M1.5–M4 實作回饋，見 §15）。標 ⚠️ 的項目在實作前要先 spike 驗證。

---

## 1. 目標與非目標

**目標**

1. **全部是 plugin**：Agent provider、聊天平台、排程器、對外協定（A2A）都是同一套
   plugin 機制的不同 kind。core 只認介面，不知道任何具體實作。
2. **Provider 通用介面**：Claude Code / Codex / OpenCode / Antigravity CLI / ACP 系 agent
   / 純 LLM API（OpenAI、Vertex、Anthropic API、OpenAI-compatible…）都只是 adapter。
3. **換 provider 不能少功能**：每個功能要嘛由 core 實作，要嘛 adapter 原生支援。
   adapter 做不到的由 core 補（polyfill）；補不了的要明確標示，不能默默降級（見 §6）。
4. **跨 session 通訊由我們自己掌握**：自建 message bus，透過 MCP（或 native tool）提供給
   所有 agent。不依賴任何 provider 私有機制（例如 Claude 的 `SendMessage`）。
5. **A2A 原生**：bus 的資料模型直接照 A2A v1.0（Message / Task / Part / contextId）設計，
   對外 A2A 只是在 bus 外面加一層 transport。
6. **三大雲 + 直連 API 全支援**：AWS Bedrock、Google Vertex AI、Azure（OpenAI / AI Foundry），
   以及 Anthropic / OpenAI / Gemini 直連 API。API key、Google ADC / service account、AWS
   credential chain（profile / SSO / role）、Azure Entra ID 都要能設定（§10.1）。
7. **同一台機器可以跑多個 claw**：多個 uniqlaw 實例互不干擾，包括 state、port、tmux、
   provider 設定目錄、登入帳號（§11.2）。
8. **專案只負責相容與支援**：provider 能用的認證方式（含訂閱帳號登入）uniqlaw 都支援，
   要用哪一種、是否符合該服務條款，由使用者自行負責；uniqlaw 不替使用者做政策判斷。

**非目標（第一版）**

- 不在 provider 之間做對話歷史的即時互轉（換 provider = 開新 session，可選擇注入摘要）。
- 不自己做 sandbox。安全邊界交給 provider 的權限機制、我們的 tool gate，以及 OS/容器。

---

## 2. 總覽

```
 Platforms (plugin)          Core                                   Providers (plugin)
┌──────────────┐   ┌────────────────────────────────────────┐   ┌──────────────────────┐
│ telegram     │──►│ Ingress ─► Router ─► Session Manager   │──►│ claude-sdk / -tmux   │
│ discord      │   │   (allowlist,        (per-session      │   │ codex   (app-server) │
│ slack        │◄──│    origin tag)        state machine,   │◄──│ opencode (HTTP/SSE)  │
│ line         │   │                       queue/steer)     │   │ acp / agy            │
│ web / cli    │   │ Egress ◄─ Output Pipeline              │   │ pi      (LLM APIs)   │
└──────────────┘   │   (NO_REPLY, react, segmenting)        │   └──────────┬───────────┘
                   │                                        │              │ tool calls
 Schedulers        │ Message Bus (A2A-shaped) ◄─────────────┼──────────────┘
┌──────────────┐   │   local peers / remote A2A peers       │   via MCP Gateway
│ cron         │──►│ Approval Broker   State Store          │   (per-session token)
│ heartbeat    │   └───────────────┬────────────────────────┘
└──────────────┘                   │
                         ┌─────────▼─────────┐
                         │ A2A transport     │◄──► remote A2A agents
                         │ (server + client) │
                         └───────────────────┘
```

核心原則有兩條：**core 只認 normalized event 和 origin tag**、**所有 agent 可呼叫的功能都走
MCP Gateway**。這兩條讓功能跟 provider 脫鉤。

---

## 3. Plugin 模型

所有 plugin 共用同一個外殼：

```ts
interface PluginDef<K extends PluginKind, Cfg> {
  kind: K;                       // "provider" | "platform" | "scheduler" | "transport" | "tool"
  name: string;                  // "claude", "telegram", "cron", "a2a", ...
  configSchema: Schema<Cfg>;     // valibot/zod，daemon 啟動時驗證
  create(ctx: PluginContext, cfg: Cfg): Promise<PluginInstance<K>>;
}

interface PluginContext {
  log: Logger;
  state: StateStore;             // namespaced KV + jsonl
  bus: BusClient;                // 發/收 envelope
  events: EventEmitter;          // core lifecycle events
}

interface PluginInstanceBase { start(): Promise<void>; stop(): Promise<void>; health(): Health; }
```

| kind | 職責 | 第一版實作 |
|---|---|---|
| `provider` | 跑 agent turn，輸出 normalized events | claude, codex, opencode, acp, pi |
| `platform` | 收發聊天訊息、reaction、附件、互動按鈕 | telegram, discord, slack, line, web |
| `scheduler` | 定時產生 synthetic turn | cron, heartbeat |
| `transport` | 把 bus 接到外部 | a2a（server + client） |
| `tool` | 在 MCP Gateway 加新工具 | bus, cron-admin, platform-send, react |

Plugin 就是 npm package（或 workspace package），`export default definePlugin({...})`。
settings 用 `plugins: { "<name>": { enabled, ...cfg } }` 啟用。

---

## 4. Core 概念

| 概念 | 說明 |
|---|---|
| **Agent Profile** | 具名設定：provider + model + system prompt 組件 + 權限 + 工具集。例如 `main`（claude/opus）、`cheap`（pi/gemini-flash）、`coder`（codex）。 |
| **Channel** | 平台上的一個對話端點（`telegram:<chatId>`、`discord:<channelId>`、`slack:<ch>:<ts>`）。**每個私訊也是自己的 channel**（`telegram:<userId>`、`discord:dm:<userId>`、`slack:dm:<userId>`、`line:<userId>`），不再像 v2 收斂到 `global`（§13 #10）。 |
| **內部 session** | 沒有綁 chat 的 session，名稱不是任何平台能解析的 key：`heartbeat`、`cron:<job>`、`global`…。由排程或 bus 建立，沒有人直接在看；要對人說話就用 `notify` / `agent_trigger`（§8.5）。 |
| **Binding** | channel → profile 的對應（可在 settings 依 channel 覆寫）。同一個 daemon 裡，不同 channel 可以跑不同 provider。 |
| **Session** | 一個 profile 在一個 channel 上的長期對話，對應 provider 的 session/thread id。A2A `contextId` = session id。 |
| **Turn** | 一次送進 agent 到 turn 結束。A2A `taskId` ≈ turn id。 |
| **Origin** | 每段 input 都帶來源標記（見下）。**輸出要送去哪，只看 origin，不看 provider 吐出的文字內容。** |

```ts
type Origin =
  | { kind: "human";     platform: string; channel: string; sender: Sender; replyTo: MsgRef }
  | { kind: "peer";      from: SessionRef; hop: number; replyMode: "to-sender" | "to-own-human" }
  | { kind: "scheduler"; job: string; deliverTo?: Target }
  | { kind: "a2a";       remote: AgentRef; taskId: string; hop: number }
  | { kind: "system";    reason: "resume" | "compact" | "background" };
```

v2 靠偵測 `<cross-session-message>` 這類文字 wrapper 來抑制平台輸出。uniqlaw 改成 core
在送出 turn 時就知道 origin，決定權完全在 core 手上。

---

## 5. Provider 介面

```ts
interface ProviderCapabilities {
  streaming: "token" | "segment" | "final";  // 輸出粒度
  interrupt: boolean;                        // 能中止進行中的 turn
  steer: boolean;                            // turn 中途插入（插在當前 tool 呼叫之後）
  // turn 邊界排隊永遠由 core 做（provider 原生 queue 只是可選最佳化），所以不列為能力
  resume: "native" | "core-managed";         // 誰負責保存對話歷史
  denyEndsTurn: boolean;                     // 拒絕權限是否結束整個 turn（claude-tmux=true）
  modelSwitch: "live" | "spawn" | false;
  permissionCallback: boolean;               // tool 需要核准時會問我們
  mcp: "per-session" | "per-process" | false; // per-session 必須通過「跨 session MCP 隔離」合約測試才算
  nativeTools: boolean;                      // 可直接註冊 in-process tool（不用走 MCP）
  attachments: ("image" | "file" | "audio")[];
  slashCommands: boolean;                    // provider 自己有 /command 系統
}

interface AgentProvider {
  readonly name: string;
  capabilities(profile: Profile): ProviderCapabilities;
  open(spec: SessionSpec): Promise<AgentSession>;   // 新建或 resume
}

interface SessionSpec {
  sessionId: string;              // uniqlaw 的 id
  providerSessionId?: string;     // resume 時用
  cwd: string;
  profile: Profile;
  systemPrompt: SystemPromptParts;
  mcp: { url: string; token: string };         // MCP Gateway endpoint（per-session token）
  nativeTools?: ToolDef[];                     // nativeTools=true 時直接給
  history?: NormalizedMessage[];               // resume=core-managed 時給
}

interface AgentSession {
  // M1：detach?() — daemon 停止時只放手不殺 provider process（claude-tmux 保留 tmux，重啟後 open() 重新接回）
  send(input: TurnInput): Promise<void>;       // idle 時開新 turn
  steer?(input: TurnInput): Promise<void>;     // steer=true 才有；turn 剛結束的競態下 adapter 自行改用 send
  interrupt?(): Promise<void>;
  setModel?(model: string): Promise<void>;
  respondPermission?(id: string, decision: PermissionDecision): Promise<void>;
  events: AsyncIterable<AgentEvent>;
  close(): Promise<void>;
}

type AgentEvent =
  | { type: "session"; providerSessionId: string }
  | { type: "turn_start"; turnId: string }
  | { type: "text"; delta?: string; final?: string; segmentId: string }
  | { type: "thinking"; text: string }
  | { type: "tool_start"; id: string; name: string; input: unknown }
  | { type: "tool_end"; id: string; ok: boolean; summary?: string }
  | { type: "permission_request"; id: string; tool: string; input: unknown; title: string }
  | { type: "input_request"; id: string; schema: unknown; title: string }   // ACP elicitation、MCP elicitation
  | { type: "turn_end"; turnId: string; reason: "done" | "interrupted" | "error"; usage?: Usage }
  | { type: "unsolicited_turn" }                 // agent 自己醒來（背景任務、wakeup）
  | { type: "error"; error: string; fatal: boolean };
```

### 5.1 Adapter 一覽（根據 2026-11 的調查）

| adapter | 控制介面 | 套件 | 備註（M0 實測） |
|---|---|---|---|
| **claude-sdk** | Claude Agent SDK `query()`，streaming-input 模式 | `@anthropic-ai/claude-agent-sdk` 0.3.x | 見 §5.2 |
| **claude-tmux** | 真正的 `claude` TUI 跑在 tmux 裡（移植 v2） | 無（tmux + jsonl tail + pane 偵測） | 見 §5.2 |
| **codex** | `codex app-server`（stdio JSON-RPC） | 直接講協定，型別用 `codex app-server generate-ts` 產生（`@openai/codex-sdk` 缺 steer/approval） | `turn/steer {threadId, expectedTurnId, input}` 是真正的 steer（閒置時回 `-32600` → 改用 `turn/start`）；權限是 server→client request（`item/*/requestApproval`）；MCP 在 `thread/start.config.mcp_servers`，per-session，要設 `default_tools_approval_mode`；model 用 `turn/start.model`（之後的 turn 沿用）。**必須關 `memories`**（跨 thread 共用記憶）；`agent_message_board` / `wake_on_agent_messages` 正式推出後也要強制關。 |
| **opencode** | `opencode serve` HTTP + SSE `/event` | `@opencode-ai/sdk` 1.19 | `prompt_async` 在 busy 時 = steer（下一個 step 邊界收進去）；`permission.asked` + `/permission/:id/reply`；model 每則訊息指定；turn 結束看 `session.idle`，但 abort 後要丟掉重複的 idle。**MCP 是整個 instance 共用 → 一個 session 一個 serve**。bash 工具的 cwd 是 git worktree 根目錄，不是 `directory` 參數。 |
| **acp**（通用） | ACP stdio JSON-RPC | `@agentclientprotocol/sdk` 2.2 | 實測 `opencode acp` 通過。協定沒有 steer，但併發 `session/prompt` 的行為由 agent 決定（opencode 是 steer）→ 預設 `steer=false`，合約測試通過才升級。model 用 `session/set_config_option`。`session/load` 會**重播歷史**，adapter 必須抑制。**協定說 MCP per-session，但 opencode 實作是 process 共用，會身分外洩 → 一律一個 session 一個 process**。Gemini CLI 已被 Antigravity CLI 取代，**不列為支援目標**（Google 的 coding agent 一律走 agy adapter）。 |
| **agy**（Antigravity CLI，Google 官方，取代 Gemini CLI） | `agy --input-format stream-json --output-format stream-json -p=`（官方 headless） | 無 | 一個 process = 一個對話。stdin 沒有控制通道 → interrupt = SIGINT + `--conversation` 重開、換 model = 重開、中途訊息只能排隊。**沒有權限 callback**：headless 預設自動拒絕，只能用 `--settings permissions.allow` 預先放行（規則要完整指令或 `*`）。MCP 只能在 cwd 放 `.agents/mcp_config.json` → 用 stdio shim（見 §8.3）。`--remote-control` 尚未研究，可能可以拿到權限 callback。 |
| **pi**（自建 harness） | `@earendil-works/pi-coding-agent` SDK（`createAgentSession()`，in-process） | 1.4.0（scope 已從 `@mariozechner` 搬到 `@earendil-works`） | 機制全部驗證過（用 faux provider，真模型待憑證）：`tool_call` hook 可非同步等核准、出錯預設擋下，內建 / native / MCP 工具都會經過；`steer()` / `followUp()` / `abort()` / `setModel()`；`registerMcpServer()` per-session；native tool；session JSONL 目錄由我們決定。**必須傳 `resolveProjectTrust`**（沒傳會預設載入 `.pi/` 受保護資源），**必須設 `PI_CODING_AGENT_DIR`** 隔離（MCP OAuth store 不吃傳入的 agentDir）。 |

各 adapter 實測的能力值（§5 格式）：

| adapter | streaming | interrupt | steer | resume | denyEndsTurn | modelSwitch | permissionCallback | mcp | nativeTools | slashCommands |
|---|---|---|---|---|---|---|---|---|---|---|
| claude-sdk | token | ✅ | ✅ | native | ❌ | live | ✅ | per-session | ✅ | ✅ |
| claude-tmux | segment | ✅ | ✅ | native | ✅ | live（`/model` + dialog） | ✅（pane 偵測） | per-session（per-process） | ❌ | ✅ |
| codex | token | ✅ | ✅ | native | ❌ | live（per turn） | ✅ | per-session | ❓ | ❌ |
| opencode | token | ✅ | ✅ | native | ❌ | live（per message） | ✅ | per-process | ❌ | ✅ |
| acp（保守預設） | token | ✅ | ❌（實測升級） | native（loadSession） | ❌ | live（若有 model config option） | ✅ | per-process | ❌ | ✅ |
| agy | token | ✅（SIGINT + 重開，較慢） | ❌ | native | n/a | spawn | ❌ | per-process（shim） | ❌ | ✅ |
| pi | token | ✅ | ✅ | native | ❌ | live | ✅ | per-session | ✅ | ✅ |

`resume: "core-managed"` 目前沒有 adapter 需要（pi 自己存 JSONL），保留給未來純 LLM API 的極簡 adapter。

### 5.2 Claude 的兩個 adapter：`claude-sdk` 與 `claude-tmux`

兩個都做，共用一個 `claude-common` 套件：system prompt 組合、權限 policy 轉換成 CLI flag、
jsonl parser、session id 管理、停用 `ListAgents` / `SendMessage`。

| 能力 | claude-sdk | claude-tmux |
|---|---|---|
| streaming | `token`（`--include-partial-messages`） | `segment`（jsonl 在 tool / end_turn 邊界才 flush） |
| interrupt | `q.interrupt()` | `send-keys Escape` |
| steer | ✅ 每則訊息可選 `priority`：`next` = steer、`later` = 排到 turn 後、`now` = 中斷後立刻跑 | ✅ busy 時貼上 = `queued_command`，在 turn 中途送進去（v2 的 `native` 模式其實一直是 steer） |
| 拒絕權限 | 只有該 tool 呼叫失敗，turn 繼續 | **整個 turn 結束**（`denyEndsTurn`） |
| resume | native（`resume: id`） | native（`--resume <id>`） |
| modelSwitch | `live`（`setModel`） | `live`（打 `/model`，可能跳出 model-switch dialog，由 pane 偵測處理） |
| permissionCallback | `canUseTool` | pane 偵測 permission dialog → 由 adapter 轉成 `permission_request` event；回覆時再送按鍵 |
| mcp（bus 工具） | in-process SDK MCP server | `--mcp-config` 指向 MCP Gateway URL + per-session token |
| slashCommands | ✅ 當 prompt 送出即可（實測 13 plugins、134 skills、188 commands 全載入，user hooks 會觸發） | 完整（TUI 原生，包括 plugin commands） |
| 特有負擔 | 無 TUI | init-watch、login / survey / folder-trust / model-switch dialog 偵測，全部封裝在 adapter 裡；v2 的 busy regex 已對不上新版 spinner，要更新 |

**session 互通（M0 實測 ✅）**：tmux 開的 session 用 SDK `resume` 接得回來，反過來也行，
歷史都在。所以 Claude 用哪種 adapter 只是 profile 設定。注意：jsonl 要用
`~/.claude/projects/*/<id>.jsonl` 依 id 找，不能從 cwd 推算（在別的 cwd resume 會續寫原檔）；
jsonl 可能很大（含 `api-request-blob`），tail 不能從頭讀。

**Claude adapter 共通規則（M0 發現）**：
- **一定要明確指定 `permissionMode`**。使用者全域設定可能是 `defaultMode: "auto"`，沒指定會由分類器直接放行，跳過我們的核准。
- **bus 工具會被延遲載入**（藏在 ToolSearch 後面）→ 設 always-load，或在 system prompt 直接寫出工具名稱。
- **原生訊息 socket（未解決風險）**：`disallowedTools` 拿掉了 `ListAgents` / `SendMessage`，但互動模式（tmux）與 SDK 模式仍會開 `messaging_socket_path`（`-p` 模式不會）。M1 實測：執行檔有 `CLAUDE_CODE_MESSAGING_SOCKET` / `CLAUDE_CODE_MESSAGING_TOKEN`，設定後 `-p` init 無變化，互動模式未驗證；找不到公開的關閉開關（`disableMessagingBeyondOwnAgents` 是內部 API）。**後果**：本機其他 Claude session 可以把訊息送進 uniqlaw session，那個 turn 沒有 origin，會被 core 當成背景輸出，依 `backgroundNotify` 送到最後的聊天對象（可能讓外部內容出現在使用者的聊天裡）。**緩解方向**（M1.5 驗證）：每個實例用獨立的 `CLAUDE_CONFIG_DIR`（peer 探索可能以設定目錄為範圍）；或把來源不明的 unsolicited turn 改成只送 operator。
- **user hooks 會跨 session 帶 context**（例如 claude-mem 在同一個 cwd 注入上次的內容）→ profile 可選：每個 channel 獨立 cwd，或 `settingSources` 不含 `user`。
- **認證**：兩個 adapter 都支援 Claude Code 能用的所有方式：claude.ai 訂閱登入（`CLAUDE_CONFIG_DIR` 內的 OAuth）、`ANTHROPIC_API_KEY`、Bedrock（`CLAUDE_CODE_USE_BEDROCK`）、Vertex（`CLAUDE_CODE_USE_VERTEX`）、Azure AI Foundry（`CLAUDE_CODE_USE_FOUNDRY`）。用哪一種由使用者決定、自行負責（目標 8）；README 註明相關服務條款連結即可。

**停用 provider 原生的跨 session 工具（強制規則）**：每個 adapter 都必須關掉 provider 自帶的跨 session 工具（claude → `disallowedTools: ["ListAgents","SendMessage"]` 加上關閉訊息 socket；codex → 關 `memories`，未來的 `agent_message_board` / `wake_on_agent_messages` 也要關）。否則 agent 會繞過 bus，產生沒有 origin 的 turn，§8.4 的路由和輸出抑制就失效（等於 v2 要靠 `<cross-session-message>` 嗅探的老問題又回來）。合約測試要驗證這點。

**自建 harness 的決定：基於 `pi-coding-agent` SDK，不從 `pi-agent-core` 從頭寫。**
pi-coding-agent 已經有 file/bash 工具、skills、MCP、session 持久化、compaction 和
slash commands。我們只要補：
(a) 把 `tool_call` hook 接到 Approval Broker，
(b) 系統提示組合，
(c) 把 bus 工具註冊成 native tool。
這是整個專案最大的工作量槓桿，可以省掉幾千行 harness 程式碼。

---

## 6. Capability polyfill（換 provider 不少功能的核心）

| 能力缺失 | core 的處理 | 使用者可感知的差異 |
|---|---|---|
| `steer = false`（agy、未驗證的 ACP agent） | 只能用 `queue` 模式：debounce + 合併 + cap/dropPolicy | `steer` 模式不可選，設定時直接報錯（不默默改掉） |
| `steer = true`（其他全部） | 可選 `steer`（插到當前 tool 呼叫後）或 `queue`（core 排到 turn 結束後） | v2 的 `native` 模式改名為 `steer` |
| `interrupt` 很慢（agy：SIGINT + 重開） | 照常提供，UI 顯示「中斷中」 | 中斷要多等一下 |
| `interrupt = false` | `interrupt` 模式不可選；`/stop` 回覆「此 provider 不支援中斷」 | 明確報錯 |
| `permissionCallback = false`（agy） | 用 PermissionPolicy 產生預先放行清單；被拒的動作事後回報給 operator | 無法逐次核准，設定驗證時警告 |
| `denyEndsTurn = true`（claude-tmux） | 拒絕後 core 自動補一個 turn，告訴 agent「該操作被拒，請改用其他方法」 | 回覆會分成兩段 |
| `resume = "core-managed"` | core 保存 normalized history，open 時交給 adapter | 無 |
| `resume` 會重播歷史（ACP `session/load`） | adapter 在 load 完成前抑制所有事件 | 無 |
| `modelSwitch = "spawn"`（agy） | model router 只在 session 開啟時生效；live 切換改成「重開 session + resume」 | 切換會丟 prompt cache |
| `mcp = "per-process"`（opencode、acp、agy） | 每個 session 一個 provider process，確保 token 綁定身分 | 資源用量較高 |
| `mcp = false` 且 `nativeTools = false` | 退回文字協定：`[react:🌸]`、`[send:target]…` 這類 marker，由 Output Pipeline 解析 | 功能保留，可靠度較低 |
| `slashCommands = false`（codex） | core 自己實作 `/model /stop /new /status`；provider 的 command 不會註冊到平台 | 只少了 provider 私有的 command |

**M1 實作補充：**
- `turn_end.error` 可帶型別化代碼：`rate_limit`（可重試）、`usage_limit`、`stall`、`auth`、`crash`；core 之後依此做跨 provider 一致的自動重試。
- 憑證由 **adapter** 轉成 provider 專用的 env / 設定；core 給的 `spec.env` 只有基本環境變數，**絕不**預先放憑證。
- TUI 型 provider 的 `permission_request.input` 是對話框原文，core 用 `cleanDialogText()` 去掉分隔線和提示後再顯示；UI 不可依賴結構化 input。
- 權限對話框開著時，steer 訊息由 adapter 暫存，對話框結束後才送。
- `queue.mode` 的值是 `queue | steer | interrupt`（v2 的 `native` 遷移成 `steer`）。

**規則：** settings 驗證時，用 profile 的 capabilities 檢查所有被要求的功能。
做不到就**啟動失敗並說明原因**，不在執行期才默默降級。

---

## 7. v2 功能對照

| v2 功能 | uniqlaw 歸屬 | 怎麼做到 provider 無關 |
|---|---|---|
| 多平台（TG/DC/Slack/LINE） | platform plugin | 不變，介面抽出來 |
| DM 收斂 global、per-channel/thread session | platform 給 key，core Router | 群組 / 頻道 / thread 沿用 v2 規則；**DM 改成每個人各自一個 session**（§13 #10） |
| queue / native / interrupt 模式 | core Session Manager | 改為 queue / steer / interrupt（native 實為 steer），依 §6 polyfill；遷移時 `native` → `steer` |
| Permission 核准（inline 按鈕） | core Approval Broker | 來源統一成 `permission_request` event，或 pi 的 `tool_call` hook；以前是 tmux pane 偵測，現在不需要 |
| login / survey / model-switch dialog | claude-tmux adapter 內部 | 只存在 tmux adapter 內；對 core 統一為 `permission_request` 或 `error{auth}` → 通知 operator |
| `NO_REPLY` / `HEARTBEAT_OK` 靜默 | core Output Pipeline | 對所有 adapter 的 final text 做一樣的後處理（直接搬 v2 `silent.ts`） |
| `[react:🌸]` reaction | `react` MCP tool 為主，text marker 為 fallback | |
| tool 進度顯示（tool-display） | core，吃 `tool_start/end` | |
| messageStream replace/keep/off | core Egress + platform 能力 | 依 `streaming` 粒度決定能不能 live edit |
| Cron（.md frontmatter） | scheduler plugin + `cron-admin` MCP tool | 同時解掉 v2 TODO「cron MCP tools」 |
| Heartbeat + quiet hours | scheduler plugin | origin=scheduler，結果經 Output Pipeline |
| 模型路由（agentic modes + hysteresis） | core，呼叫 `setModel` | 依 `modelSwitch` polyfill |
| backgroundNotify（agent 自己醒來的輸出） | core，吃 `unsolicited_turn` | |
| 跨 session send / trigger / SendMessage | core Message Bus + MCP tools | §8 |
| 附件下載 + prompt 前綴 | core（下載）+ adapter（有 image 能力就原生傳） | |
| slash command 註冊到平台 | core 的 commands + provider 有 `slashCommands` 時一併列出 | |
| 閒置 session 清理 | core | close session、保留 id，下次 resume |
| system prompt 組合（IDENTITY/USER/SOUL、dir scope、NO_REPLY rules） | core `SystemPromptParts` → adapter 決定怎麼注入（append flag / system message / AGENTS.md） | |
| Web dashboard + HTTP API | `web` platform plugin + core API | |
| statusline / state.json | core | |
| v1→v2 migrate | agent 照 `docs/MIGRATE.md` 做（見 §11.1） | v2 → uniqlaw 完整遷移 |

---

## 8. 跨 session 通訊：Message Bus

### 8.1 決定：自建 bus，不使用 provider 原生機制

- Claude 的 `SendMessage`、Codex/OpenCode 各自的 subagent 都是**私有且不互通**的。只要某個
  功能依賴其中一種，換 provider 就沒了，這違反目標 3。
- 所有 coding agent 都支援 MCP，pi 可直接註冊 native tool → **一份 bus 工具可以覆蓋全部
  provider**。
- 自建才能做統一的 origin 路由、hop 限制、稽核 log，以及 A2A 對外。
- provider 原生的 subagent（例如 Claude 的 Task tool）仍然可以用。那是 session **內部**
  的事，不屬於跨 session 通訊，bus 不干涉。

### 8.2 Envelope（A2A 形狀）

```ts
interface Envelope {
  id: string;
  contextId: string;          // 目標 session（A2A contextId）
  taskId?: string;            // 對應 turn（A2A taskId）
  from: AgentRef;             // local:<sessionKey> | a2a:<agentCardUrl>
  to: AgentRef;
  parts: Part[];              // A2A Part：text | file | data
  mode: "ask" | "trigger" | "notify";
  hop: number;                // 每轉一手 +1，超過 maxHops 就拒收
  metadata?: Record<string, unknown>;
}
```

### 8.3 給 agent 的工具（MCP Gateway）

| 工具 | 語意 | 對應 v2 |
|---|---|---|
| `agents_list()` | 列出本地 session 和已設定的遠端 A2A agent（名稱、profile、狀態、能力） | `ListAgents` |
| `agent_ask(to, message, wait?)` | 對方跑一個 turn，**回覆送回給你**；對方的輸出不上平台 | 原生 `SendMessage` |
| `agent_trigger(to, prompt)` | 對方跑一個 turn，**回覆給它自己的 human** | `/api/trigger` |
| `notify(target, text)` | 直接用平台 API 發你寫好的文字給 human，並寫入擁有該 target 的 session 的 pending-input 佇列（state.db），讓它下次跑時知道 | `/api/send` |
| `task_status(taskId)` / `task_cancel(taskId)` | 查詢或取消 `agent_ask` 發出去的工作 | — |

`agent_ask` 的回覆方式：
- `wait=true`：tool 一直 block 到對方 turn 結束，再回傳結果。適合短任務；有 timeout。
- `wait=false`：馬上回傳 `taskId`。對方完成後，core 在你的 session 開一個
  `origin=peer` 的 turn，把結果送進來；如果你正在跑，就依 steer 能力處理。
  這樣做不依賴任何 provider 的「背景通知」功能。

**身分綁定：** MCP Gateway 的 URL 帶 per-session token（`/mcp/<token>`）。工具不接受
「我是誰」這類參數，呼叫者身分由 token 決定，agent 無法冒充其他 session。
只能用檔案設定 MCP、又不展開環境變數的 provider（agy），改用 **stdio shim**：設定檔指向
`uniqlaw mcp-shim`，shim 從繼承的環境變數 `UNIQLAW_TOKEN` 取得身分，再轉接到 Gateway。
合約測試一定要包含「兩個 session 同時掛 MCP，各自只看得到、只呼叫得到自己的 token」。

**防迴圈：** `hop` 上限（預設 4），並對同一對 session 在短時間內來回做 rate limit。
`origin=peer` 的 turn 系統提示會注入「回一次就停」。

### 8.4 輸出路由（core 根據 origin 決定）

| turn 的 origin | text 輸出送到 | permission request 送到 |
|---|---|---|
| human | 該 channel（reply 到觸發訊息） | 該 channel 的可信 operator |
| peer / ask | 回給發問者（作為 task result） | 發起鏈最源頭的 human channel，否則送 operator |
| peer / trigger | 被觸發 session 自己的 channel | 同上 |
| scheduler | job / heartbeat 的 `replyTo`；`"none"` = 不送（agent 自己用工具送）；沒設就照 `backgroundNotify` | operator |
| a2a | A2A task artifact | operator（task 維持 WORKING；被拒則 FAILED） |
| 合併 turn（多個 origin） | 只要含 human，就送該 human channel；其餘 origin 收到 task result | — |

### 8.5 內部 session、排程的 session / profile / model

- **Session 種類**：`agents_list` 每筆都有 `kind`：`chat`（名稱就是 notify / trigger 的 target）、`internal`（沒有 chat）、`a2a`（服務遠端 A2A 呼叫）、`remote`（遠端 A2A agent）。內部 session 的 system prompt 會多一段說明：你沒有自己的 chat，要對人說話用 `notify` / `agent_trigger`，要問別的 session 用 `agent_ask`。
- **bus 可以到達的對象**：已存在的 session（chat、內部、A2A），以及平台能解析的 chat key（第一次觸發時才建立）。**拼錯的內部名稱不會被建立**，避免 agent 打錯字就多開一個 session。
- **排程跑在哪個 session**：heartbeat 預設跑在自己的內部 session `heartbeat`；cron job 檔沒寫 `target` 時跑在 `cron:<job>`；`cron_save` 預設是呼叫者自己，`target: "own"` 是 `cron:<name>`。也可以指定任何 chat key（例如在某個私訊裡跑，就有那段對話的 context）。
- **profile**（heartbeat 的 `profile`、job frontmatter 的 `profile:`）：把那個 session 固定在某個 profile（provider + model + 權限），存在 `state.db` 的 kv（`session-profile:<key>`），重啟後也保留。session 閒置時換 profile 會重開；忙碌中就等它下次關閉。也可以直接在 `bindings.channels` 綁（`"heartbeat": "cheap"`），效果一樣。優先順序：A2A 指定 > 排程固定 > `bindings.channels` > `bindings.default`。
- **model**（heartbeat 的 `model`、job 的 `model:`）：只對那一個排程 turn 生效。需要 provider 支援 live 換 model（`modelSwitch: "live"`）；下一個不帶 model 的 turn 開始前會換回原本的 model（profile 沒設 model、只用 provider 預設值時沒辦法換回，會寫 warning）。不支援 live 換 model 的 provider（agy、部分 ACP）請改用 `profile`。
- **跨 session**：每個 session（含內部）都有自己的 MCP Gateway token，所以 heartbeat / cron 都可以 `agent_ask` 別的 session、`agent_trigger` 讓某個私訊 / 群組的 session 用自己的 context 跟它的人說話，或直接 `notify` 任何 chat target。

### 8.6 Worker：指揮同一台機器上的其他 coding agent

任何 session 都可以用 `worker_start` 在指定目錄開一個 coding agent（Claude Code、Codex、OpenCode…，就是某個 profile），把工作交給它。之後用一般的 `agent_ask` 跟它溝通。人類可以從聊天室或終端機接管它。

- **身分**：worker 是 session key `worker:<name>`（`agents_list` 的 `kind: "worker"`，附 `cwd`、`owner`、`heldBy`）。建立時記錄在 kv：`worker-meta:<key>`、`session-cwd:<key>`、`session-profile:<key>`。**工作目錄建立後就固定**：claude-tmux 用 cwd 找 jsonl，codex 用 cwd 算 sandbox，resume 時 cwd 不能變。要換目錄就開新的 worker。
- **工作目錄**：`SessionSpec.cwd` 本來就有，各 provider 也都照用，只是以前 core 一律傳專案目錄。現在改成 `host.cwdFor(key)`，沒設定時才用專案目錄。
- **限制**（`settings.workers`）：`roots`（允許的目錄和其子目錄，比對 realpath，`..` 和 symlink 都先解析；空陣列 = 只能用專案目錄）、`profiles`（允許的 profile，空陣列 = 全部）、`max`（預設 8）。能呼叫 `worker_start` 的 session，系統提示會多一段 `workers`：列出允許的目錄和 profile，並說明「派到你自己範圍外的目錄是允許的，由 UniQlaw 負責檢查」。實測發現少了這段，主 agent 會因為自己的 dir-scope 提示拒絕派工。
- **worker 的系統提示**：不載入 IDENTITY / USER / SOUL（那是聊天助理的人設），改加 `worker-session` 段落：你在哪個目錄、任務是誰派的、回覆會送回給它、結尾要報告改了什麼和怎麼驗證的。dir-scope 改成以 worker 的 cwd 為準。目標目錄本身的 CLAUDE.md / AGENTS.md 由 provider 照常載入。
- **回報**：`worker_start` 帶 `task` 時走 `agent_ask` 的語意，預設 `wait:false`，worker 做完時結果會以新訊息的形式送回派工的 session。worker 的權限請求照 §8.4 送到這條委派鏈最上層的人。worker 的背景輸出（例如人類在終端機裡打字觸發的 turn）**不走** backgroundNotify：有聊天室 attach 時送到那個聊天室，沒有就只留在 transcript。
- **人類接管**，有兩種：
  - **聊天室**（所有 provider 都能用）：可信任的使用者在聊天室打 `/attach <worker>`，之後這個聊天室的訊息改送給 worker，回覆和權限請求也回到這裡；`/stop`、`/new`、`/model`、`/status` 都作用在 worker 上。`/detach` 結束接管。`/attach` 不帶參數會列出所有 worker。這個綁定存在 kv（`chat-attach:<chatKey>`），重啟後仍有效。
  - **終端機**（`uniqlaw attach <worker>`，provider 要實作 `attachCommand`）：
    - claude-tmux 是 **live** 接管：直接 `tmux -L uniqlaw-<instanceId> attach-session -t uq-…`，agent 繼續跑，daemon 也繼續監看。
    - claude-sdk / codex 是 **handoff**：core 先關掉 session（保留 provider session id），CLI 在 worker 目錄執行 `claude --resume <id>` / `codex resume <id>`。人類離開那個 CLI 後交還 daemon，下一個任務會 resume 同一段對話，包含人類在 CLI 裡做的事。只支援預設登入或 `provider-login` 的 home（會帶 `CLAUDE_CONFIG_DIR` / `CODEX_HOME`）；API key 類的憑證不交出 secret，所以不支援。
    - 其他 provider 沒有終端機接管，請用聊天室 attach。聊天 session 只能 live attach，handoff 只限 worker。
    - 驗證狀態（2026-11-08，`packages/daemon/test/workers-e2e.test.ts`，真 Claude）：claude-tmux 的 live attach 目標確實是那個 worker 的 tmux session，而且 pane 在 worker 目錄。claude-sdk handoff 期間人類用 `claude --resume <id> -p …` 交代的事，daemon 接回後 worker 記得。**codex handoff 只用 fake 測過**：`thread/unsubscribe` 之後，同一個還活著的 app-server 再 `thread/resume`，能不能讀到別的程序寫進 rollout 的內容，還沒驗證。
  - 接管狀態存在 kv（`hold:<key>`）。daemon 重啟時不會 restore 仍在 handoff 中的 session；排程、async 結果、無 task 的 `worker_start` 也都不會在接管期間重新打開它（async 結果會改放進 worker 的待讀訊息）。終端機被關掉、沒有正常交還時，用 `uniqlaw release <worker>` 解除。
  - 接管期間 worker 處於 **held** 狀態：owner 再 `agent_ask` / `agent_trigger` 會收到「有人在操作，等他離開」的錯誤，不會把指令插進人類的對話。人類離開時，owner 會收到一則待讀通知：「有人操作過 worker，可能改了檔案或給了新指示」。
- **停止**：`worker_stop(name)` 關掉 agent 程序，但保留對話，同名 `worker_start` 會接著做。`forget: true` 會刪掉紀錄和對話。worker 改過的檔案一律不動。
- **CLI / API**：`uniqlaw workers`、`uniqlaw worker start|stop`、`uniqlaw attach`、`uniqlaw release`；`GET/POST /api/workers`、`POST /api/takeover`、`POST /api/release`。

---

## 9. A2A

- **SDK**：`@a2a-js/sdk` 1.3（實作 A2A v1.0，可選擇相容 v0.3）。三種 transport 都提供：
  JSON-RPC、REST、gRPC。README 寫的「gRPC Node-only」意思是「不能在 Workers / 瀏覽器跑」，
  不是「Bun 不行」。已在 Bun 1.3.4 實測 `@grpc/grpc-js` server + `GrpcTransportFactory`
  client，`SendMessage` 和 `SendStreamingMessage` 都能通。Agent Card 位置：`/.well-known/agent-card.json`（已在 SDK 原始碼確認）。
- **對外公開什麼**：以 **Agent Profile** 為單位公開（每個 profile 一張 Agent Card），不公開
  每個聊天 channel。遠端呼叫時，`contextId` 對應到一個 `a2a:<remote>:<contextId>` session
  （隔離，不會混進人類的對話）。
- **內外同構**：bus 內部本來就用 Envelope（A2A 形狀）。本地的 `agent_ask` 就是一次在 process
  內短路的 A2A `SendMessage`；目標是遠端時改走 HTTP。對 agent 來說兩者用法完全一樣。

| bus | A2A v1.0 |
|---|---|
| `agent_ask` | `SendMessage` / `SendStreamingMessage`（task result → 呼叫者） |
| `agent_trigger` | `SendMessage` + extension metadata `uniqlaw.deliver = "own-human"`（A2A 沒有這個概念，用 extension 表示；只在 uniqlaw↔uniqlaw 之間有效） |
| `task_status` / `task_cancel` | `GetTask` / `CancelTask` |
| 非同步回推 | `SubscribeToTask` 或 push notification config |
| turn 狀態 | SUBMITTED → WORKING → COMPLETED / FAILED / CANCELED；需要人類補資訊 → INPUT_REQUIRED |

- **安全**：A2A server 預設只綁 127.0.0.1。對外要有 auth（bearer / mTLS，寫在 Agent Card 的
  securitySchemes），而且外部 agent 只能用設定指定的 profile。這些 profile 預設是嚴格權限。

---

## 10. 權限與安全

統一的權限模型，由 adapter 翻譯成各 provider 的設定：

```ts
interface PermissionPolicy {
  level: "locked" | "strict" | "moderate" | "unrestricted";  // 沿用 v2
  allowTools: string[]; denyTools: string[];
  approval: { mode: "auto-deny" | "ask-operator" | "auto-allow"; timeoutSec: number };
  dirScope?: string[];
}
```

- claude → `allowedTools` / `disallowedTools` / `permissionMode` / `canUseTool`
- codex → approval policy + sandbox mode + `requestApproval` 回覆
- opencode / acp → permission 設定 + `request_permission` 回覆
- pi → `tool_call` hook（我們自己的 gate，fail-closed）

Approval Broker 接收所有 `permission_request`，依 §8.4 找到 operator，發 inline 按鈕，
timeout 就拒絕。

### 10.2 設定分層：繼承 + 覆蓋（§13 #9）

```
provider 自己的全域設定（使用者層級：settings、hooks、plugins、skills、MCP、登入）   ← 繼承
        ↓ 被覆蓋
agent 專案目錄的設定（cwd 底下的 .claude/、.codex/、opencode.json、.pi/ …）
        ↓ 被覆蓋
UniQlaw 每次啟動時給的 CLI 參數 / 注入設定                                         ← 強制
```

| provider | 繼承來源 | UniQlaw 的強制層 | 已確認的覆蓋順序 |
|---|---|---|---|
| claude-tmux / claude-sdk | `settingSources: user, project, local` | `--permission-mode`、`--disallowedTools ListAgents SendMessage`、`--mcp-config`、`--append-system-prompt` | CLI > local > project > user |
| codex | `~/.codex/config.toml`、全域 MCP | process 層級 `--disable`（memories 等）、每個 turn 重送 model / approval / sandbox、thread 的 `mcp_servers` | 每個 turn 的覆寫 > config |
| opencode | `~/.config/opencode`、`~/.local/share/opencode`（M5 後改為預設繼承） | `OPENCODE_CONFIG_CONTENT`（權限規則、MCP、instructions） | 原始碼確認：remote → global → `OPENCODE_CONFIG` → 專案檔 → `.opencode/` → **`OPENCODE_CONFIG_CONTENT`**（最後套用） |
| pi | `~/.pi/agent`（或 `PI_CODING_AGENT_DIR`）；agent 專案的 `.pi/` 預設信任（`trustProject: false` 可關） | SDK 參數（tool_call 權限閘門、MCP） | SDK 參數直接生效；同一個實例的 pi profile 必須共用一個 agent 目錄（pi 的 MCP OAuth 讀 process 層級環境變數） |
| agy | 使用者的 `HOME`（預設；`isolateHome: true` 可改用實例目錄） | `--settings`（僅此次 session、不寫回） | `--settings` 覆蓋 settings.json |

**例外**：profile 用 `provider-login` 憑證並指定 `home`（另一個帳號）時，改用那個獨立目錄，不讀使用者的全域設定。

**已知限制（與 v2 相同）**：Claude Code 的 `permissions.allow` 是各層**合併**，上層只能用 deny 蓋過、不能移除下層的 allow。所以使用者個人設定裡允許的工具，在 UniQlaw 裡也會直接通過、不經過 operator 核准；UniQlaw 的硬性限制要用 deny（`denyTools`、`--disallowedTools`、專案的 `permissions.deny`）表達，deny 一定優先。

### 10.1 憑證層（Credentials）

憑證是**具名、可重用的設定**，profile 參照它，adapter 在啟動 provider 時才把它轉成該
provider 認得的形式（環境變數、設定目錄、SDK 參數）。uniqlaw 本身不保存祕密值，只保存
「去哪裡拿」。

```ts
type Credential =
  // 直連 API
  | { kind: "anthropic-api-key"; key: SecretRef }
  | { kind: "openai-api-key";    key: SecretRef; baseUrl?: string; org?: string }
  | { kind: "gemini-api-key";    key: SecretRef }
  | { kind: "openai-compatible"; baseUrl: string; key?: SecretRef }        // vLLM / Ollama / llama.cpp / OpenRouter…
  // 三大雲
  | { kind: "aws";    region: string; profile?: string; roleArn?: string;  // 預設走 AWS SDK credential chain（env / profile / SSO / IMDS）
                      accessKey?: SecretRef; secretKey?: SecretRef; sessionToken?: SecretRef }
  | { kind: "gcp";    project: string; location: string;                    // 預設走 ADC
                      serviceAccountFile?: string; impersonate?: string }
  | { kind: "azure";  endpoint: string; deployment?: string; apiVersion?: string;
                      auth: { type: "api-key"; key: SecretRef } | { type: "entra" /* DefaultAzureCredential */ } }
  // 訂閱帳號 / 互動登入（存在隔離的 provider home 裡）
  | { kind: "provider-login"; provider: "claude" | "codex" | "agy" | "opencode" | "pi"; home: string };

type SecretRef = { env: string } | { file: string } | { command: string };   // 不寫明文；可接 1Password / pass / vault CLI
```

各 adapter 支援的憑證（M1–M3 實作時逐一驗證）：

| adapter | 直連 API key | AWS Bedrock | GCP Vertex | Azure | 訂閱 / 登入 |
|---|---|---|---|---|---|
| claude-sdk / claude-tmux | `ANTHROPIC_API_KEY` | `CLAUDE_CODE_USE_BEDROCK` + AWS chain | `CLAUDE_CODE_USE_VERTEX` + ADC | `CLAUDE_CODE_USE_FOUNDRY` | claude.ai（`CLAUDE_CONFIG_DIR`） |
| codex | `OPENAI_API_KEY` | ⚠️ 自訂 model provider | ⚠️ 自訂 model provider | Azure OpenAI model provider（config） | ChatGPT 登入（`CODEX_HOME`） |
| opencode | 各 provider key | ✅ 內建 Bedrock | ✅ 內建 Vertex | ✅ 內建 Azure | 各 provider 登入（XDG 目錄） |
| agy | `GEMINI_API_KEY` ⚠️ | — | `GOOGLE_GENAI_USE_VERTEXAI` + ADC ⚠️ | — | Google 帳號（目錄覆寫方式 ⚠️） |
| pi | OpenAI / Anthropic / Gemini / 任何 OpenAI-compatible | ✅ Bedrock | ✅ Vertex | ✅ Azure OpenAI | OAuth（`PI_CODING_AGENT_DIR` 內） |

agy 那幾格的環境變數名稱是從執行檔字串找到的，尚未實測（⚠️）。

**pi 是「三大雲 API 格式」的保底路線**：pi-ai 原生支援 Bedrock、Vertex、Azure OpenAI 和所有
直連 API，任何 provider adapter 不支援的雲，都能用 pi profile 補上。

---

## 11. 狀態儲存

```
.uniqlaw/
  settings.json            設定（使用者編輯）
  state.db                 SQLite (bun:sqlite)：sessions、bindings、tasks、cron lastFiredAt
  inbox/                   （不再需要：bus 改用 state.db 的 queue 表）
  history/<session>.jsonl  只有 resume=core-managed 的 provider 才會用
  logs/
```

改用 SQLite，原因是 bus 的 task 狀態、cron 補跑（v2 TODO）、A2A task store 都需要 transactional
儲存。`@a2a-js/sdk` 本身就支援 SQLite task store。

---

### 11.1 v2 → uniqlaw 遷移（agent 照文件做）

**不做固定的遷移腳本。** 遷移是一次性的工作，每個 v2 安裝又都不太一樣：v1 留下的 key、手改過的檔案、空的 allowlist、時區格式。寫死的轉換器要嘛猜錯，要嘛要一直補例外。所以改成寫一份給 agent 看的作業指南 [`docs/MIGRATE.md`](MIGRATE.md)：有對應表、鐵則（先停 v2、v2 檔案只讀、不印 secret、遇到要使用者決定的事就停下來問），以及範例片段（用 `StateStore` 匯入 session）。agent 讀實際的檔案、先給使用者看計畫、確認後才寫入，最後跑 `uniqlaw doctor` 驗證。Claude Code plugin 的 `/uniqlaw:migrate` 就是「照這份文件做」。

程式裡留下的相容部分（給遷移過來的資料用，不是遷移工具）：

| 位置 | 相容什麼 |
|---|---|
| `provider-claude-tmux` `legacy.ts` | 第一次 `--resume` 前，關掉 default tmux socket 上還在跑同一個 session 的 v2 `claudeclaw-*` session |
| core runtime | `pending_input` 裡 `source: "v2-inbox"` 的資料，用 v2 的 inbox 格式放進 prompt |
| scheduler | v2 的 cron `.md` 格式、`UTC±H` 時區 |
| platform-discord / slack / line | 接受 v2 的設定欄位名稱（含 `messageStream`） |
| platform-telegram | token 接受字串（v2 相容），建議改成 SecretRef |
| model router | 直接讀 v2 的 `agentic` 區塊（`profiles.<p>.options.agentic`） |
| `uniqlaw doctor` / `init` | 偵測 v2 是否在跑、是否用同一個 bot token；有 v2 設定時提示改用遷移 |

v1 → uniqlaw：不直接支援，先用 v2 的 `/claudeclaw2:migrate` 升到 v2。

### 11.2 同一台機器跑多個 claw（多實例隔離）

**實例 = 一個 uniqlaw 專案目錄**（`.uniqlaw/` 所在）。每個實例有自己的 instance id
（`settings.instance.id`，預設由目錄路徑雜湊產生），所有會撞到的資源都依 instance id 隔離：

| 資源 | 隔離方式 |
|---|---|
| state / log / lock | 各自的 `.uniqlaw/`；啟動時拿 `.uniqlaw/daemon.lock`，同一個實例不能啟動兩次 |
| port（web、MCP Gateway、A2A、LINE webhook） | 預設 `0`（自動配置），實際 port 寫進 `.uniqlaw/runtime.json` 給 CLI 和 skill 讀取；要固定 port 可在設定指定，啟動時檢查衝突 |
| tmux | 專用 socket：`tmux -L uniqlaw-<instanceId>`，session 名稱再加 instance 前綴；不會跟使用者自己的 tmux 或其他實例混在一起 |
| provider 設定目錄 / 登入帳號 | 每個 `provider-login` 憑證指定自己的 home，adapter 用環境變數指過去：claude `CLAUDE_CONFIG_DIR`、codex `CODEX_HOME`、pi `PI_CODING_AGENT_DIR`、opencode `OPENCODE_CONFIG_DIR` + `XDG_*`、agy ⚠️（找不到專用變數就整個覆寫 `HOME`）。兩個實例可以用不同的訂閱帳號，也可以刻意共用同一個 home |
| provider 子程序 | 每個 session 的子程序環境只帶它 profile 的憑證，不繼承 daemon 的完整環境（避免 A 實例的 key 漏到 B 實例的 agent） |
| 原生跨 session 管道 | 已依 §5.2 規則關閉；額外確保 Claude 的訊息 socket、codex app-server 都不共用 |
| A2A | 每個實例各自的 Agent Card；同一台機器上的多個實例可以互相設定成遠端 A2A peer |
| 平台 bot | 同一個 bot token 不能被兩個實例同時 long-poll（Telegram 會互搶）→ 啟動時在 `~/.local/state/uniqlaw/claims/` 登記 token 雜湊，重複就拒絕啟動 |

`uniqlaw ls` 列出本機所有實例（掃描 claims 目錄 + 各自的 `runtime.json`）：狀態、port、profile、session 數。

## 12. Repo 結構（Bun workspaces）

```
packages/
  core/               types、Session Manager、Router、Bus、Approval、Output Pipeline、State
  daemon/             bootstrap、settings 載入/驗證、plugin loader
  mcp-gateway/        Streamable HTTP MCP server、per-session token、tool registry
  claude-common/       jsonl parser、system prompt / 權限 flag、session 管理（兩個 claude adapter 共用）
  provider-claude-sdk/
  provider-claude-tmux/
  provider-codex/
  provider-opencode/
  provider-acp/
  provider-pi/
  platform-telegram/  platform-discord/  platform-slack/  platform-line/  platform-web/
  scheduler-cron/     scheduler-heartbeat/
  transport-a2a/
  cli/                uniqlaw init|doctor|start|stop|reload|status|ls|send|trigger|mcp-shim
  credentials/        Credential 解析、SecretRef（env / file / command）、轉成各 provider 的 env
  testkit/            provider-mock、platform-mock、capability 合約測試
```

`testkit` 提供 **provider 合約測試**：每個 adapter 都要跑同一組測試（send → events 序列、
interrupt、steer、permission、resume、跨 session MCP 隔離、原生跨 session 工具已停用），宣告的 capabilities 必須真的能通過。

---

## 13. 已決定事項（2026-11-02）

| # | 問題 | 決定 |
|---|---|---|
| 1 | Claude 用 SDK 還是 tmux | **兩個都做**：`claude-sdk` + `claude-tmux`，共用 `claude-common`（§5.2）。遷移預設用 tmux |
| 2 | Runtime | **Bun**。A2A 三種 transport（含 gRPC）都已在 Bun 1.3.4 實測可用 |
| 3 | 不同 channel 綁不同 provider | **可以**（§4 Binding） |
| 4 | A2A 公開粒度 | **以 Agent Profile 為單位**（§9） |
| 5 | v2 遷移 | **要做**：一開始寫成 `uniqlaw migrate` 腳本，後來改成給 agent 照著做的文件 `docs/MIGRATE.md`（§11.1） |
| 6 | 認證政策 | **只做相容與支援**：provider 能用的方式（訂閱登入、API key、雲端憑證）全支援，使用由使用者自行負責（目標 8、§10.1） |
| 7 | 雲端 LLM | **三大雲（Bedrock / Vertex / Azure）+ 直連 API 全支援**，API key、ADC、AWS chain、Entra ID 都要能設定（§10.1）；**同一台機器可跑多個 claw**（§11.2） |
| 8 | Google 的 coding agent | **Antigravity CLI（agy）**，Gemini CLI 不列入支援目標；Gemini 模型的 API 路線走 pi（Gemini API / Vertex） |
| 9 | provider 的使用者層級設定 | **沿用 v2 的「繼承 + 覆蓋」**：每個 provider 照常讀自己的全域設定與 hooks（`~/.claude`、`~/.codex`、`~/.config/opencode`、`~/.pi/agent`、agy 的 HOME），讓 claude-mem 這類記憶層可以運作；UniQlaw 的強制規則用 agent 專案目錄的設定與 CLI 參數覆蓋（見 §10.2） |
| 10 | 私訊的 session | **每個私訊各自一個 session**（2026-11-08 變更，參考 OpenClaw 的做法）。v2 把所有私訊收斂到 `global`：不同使用者、不同平台共用同一段對話 context，多人使用時會互相看到彼此交代的事。現在 DM key 是 `telegram:<userId>`、`discord:dm:<userId>`、`slack:dm:<userId>`、`line:<userId>`，`parseTarget` ↔ `channelKeyForTarget` 可以互相還原。`global` 變成普通的內部 session 名稱。跨平台同一個人合併成一個 session 不在這次範圍內 |
| 11 | heartbeat / cron 的 session 與模型 | **預設跑在自己的內部 session**（`heartbeat`、`cron:<job>`），可用 `profile` 固定 profile、用 `model` 指定單次 turn 的 model；對人說話靠 bus 工具（§8.5）|
| 12 | 指揮其他 coding agent | **worker session**（§8.6）：agent 用 `worker_start` 在允許的目錄開某個 profile 的 agent，結果透過 bus 送回。人類可以用 `/attach`（聊天室，所有 provider）或 `uniqlaw attach`（終端機：claude-tmux 是 live，claude-sdk / codex 交給原生 CLI resume）接管，接管期間 owner 的訊息會被拒絕。允許的目錄預設只有專案目錄 |

M0 結果見 `docs/spikes/M0-results.md`。目前沒有待決事項。

## 14. 里程碑

| M | 內容 | 驗收 |
|---|---|---|
| M0 | Spike：每個 adapter 各寫一個 50 行 PoC，把 event 映射到 `AgentEvent`。必驗：(0) claude-tmux 和 claude-sdk 能不能互相 resume 同一個 session id；(1) Claude SDK 用 `settingSources` / plugins 是否載入 `~/.claude` 的 skills、plugins、hooks、plugin slash commands，並對照 TUI；(2) 訂閱帳號在 SDK 下的授權方式（查 SDK auth 文件和條款，不要用猜的）；(3) Claude streaming input 的排隊語意；(4) `turn/steer` 參數；(5) `agy` headless 是否官方支援；(6) pi SDK 模式下 project trust 怎麼決定（`.pi/mcp.json` 會不會被自動拒絕，類似 v2 init-watch 的問題）| capability 矩陣補完，§13 列出的技術問題都有答案 |
| M1 ✅ | core（含多實例隔離：lock、runtime.json、tmux socket、token claims）+ mcp-gateway + claude-common + **provider-claude-tmux**（v2 移植，風險最低）+ platform-telegram + bus 工具 + v2 遷移 | 用遷移過來的 v2 專案在 TG 上跑，行為跟 v2 一致 |
| M1.5 ✅ | provider-claude-sdk；Claude 訊息 socket 風險的緩解；steer 競態（steer 呼叫與 turn 結束同時發生時，回覆會被當成背景輸出、沒有引用原訊息）；權限拒絕路徑的真實 e2e（目前只有假 provider 的單元測試）；型別化 error 的自動重試 | 跟 tmux adapter 通過同一組合約測試（session 互通 M0 已驗證） |
| M2 🟡 | credentials 套件 + provider-pi（直連 API + Bedrock / Vertex / Azure） | 合約測試在每種憑證類型各跑一次 |
| M3 ✅ | provider-codex、provider-opencode、provider-acp（S5/S6/S6b 待 opencode 免費額度恢復後重驗）、provider-agy | 合約測試通過；polyfill 規則生效 |
| M4 ✅ | transport-a2a（server + client；JSON-RPC / REST / gRPC） | 兩個 uniqlaw 實例互相 `agent_ask`；可以接第三方 A2A agent |
| M5 ✅ | discord / slack / line（只測過假 server）、web dashboard、scheduler、模型路由、migrate | 跟 v2 功能完全對等 |

**狀態圖例**：✅ 完成並通過驗收；🟡 部分完成（見 §15）。

---

## 15. 實作回饋（M1.5–M4，2026-11-02）

### 15.1 core 新增
- `unsolicited_turn.source = "external"`：從 provider 原生管道（Claude 訊息 socket）進來的輸入。core 把該 turn（或 turn 剩下的部分）只送 operator，並加警告；claude-tmux 偵測 `<cross-session-message>` 時發出。這是 §5.2 訊息 socket 風險的緩解措施（風險本身仍在，見 §5.2）。
- steer 競態：turn 結束前 3 秒內 steer 的 origin 會被帶到 adapter 退回開的新 turn，回覆仍送給下 steer 的人。
- 型別化 error：`rate_limit` 自動重試（最多 3 次，30 秒起每次加倍）；`usage_limit` 告知使用者並讓等待中的 ask 失敗。
- 排程（`scheduler` 套件）：cron 預設開啟（v2 格式、IANA 時區、可選補跑）、heartbeat（安靜時段、忙碌延後）；scheduler plugin 可貢獻 MCP 工具（`cron_list` / `cron_save` / `cron_delete`）。
- 模型路由：v2 的 agentic modes + hysteresis，設定在 `profile.options.agentic`；只對真人 turn 生效，且只在 `modelSwitch: "live"` 的 provider 上作用。
- `transport` plugin kind：遠端 agent 出現在 `agents_list`，`agent_ask` 可直接問；`runInbound` 讓外部 A2A 請求跑在指定 profile 的 `a2a:<profile>:<contextId>` session 上。

### 15.2 各 adapter 實測
| adapter | 合約測試 | 重點發現 |
|---|---|---|
| claude-tmux | 9/9（真 Claude） | daemon 停止用 `detach()` 保留 tmux；拒絕權限結束整個 turn（core 自動補一個 turn） |
| claude-sdk | 9/9（S4 偶發：haiku 把裸的插入文字當 prompt injection；core 實際送出的帶時間戳和來源行） | 與 claude-tmux 雙向互接 session ✅；**使用者層級的允許規則（`~/.claude/settings.json`）會讓工具直接通過、跳過 UniQlaw 核准**，profile 設 `userSettings: false` 可排除；沒有 `detach()`，重啟時重新 `--resume` |
| codex | 8/9 + 專屬隔離測試（真 app-server） | 每組憑證一個 app-server、每個 session 一個 thread；**每個 turn 都重送全部設定**（codex 會沿用 turn 覆寫）；`memories` 等功能只能用 process 層級 `--disable` 關；**內建 `collaboration.list_agents` / `send_message` 拿不掉**，但只看得到同 thread 的 subagent（以專屬測試取代 S1b）；使用者全域 codex MCP server 會載入 |
| pi | 9/9（faux 模型） | 每個 session 自己的模型 runtime、只帶該 profile 的憑證；`~/.agents/skills` 會載入（`skills: false` 可關）；**真模型尚未驗證（需憑證）** |
| opencode | 9/9（真 opencode serve，免費 model） | 每個 session 一個 serve；設定與資料目錄隔離在實例底下；仍會載入 `~/.claude/skills`、`~/.agents/skills` |
| acp（→ opencode acp） | 6/9（S5/S6/S6b 因免費額度用完未驗） | 預設一個 session 一個 process；`session/load` 重播抑制；額度用完時 opencode acp 會無聲重試、卡住 → adapter 讀 log 在約 2 秒內回報 `usage_limit` |
| agy | 6 項合約 + 2 項專屬（真 agy） | **登入無法隔離**（token 在系統 keyring，換 `HOME` 也保持登入），多實例會共用同一個 Google 帳號；Vertex 用 `AGY_ADC_AUTH`；`--remote-control` 不能做權限確認；MCP 走 `--add-dir` 的獨立目錄 + `uniqlaw mcp-shim`，不寫入使用者專案 |
| transport-a2a | 14 + 雙 daemon 測試（JSON-RPC 與 gRPC） | JSON-RPC（預設）、REST（`/<profile>/rest`，自寫轉接層）、gRPC（獨立 port，以 A2A `tenant` 區分 profile）三種都支援，bearer token 認證一致；所有 transport 的 port 會寫入 `runtime.json`，`uniqlaw status` 會顯示 |

### 15.3 M5 補充
- core 加通用卡住偵測：`turn.stallTimeoutSec`（預設 900 秒）沒有任何 provider 事件就中斷並告知使用者；等待人工核准期間不計時。
- web dashboard（daemon 的 HTTP API 上，無 build step）：sessions + 即時對話紀錄（core 新增 `transcript` 表，每個 session 保留最近 500 筆）、jobs、logs、SSE 即時事件；非 loopback 必須設 `web.token`。已用瀏覽器實際驗證。
- Discord / Slack / LINE：v2 的 channel key 規則與設定格式相容；`allowedUserIds` 空 = 全部拒絕（v2 是全部放行），遷移時每個平台都會警告。

### 15.4 第二輪補充
- **串流輸出**（`output.stream: "replace"`）：provider 的 token delta 會即時編輯同一則訊息（首次 0.8 秒、之後每 1.5 秒最多一次）；在足以排除 `NO_REPLY` / `HEARTBEAT_OK` 之前不會顯示，`[react:…]` 不會出現在即時文字裡；被中斷時保留已顯示的內容。已用真 claude-sdk + Telegram adapter 驗證。
- **設定熱重載**：`uniqlaw reload` / `POST /api/reload` / `SIGHUP`，先驗證 settings，失敗就保留舊設定繼續跑；成功時在同一個 process 裡重啟，provider session 用 `detach()` 保留。
- **易用性**：`uniqlaw init`（互動精靈或 `--yes`，只存 secret 的引用、拒絕空白允許清單）、`uniqlaw doctor`、`uniqlaw logs`；README、`docs/INSTALL.md`；Claude Code plugin（`/uniqlaw:*` 指令與 `uniqlaw-agents` skill）。

### 15.5 API / SDK 一致性驗證（不需真憑證）
- **平台**：每個平台都有 `test/conformance.test.ts`，把送出的請求與收到的 payload 用官方定義驗證（ajv + 型別檢查，各附反例）。Telegram 對 `@grammyjs/types`（依官方文件手動維護）；Discord REST 對官方 OpenAPI、Gateway 對 `discord-api-types`；Slack 對 `@slack/web-api` / `@slack/types`（官方 OpenAPI 已封存）；LINE 對官方 line-openapi。發現並修正：LINE 的 reaction API 不在官方規格內（v2 沿用下來的），已移除、`reactions=false`。
- **pi 憑證**：對照 pi-ai 1.4 原始碼並攔截實際送出的 HTTP 請求驗證 OpenAI / Anthropic / Gemini / Vertex / Bedrock（SigV4）/ Azure。修正：Bedrock 的 region 與金鑰原本沒生效；OpenAI baseUrl / organization 改走 pi-ai 真正讀的欄位；pi-ai 做不到的（Azure Entra ID、AWS role、GCP impersonation）改為明確報錯。注意：profile 沒設的值，pi-ai 會退回讀 daemon 的環境變數。
- **agy 憑證**：對照 agy 內附 changelog 與 help：API key → `GEMINI_API_KEY`；ADC → `AGY_ADC_AUTH=1` + `GOOGLE_CLOUD_PROJECT` / `GOOGLE_CLOUD_LOCATION` / `GOOGLE_APPLICATION_CREDENTIALS`；移除無文件依據的變數。
- **仍需真憑證才能驗的**：實際的 token 交換與模型回應、agy 是否接受 `AGY_ADC_AUTH=1` 這個值、各平台與真實服務的端對端。

### 15.6 待辦
- pi 真模型驗證（需 OpenAI key / Vertex ADC / Bedrock / Azure 其一）。
- ACP S5/S6/S6b 重驗（opencode 免費額度恢復後）：`UNIQLAW_E2E=1 bun test packages/provider-acp/test/contract.e2e.test.ts -t "S5|S6"`。
- Discord / Slack / LINE 與真實服務的端對端驗證（需要測試用 bot）。
- agy 的 API key 與 ADC 實測。

