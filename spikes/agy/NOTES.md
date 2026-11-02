# agy（Antigravity CLI 1.4.12）spike notes

## 結論

**有官方 headless 介面**，不需要 tmux，也不需要社群做的 ACP bridge。

- 啟動方式：`agy --input-format stream-json --output-format stream-json [--model M] [--conversation ID] [--settings JSON] -p=`
  - 一個 process 就是一個 conversation，stdin 每一行 NDJSON 跑一個 turn。
  - 這些旗標都列在 `agy --help`，changelog 也有記載：「a driver can keep a session open」。
- `-p=` 要寫成空值形式。如果寫 `-p --input-format`，`-p` 會把下一個 flag 吃成 prompt，CLI 會報錯。
- 輸入格式：`{"event":"user","message":{"role":"user","content":"..." | [{"type":"text","text":"..."}]}}`
  - 這是用錯誤訊息試出來的。
  - `{"event":"control_request"}` 會回 `not supported yet`，所以 **stdin 上沒有控制通道**：不能中斷、不能回覆權限、不能切換 model。
- 條款與通知：所有測試執行過程中，CLI 都沒有印出任何關於程式化使用的條款或使用通知。
  - 只出現過權限被自動拒絕的提示，以及 `error: interrupted`。
  - 以上只代表這個 CLI 沒有在畫面上提醒，不代表條款允許，條款本身還是要另外查。
- 另外發現：有 `--remote-control` 和 `agy remote-control` daemon，看起來是更完整的遠端控制協定。這次沒有研究，可能是取得權限 callback 的途徑，列為後續 spike。

## 原生事件對應到 `AgentEvent`

| agy stream-json | AgentEvent |
|---|---|
| `{"event":"init","conversation_id",init:{model,cwd,tools[]}}` | `session{providerSessionId=conversation_id}` |
| `step_update{step_type:"user_input",state:"DONE"}` | `turn_start` |
| `step_update{step_type:"agent_response",text_delta}` | `text{delta, segmentId=step_index}` |
| `step_update{step_type:"agent_response",state:"DONE"}` | `text{final}`（由 adapter 自己累積 delta 組出來） |
| `step_update{step_type:"tool",state:"ACTIVE",tool_name,tool_info.parameters}` | `tool_start` |
| `step_update{step_type:"tool",state:"DONE"}` | `tool_end{ok}` |
| `step_update{step_type:"system_message"}` | 忽略（resume 時會出現） |
| `result{status,response,finished_reason?,usage,denied_actions?}` | `turn_end{reason: done / interrupted（finished_reason）/ error}`；`denied_actions` 轉成非致命的 `error` |

- 串流粒度：`token`。實際上是一小段一小段的 delta。
- thinking 不會出現在 stream 裡，只有 `usage.thinking_tokens` 這個數字。

## 實測結果（見 out/result.md）

| # | 結果 |
|---|---|
| S1 | ✅ |
| S2 | ✅ 沒有權限 callback。headless 預設**自動拒絕**，事後回報在 `result.denied_actions`。可以用 `--settings '{"permissions":{"allow":[...]}}'` 逐 process 預先放行。規則只認完整指令字串或 `command(*)`；`command(echo *)` 這種前綴或萬用字元寫法**比對不到**。其他規則類型有 `mcp(server/*)`、`read_file(path)`、`write_file(path)`、`url(domain)`。 |
| S3 | ✅ 送 SIGINT 後，result 會帶 `finished_reason:"interrupted"`，然後 **process 結束**。接著用 `--conversation` 重開，對話可以繼續。 |
| S4 | ✅ 第二行 stdin 不會插進進行中的 turn，而是排隊，等前一個 turn 結束後自己跑成一個 turn。 |
| S5 | ✅ `--conversation <id>` 接回後，conversation_id 相同，歷史還在。 |
| S6 | ✅ MCP 設定有三個範圍：全域 `~/.gemini/config/mcp_config.json`、plugin、**workspace `<cwd>/.agents/mcp_config.json`**。`--settings` 不接受 `mcpServers`；`serverUrl` 裡的 `${ENV}` **不會**被展開。解法：stdio shim 讀取繼承自 agy process 的 `UNIQLAW_TOKEN`，身分就是對的。tool 是透過通用的 `call_mcp_tool` 呼叫。 |
| S7 | ✅ 不能即時切換 model。改用 `--conversation` 加新的 `--model` 重開，歷史會保留。 |

## Capability（§5 形狀）

```ts
{
  streaming: "token",
  interrupt: true,            // 實作方式 = SIGINT + respawn(--conversation)，會比其他 provider 慢一拍
  inject: "queue",
  resume: "native",
  modelSwitch: "spawn",
  permissionCallback: false,  // 只能用 permissions.allow 事先放行；拒絕時事後才知道
  mcp: "per-process",         // workspace .agents/mcp_config.json + stdio shim + env token
  nativeTools: false,
  attachments: [],            // 這次沒測
  slashCommands: true,        // 有 --disable-slash-commands，所以 print 模式本來就會展開 slash command / skill
}
```

## 對設計文件的修正建議

1. §5.1 的 Antigravity：改成「官方 headless stream-json，做成獨立的 `provider-agy`」，拿掉「只有社群 bridge」的說法。
2. 新的 shim 模式：provider 的 MCP 設定只能放在 cwd 或全域、不能逐 session 指定時，用 `uniqlaw-mcp-shim`。它是 stdio 程式，從繼承的環境變數取得 token，再轉發到 MCP Gateway。這個做法可以通用：任何 MCP 只能 per-process 設定的 provider，都能這樣做到逐 session 綁定身分。
3. 副作用：
   - `.agents/mcp_config.json` 必須寫在**專案 cwd**，這會動到使用者的專案目錄，建議 adapter 一次寫入就固定不變。
   - agy 會把 MCP tool schema 快取到 `~/.gemini/antigravity-cli/mcp/<server>/`。
4. permissionCallback=false 時，§6 的 polyfill 說「預先收緊 allowlist」是對的。此外 agy 的 `denied_actions` 可以拿來事後通知 operator：「剛剛擋掉了 X，要不要加入允許清單？」
