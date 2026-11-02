import { z } from "zod";
import { definePlugin } from "@uniqlaw/core";
import { AgyProvider } from "./provider.ts";

export const configSchema = z.object({
  enabled: z.boolean().default(true),
  agyPath: z.string().default("agy"),
  shimCommand: z.array(z.string()).min(1).optional(),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
  extraArgs: z.array(z.string()).default([]),
  isolateHome: z.boolean().default(false),
}).passthrough();

export default definePlugin({
  kind: "provider",
  name: "agy",
  configSchema,
  create(ctx, cfg) {
    return new AgyProvider(cfg, { log: ctx.log.child("agy"), stateDir: ctx.stateDir });
  },
});

export { AgyProvider, defaultShimCommand } from "./provider.ts";
export { AgySession } from "./session.ts";
export * from "./mapping.ts";
