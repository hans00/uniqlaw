# agy (Antigravity CLI 1.4.12) spike notes

> The PoC code and raw results (`spikes/agy/`: `poc.ts`, `out/`) were removed from the tree; they are in git history (the commit before "chore: prepare for open source").

## Conclusion

**There is an official headless interface**; neither tmux nor a community ACP bridge is needed.

- Launch: `agy --input-format stream-json --output-format stream-json [--model M] [--conversation ID] [--settings JSON] -p=`
  - One process is one conversation; each NDJSON line on stdin runs one turn.
  - These flags are all listed in `agy --help`, and the changelog mentions them too: "a driver can keep a session open".
- `-p=` must be written in the empty-value form. If you write `-p --input-format`, `-p` swallows the next flag as the prompt and the CLI errors out.
- Input format: `{"event":"user","message":{"role":"user","content":"..." | [{"type":"text","text":"..."}]}}`
  - Found by trial and error from the error messages.
  - `{"event":"control_request"}` returns `not supported yet`, so **there is no control channel on stdin**: no interrupt, no permission replies, no model switch.
- Terms and notices: during all test runs, the CLI never printed any terms or usage notice about programmatic use.
  - The only messages were auto-denied permission notices and `error: interrupted`.
  - This only means the CLI does not warn on screen; it does not mean the terms allow it. The terms themselves still need to be checked separately.
- Also found: there is `--remote-control` and an `agy remote-control` daemon, which look like a fuller remote-control protocol. Not investigated this time; it may be a way to get a permission callback. Listed as a follow-up spike.

## Native events mapped to `AgentEvent`

| agy stream-json | AgentEvent |
|---|---|
| `{"event":"init","conversation_id",init:{model,cwd,tools[]}}` | `session{providerSessionId=conversation_id}` |
| `step_update{step_type:"user_input",state:"DONE"}` | `turn_start` |
| `step_update{step_type:"agent_response",text_delta}` | `text{delta, segmentId=step_index}` |
| `step_update{step_type:"agent_response",state:"DONE"}` | `text{final}` (assembled by the adapter from the accumulated deltas) |
| `step_update{step_type:"tool",state:"ACTIVE",tool_name,tool_info.parameters}` | `tool_start` |
| `step_update{step_type:"tool",state:"DONE"}` | `tool_end{ok}` |
| `step_update{step_type:"system_message"}` | ignore (appears on resume) |
| `result{status,response,finished_reason?,usage,denied_actions?}` | `turn_end{reason: done / interrupted (finished_reason) / error}`; `denied_actions` becomes a non-fatal `error` |

- Streaming granularity: `token`. In practice the deltas are small chunks.
- Thinking does not appear in the stream; there is only the number `usage.thinking_tokens`.

## Test results (see out/result.md)

| # | Result |
|---|---|
| S1 | ✅ |
| S2 | ✅ No permission callback. Headless mode **auto-denies** by default and reports afterwards in `result.denied_actions`. You can pre-allow per process with `--settings '{"permissions":{"allow":[...]}}'`. Rules only match a full command string or `command(*)`; prefix or wildcard forms like `command(echo *)` **do not match**. Other rule types: `mcp(server/*)`, `read_file(path)`, `write_file(path)`, `url(domain)`. |
| S3 | ✅ After SIGINT, the result carries `finished_reason:"interrupted"`, and then **the process exits**. Reopening with `--conversation` lets the conversation continue. |
| S4 | ✅ A second stdin line is not inserted into the running turn; it is queued and runs as its own turn after the previous one ends. |
| S5 | ✅ After reattaching with `--conversation <id>`, the conversation_id is the same and the history is still there. |
| S6 | ✅ MCP config has three scopes: global `~/.gemini/config/mcp_config.json`, plugin, and **workspace `<cwd>/.agents/mcp_config.json`**. `--settings` does not accept `mcpServers`; `${ENV}` in `serverUrl` is **not** expanded. Solution: a stdio shim reads `UNIQLAW_TOKEN` inherited from the agy process, so the identity is correct. Tools are called through the generic `call_mcp_tool`. |
| S7 | ✅ No live model switch. Instead, respawn with `--conversation` plus a new `--model`; history is kept. |

## Capability (§5 shape)

```ts
{
  streaming: "token",
  interrupt: true,            // implemented as SIGINT + respawn(--conversation); a beat slower than other providers
  inject: "queue",
  resume: "native",
  modelSwitch: "spawn",
  permissionCallback: false,  // can only pre-allow via permissions.allow; denials are known only after the fact
  mcp: "per-process",         // workspace .agents/mcp_config.json + stdio shim + env token
  nativeTools: false,
  attachments: [],            // not tested this time
  slashCommands: true,        // there is --disable-slash-commands, so print mode expands slash commands / skills by default
}
```

## Suggested changes to the design doc

1. §5.1 Antigravity: change to "official headless stream-json, implemented as a separate `provider-agy`", and drop the "community bridge only" claim.
2. New shim pattern: when a provider's MCP config can only live in the cwd or globally and cannot be set per session, use `uniqlaw-mcp-shim`. It is a stdio program that takes the token from an inherited environment variable and forwards to the MCP Gateway. This generalizes: any provider whose MCP can only be configured per process can get per-session identity binding this way.
3. Side effects:
   - `.agents/mcp_config.json` must be written in the **project cwd**, which touches the user's project directory; the adapter should write it once and keep it fixed.
   - agy caches MCP tool schemas in `~/.gemini/antigravity-cli/mcp/<server>/`.
4. With permissionCallback=false, the §6 polyfill's "tighten the allowlist in advance" is correct. In addition, agy's `denied_actions` can be used to notify the operator after the fact: "X was just blocked; add it to the allowlist?"
