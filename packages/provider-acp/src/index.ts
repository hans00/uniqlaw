import { z } from "zod";
import { definePlugin } from "@uniqlaw/core";
import { AcpProvider } from "./provider.ts";

export const configSchema = z.object({
  enabled: z.boolean().default(true),
  command: z.array(z.string()).min(1).default(["opencode", "acp"]),
  env: z.record(z.string()).default({}),
  preset: z.enum(["auto", "opencode", "generic"]).default("auto"),
  /** Share one agent process across sessions. Only for agents that pass the S6b isolation contract test. */
  shareProcess: z.boolean().default(false),
  startTimeoutMs: z.number().int().positive().default(30_000),
}).passthrough();

export default definePlugin({
  kind: "provider",
  name: "acp",
  configSchema,
  create(ctx, cfg) {
    return new AcpProvider(cfg, { log: ctx.log.child("acp"), stateDir: ctx.stateDir });
  },
});

export { AcpProvider } from "./provider.ts";
export { AcpSession } from "./session.ts";
export { AcpAgent } from "./agent.ts";
export { pickOption, errorCode, stopReasonToEnd, promptBlocks, elicitationContent, capabilitiesFor, opencodeLogError } from "./mapping.ts";
