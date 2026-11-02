# 從 ClaudeClaw v2 遷移到 UniQlaw

> ⚠️ **兩個程式不能同時用同一個 bot token。** Telegram 只允許一個 long-poller，v2 和 UniQlaw 同時跑會互搶訊息。切換前一定要先停掉 v2。

## 步驟

以 v2 專案在 `~/claudeclaw` 為例，UniQlaw 直接用同一個目錄（設定寫在 `.uniqlaw/`，不動 v2 的 `.claude/claudeclaw/`）：

```bash
cd ~/Projects/uniqlaw            # repo（尚未改名前是 ~/Projects/uniclaw）
U="bun packages/cli/src/main.ts"   # 或 `bun link` 之後直接用 uniqlaw

# 1. 預覽（唯讀，v2 在跑也可以）
$U migrate --from ~/claudeclaw --project ~/claudeclaw --dry-run

# 2. 停掉 v2
#    在 Claude Code 裡：/claudeclaw2:stop
#    或：kill -TERM $(cat ~/claudeclaw/.claude/claudeclaw/daemon.pid)

# 3. 寫入（v2 還在跑會被拒絕）
$U migrate --from ~/claudeclaw --project ~/claudeclaw

# 4. 檢查 ~/claudeclaw/.uniqlaw/settings.json
#    - plugins.telegram.allowedUserIds 不可是空的（UniQlaw 空清單 = 全部拒絕）
#    - 建議把 token 改成 {"env": "TELEGRAM_BOT_TOKEN"} 之類的 SecretRef
#    - web.port 沿用 v2 的 4632，舊 skill 的 /api/send、/api/trigger 可以照用

# 5. 檢查環境（工具、憑證、port、bot token 衝突、v2 是否還在跑）
$U doctor --project ~/claudeclaw

# 6. 啟動
$U start --project ~/claudeclaw
$U status --project ~/claudeclaw
tail -f ~/claudeclaw/.uniqlaw/logs/daemon.log
```

## 遷移後的行為

- 第一則訊息進來時，claude-tmux 會在 UniQlaw 自己的 tmux socket（`tmux -L uniqlaw-<instanceId>`）用 `--resume` 接回 v2 的 Claude session；如果 v2 留下的 tmux session 還在，會先關掉它，避免兩個 claude 寫同一個 jsonl。對話歷史都在 jsonl 裡，不會遺失。
- v2 `queue.mode: "native"` 變成 `steer`（行為相同）。
- cron 工作檔會複製到 `.uniqlaw/jobs/`，cron 預設開啟；模型路由（`profiles.main.options.agentic`）沿用 v2 設定。
- Discord / Slack / LINE 與 heartbeat 會帶著 `enabled: false` 遷移過來：確認 `allowedUserIds` 不是空的之後，改成 `enabled: true` 再 `uniqlaw reload`。
- v2 的檔案完全不動；要退回 v2 時：`$U stop`，再啟動 v2 即可。

## 退回 v2

```bash
$U stop --project ~/claudeclaw
tmux -L uniqlaw-<instanceId> kill-server   # instanceId 見 `uniqlaw status`
# 再用 /claudeclaw2:start 啟動 v2
```

在 Claude Code 裡也可以用 plugin 指令：`/uniqlaw:migrate`（依同樣流程，先 dry-run）。
