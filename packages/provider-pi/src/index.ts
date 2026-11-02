import { definePlugin } from "@uniqlaw/core";
import { PiProvider, configSchema } from "./provider.ts";

export { PiProvider, configSchema, profileOptionsSchema, PI_CAPABILITIES, classifyError, type PiDeps, type PiConfig } from "./provider.ts";
export { decide, excludedTools, summarize, READ_ONLY_TOOLS } from "./policy.ts";

export default definePlugin({
  kind: "provider",
  name: "pi",
  configSchema,
  create: (ctx, cfg) => new PiProvider(cfg, { log: ctx.log, stateDir: ctx.stateDir }),
});
