import { z } from "zod";
import { definePlugin } from "@uniqlaw/core";
import { OpencodeProvider } from "./provider.ts";

export const configSchema = z.object({
  enabled: z.boolean().default(true),
  opencodePath: z.string().default("opencode"),
  startTimeoutMs: z.number().int().positive().default(30_000),
  defaultModel: z.string().optional(),
}).passthrough();

export default definePlugin({
  kind: "provider",
  name: "opencode",
  configSchema,
  create(ctx, cfg) {
    return new OpencodeProvider(cfg, { log: ctx.log.child("opencode"), stateDir: ctx.stateDir });
  },
});

export { OpencodeProvider } from "./provider.ts";
export { OpencodeSession, OPENCODE_CAPABILITIES } from "./session.ts";
export { permissionRules, parseModel, errorCode, configContent, serveEnv, homeFor, toOpencodePermission } from "./mapping.ts";
