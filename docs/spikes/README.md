# M0 spikes

> **Historical.** These are the M0 findings (2026-11). The PoC code (`spikes/`: `poc.ts`, `common/`, `out/`, …) was removed from the tree and is in git history (the commit before "chore: prepare for open source"). These notes are not maintained.

Goal: use minimal PoCs to check whether each provider's native interface can map onto `AgentProvider` / `AgentEvent` from
`docs/architecture.md` §5, and fill in the capability matrix with measured values.

This was **throwaway validation code**, not a real package. The real implementations live in `packages/`.

## Shared code

- `common/events.ts`: draft `AgentEvent` types, `Recorder` (writes `out/events.jsonl`, `out/raw.jsonl`), `report()` (writes `out/result.md`)
- `common/mcp-gateway.ts`: test MCP Gateway, Streamable HTTP `/mcp/<token>`, provides the tool `uniqlaw_ping`;
  `gw.calls` records each call and the caller's token
- Usage: `import { Recorder, report, startTestGateway } from "../common/index.ts"` (each spike directory's own package.json lists only the provider's dependencies)

## Standard scenarios (every adapter must run them; if one cannot be done, mark it n/a and explain why)

| # | Scenario | What it checks |
|---|---|---|
| S1 | basic: send `Reply with exactly: PONG` | Get the `session` id, `turn_start`, `text` (final), `turn_end{done}`; record the streaming granularity (token / segment / final) |
| S2 | tool + permissions: ask it to create the file `s2.txt` in `work/` (with a shell or file-write tool), with permissions set to "require approval" | A `permission_request` arrives; after approving programmatically the tool runs and the file exists; then test a denial |
| S3 | interrupt: ask for a long essay (~800 words), interrupt after the first output chunk | Interrupt succeeds, `turn_end{interrupted}`, the session can still continue |
| S4 | inject: start a turn that needs several tool calls (for example `sleep 3` three times in a row), and midway send "Also, add INJECTED to your final reply" | Whether a message can be inserted mid-turn (steer), can only be queued until the turn ends, or not at all |
| S5 | resume: close the session/process, reopen it with the provider session id, ask "What word did I just ask you to reply with?" | The conversation history is still there |
| S6 | MCP: mount `gw.url("<sessionKey>")` as an MCP server and ask it to call `uniqlaw_ping` | The tool call succeeds and the token in `gw.calls` is correct (per-session identity binding works); record whether MCP is configured per session or per process |
| S7 | model switch: switch model midway, then run another turn | Whether there is a live switch API |

## Rules

- The working directory is always `spikes/<adapter>/work/` (created by the PoC itself); do not let the agent touch the rest of the repo.
- Use the cheapest, fastest model and keep prompts short to limit quota usage.
- Do not change the user's global settings (`~/.claude`, `~/.codex`, `~/.gemini`…), do not log in or out, and never print any token or credential.
- tmux session names are always `uniqlaw-spike-*`; clean them up at the end.
- Each adapter directory produces: `poc.ts` (rerunnable), `out/result.md` (scenario results table), `NOTES.md` (native event → `AgentEvent` mapping, surprises, suggested changes to the design doc). The notes now live at `docs/spikes/<adapter>.md`.
