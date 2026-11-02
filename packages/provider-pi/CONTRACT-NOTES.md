# provider-pi: notes for core / daemon

No core changes were required. Items for other packages:

1. **Daemon registration.** Add `pi: () => import("@uniqlaw/provider-pi")` to the daemon's built-in plugin map
   (not done here: packages/daemon was out of scope for this change).
2. **`PI_CODING_AGENT_DIR` is process-global.** pi's MCP OAuth store reads it directly, so provider-pi sets it to
   `<stateDir>/pi-agent/<instanceId>`. One daemon = one instance, so this is fine; running two instances in one
   process would need pi to accept the dir per session.
3. **User-level skills load by default.** Even with an isolated agent dir, pi discovers Agent Skills from
   `~/.agents/skills` (seen in tests). This matches Claude loading user skills; profiles can opt out with
   `options.skills: false`, or add dirs with `options.skillPaths`. Project-level `.pi/` resources only load with
   `options.trustProject: true` (default false; provider-pi always passes `resolveProjectTrust`).
4. **Credential scoping.** Each session gets its own `ModelRuntime` with an in-memory credential store holding only
   that profile's credential. Provider-scoped env (AWS profile/region/keys, GCP project/location/ADC file, Azure
   endpoint) goes into the stored credential's `env`, which pi reads before `process.env`. Ambient daemon env is
   still a fallback inside pi (e.g. an unset AWS region falls back to `AWS_REGION` of the daemon process).
5. **Bus tools.** If `spec.nativeTools` is given they are registered in-process and MCP is skipped; otherwise
   `spec.mcp` is attached per session via `registerMcpServer` (tool names `mcp__uniqlaw__<tool>`). Bus tools
   bypass the permission gate.
6. **`detach()`** is not implemented: pi runs in-process, so a daemon restart always re-opens from the persisted
   session file (`<stateDir>/pi-sessions/`).
