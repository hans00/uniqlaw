import { z } from "zod";
import { definePlugin } from "@uniqlaw/core";
import { CodexProvider } from "./provider.ts";

export const configSchema = z.object({
  enabled: z.boolean().default(true),
  codexPath: z.string().default("codex"),
  effort: z.string().optional(),
  extraArgs: z.array(z.string()).default([]),
  idleKillMs: z.number().int().nonnegative().default(60_000),
}).passthrough();

export default definePlugin({
  kind: "provider",
  name: "codex",
  configSchema,
  create(ctx, cfg) {
    return new CodexProvider(cfg, { log: ctx.log.child("codex") });
  },
});

export { CodexProvider } from "./provider.ts";
export { CodexSession, CODEX_CAPABILITIES } from "./session.ts";
export { policyFor, threadConfig, processArgs, credentialSetup, toolFromItem, errorCode, DISABLED_FEATURES } from "./mapping.ts";
