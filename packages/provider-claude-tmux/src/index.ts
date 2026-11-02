import { z } from "zod";
import { definePlugin } from "@uniqlaw/core";
import { ClaudeTmuxProvider } from "./provider.ts";

export const configSchema = z.object({
  enabled: z.boolean().default(true),
  claudePath: z.string().default("claude"),
  readyTimeoutMs: z.number().int().positive().default(90_000),
  width: z.number().int().positive().default(200),
  height: z.number().int().positive().default(50),
  takeOverLegacy: z.boolean().default(true),
  timings: z.record(z.number()).optional(),
}).passthrough();

export default definePlugin({
  kind: "provider",
  name: "claude-tmux",
  configSchema,
  create(ctx, cfg) {
    return new ClaudeTmuxProvider(cfg, { log: ctx.log.child("claude-tmux"), stateDir: ctx.stateDir });
  },
});

export { ClaudeTmuxProvider, slug } from "./provider.ts";
export { ClaudeTmuxSession, CLAUDE_TMUX_CAPABILITIES, DEFAULT_TIMINGS } from "./session.ts";
export { findLegacySessions, killLegacySessions } from "./legacy.ts";
export { looksActivelyBusy, isReady, isRecoverableApiError } from "./pane.ts";
export { parsePermissionDialog, parseLoginPrompt } from "./dialogs.ts";
