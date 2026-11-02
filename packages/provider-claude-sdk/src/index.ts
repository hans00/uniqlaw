import { z } from "zod";
import { definePlugin, type AgentProvider, type AgentSession, type Logger, type Profile, type SessionSpec } from "@uniqlaw/core";
import { CLAUDE_SDK_CAPABILITIES, ClaudeSdkSession, type ClaudeSdkConfig } from "./session.ts";

export const configSchema = z.object({
  enabled: z.boolean().default(true),
  /** Path to a claude executable; default = the SDK's bundled binary. */
  claudePath: z.string().optional(),
  extraArgs: z.record(z.string().nullable()).optional(),
}).passthrough();

export class ClaudeSdkProvider implements AgentProvider {
  readonly name = "claude-sdk";
  constructor(private cfg: ClaudeSdkConfig, private log: Logger) {}
  capabilities(_p: Profile) { return CLAUDE_SDK_CAPABILITIES; }
  async open(spec: SessionSpec): Promise<AgentSession> {
    const s = new ClaudeSdkSession(spec, this.cfg, this.log.child(spec.sessionId));
    await s.start();
    return s;
  }
}

export default definePlugin({
  kind: "provider",
  name: "claude-sdk",
  configSchema,
  create(ctx, cfg) {
    return new ClaudeSdkProvider(cfg, ctx.log.child("claude-sdk"));
  },
});

export { ClaudeSdkSession, CLAUDE_SDK_CAPABILITIES } from "./session.ts";
export { SdkMapper, classifyError } from "./mapper.ts";
