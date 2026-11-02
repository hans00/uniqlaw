# claude-tmux spike notes

`poc.ts` launches the real `claude` TUI in tmux (`uniqlaw-spike-*`, 200×50) with:

```
claude --session-id <uuid> | --resume <uuid>   --model haiku   --disallowedTools ListAgents SendMessage   [extra]
```

It tails `~/.claude/projects/<cwd-hash>/<id>.jsonl` and polls the pane every 400 ms. `lib/` contains the v2 files (`tmux.ts`, `jsonl.ts`, `init-watch.ts`, `approval.ts`) copied over, with one addition: a folder-trust pattern.

## Native → AgentEvent mapping

| Source | AgentEvent |
|---|---|
| we choose the uuid (`--session-id`) | `session` (known before spawn, unlike the SDK) |
| jsonl `user` string entry (not `<…>` meta) | `turn_start` |
| jsonl `assistant` text / thinking / tool_use | `text{final}` / `thinking` / `tool_start`, at **segment** granularity (one flush per block, no token deltas) |
| jsonl `user` tool_result | `tool_end` |
| non-tentative `end_turn` **or** `system/stop_hook_summary`, **confirmed by an idle pane** | `turn_end{done}` |
| jsonl `[Request interrupted by user…]` | `turn_end{interrupted}` |
| pane dialog (`parsePermissionDialog`) | `permission_request` (kind permission / model-switch / question / login); reply = (N-1)×Down + Enter |

## Findings

1. **New startup prompt: folder trust.** The first launch in a new cwd shows "Is this a project you created or one you trust? ❯ No, exit / Yes, I trust this folder". v2 never saw it because it always ran in an already-trusted directory, and the SDK never shows it. Added to init-watch (Down + Enter). Accepting it records trust for that directory in `~/.claude.json`, the same as normal interactive use. The adapter must handle it for every new per-session cwd.
2. **Busy detection regex is stale.** Current TUI (2.1.316) shows `✻ Warping… (2s · ↓ 75 tokens)` while working, with no "esc to interrupt" text. The adapter should match the spinner shape `/[✻✶✳✢·*]\s+\S+…\s+\(\d+s/` instead. In this PoC turn ends still worked because jsonl `end_turn` / `stop_hook_summary` came first.
3. **The permission mode must be pinned** (same as the SDK). The user's `defaultMode: "auto"` meant no dialog appeared at all until we passed `--permission-mode default`. The dialog now offers 4 options: Yes / Yes+always allow dir / Yes+switch to auto mode / No.
4. **Deny semantics differ from the SDK.** Picking "No" in the TUI ends the whole turn (`[Request interrupted by user]`, turn_end{interrupted}). An SDK `deny` returns a tool error and the turn continues. The core should treat "deny" as provider-specific (`capabilities.denyEndsTurn`) or document the difference.
5. **Inject = native mid-turn steer.** Typing while busy (paste + Enter) is delivered **inside the running turn** as a `queued_command` attachment, exactly like SDK `priority:"next"`. One turn, all 3 tools ran, INJECTED honoured. So v2's `native` queue mode is really a steer, not a turn-boundary queue.
6. **Interrupt.** Esc → the jsonl gets an interrupt marker → turn_end{interrupted}, and the session keeps working.
7. **MCP.** `--mcp-config <file>` with `{type:"http",url}` is per-process, which here means per-session. The gateway saw token `claude-tmux-S6`.
8. **Model switch.** `/model sonnet` mid-session raises a "Switch model?" dialog (cache-invalidation warning) that the pane poller must answer. Afterwards the jsonl shows haiku→sonnet.
9. **`--disallowedTools` works.** The model reports NONE, and the CLI init (same flags, `-p`) lists neither tool.
10. **The jsonl path must be found by session id, not computed from the cwd.** Resuming from a different cwd still finds the session and appends to the *original* file under the original cwd hash, while each entry records the new cwd. A tailer that builds the path from its current cwd watches the wrong file. Fix: glob `~/.claude/projects/*/<id>.jsonl`.
11. A 2-turn session jsonl was about 650 KB (`api-request-blob` entries). The tailer must not re-read from the start, and the web viewer must skip blob entries.
