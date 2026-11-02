# M0 spikes

目的：用最小 PoC 驗證每個 provider 的原生介面能不能對應到 `docs/architecture.md` §5 的
`AgentProvider` / `AgentEvent`，並把 capability 矩陣補成實測值。

這裡是**用完即丟的驗證程式**，不是正式套件。正式實作放在 `packages/`。

## 共用

- `common/events.ts`：`AgentEvent` 草稿型別、`Recorder`（寫 `out/events.jsonl`、`out/raw.jsonl`）、`report()`（寫 `out/result.md`）
- `common/mcp-gateway.ts`：測試用 MCP Gateway，Streamable HTTP `/mcp/<token>`，提供工具 `uniqlaw_ping`；
  `gw.calls` 記錄每次呼叫和呼叫者的 token
- 用法：`import { Recorder, report, startTestGateway } from "../common/index.ts"`（各 spike 目錄自己的 package.json 只放 provider 的依賴）

## 標準情境（每個 adapter 都要跑，做不到就標 n/a 並說明原因）

| # | 情境 | 驗什麼 |
|---|---|---|
| S1 | basic：送 `Reply with exactly: PONG` | 拿到 `session` id、`turn_start`、`text`（final）、`turn_end{done}`；記錄串流粒度（token / segment / final） |
| S2 | tool + 權限：要求在 `work/` 建立檔案 `s2.txt`（用 shell 或寫檔工具），權限設成「需要核准」 | 收到 `permission_request`；用程式核准後工具執行、檔案存在；再測一次拒絕 |
| S3 | interrupt：要求寫一篇長文（~800 字），收到第一段輸出後中斷 | 中斷成功、`turn_end{interrupted}`、session 仍可繼續 |
| S4 | inject：開始一個需要幾個工具呼叫的 turn（例如依序 `sleep 3` 三次），中途送一則「另外，最後回覆請加上 INJECTED」 | 能否在 turn 中途插入（steer）、或只能排隊到 turn 結束、或完全不行 |
| S5 | resume：關掉 session/process，用 provider session id 重開，問「我剛剛叫你回什麼字？」 | 對話歷史還在 |
| S6 | MCP：把 `gw.url("<sessionKey>")` 掛成 MCP server，要求呼叫 `uniqlaw_ping` | 工具呼叫成功、`gw.calls` 的 token 正確（per-session 身分綁定可行）；記錄 MCP 是 per-session 還是 per-process 設定 |
| S7 | model switch：中途切換 model 後再跑一個 turn | 有沒有 live 切換 API |

## 規則

- 工作目錄一律用 `spikes/<adapter>/work/`（由 PoC 自己建立），不要讓 agent 動到 repo 其他地方。
- 用最便宜、最快的 model，prompt 盡量短，控制額度用量。
- 不要改使用者的全域設定（`~/.claude`、`~/.codex`、`~/.gemini`…）、不要登入或登出、不要印出任何 token 或 credential。
- tmux session 名稱一律 `uniqlaw-spike-*`，結束時清掉。
- 每個 adapter 目錄產出：`poc.ts`（可重跑）、`out/result.md`（情境結果表）、`NOTES.md`（原生事件 → `AgentEvent` 的對應、意外發現、對設計文件的修正建議）。
