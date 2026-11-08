import { join } from "node:path";
import { z } from "zod";
import { definePlugin, resolveSecret, type SecretRef } from "@uniqlaw/core";
import { SlackAdapter } from "./adapter.ts";

const secretRef = z.union([z.object({ env: z.string() }), z.object({ file: z.string() }), z.object({ command: z.string() })]);
const token = z.union([z.string(), secretRef]);
const mode = z.enum(["channel", "thread-per-message"]);

/** Accepts the v2 `slack` block as copied over by docs/MIGRATE.md (incl. messageStream). */
export const slackConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /** xapp-… app-level token (Socket Mode). */
  appToken: token,
  /** xoxb-… bot token (Web API). */
  botToken: token,
  /** Users whose messages are accepted. Empty = nobody (fail closed; v2 allowed everyone). */
  allowedUserIds: z.array(z.string()).default([]),
  allowedBotIds: z.array(z.string()).default([]),
  /** Who may answer approvals / receives operator DMs. Default = allowedUserIds. */
  operatorUserIds: z.array(z.string()).optional(),
  defaultMode: mode.default("channel"),
  channels: z.record(z.object({ mode: mode.optional() }).passthrough()).default({}),
  webApiBase: z.string().url().default("https://slack.com/api"),
}).passthrough();

export type SlackConfig = z.infer<typeof slackConfigSchema>;

const resolve = async (t: string | SecretRef) => (typeof t === "string" ? t : resolveSecret(t));

export default definePlugin({
  kind: "platform",
  name: "slack",
  configSchema: slackConfigSchema,
  async create(ctx, cfg) {
    const appToken = await resolve(cfg.appToken as string | SecretRef);
    const botToken = await resolve(cfg.botToken as string | SecretRef);
    if (!appToken || !botToken) throw new Error("slack: both appToken (xapp-…) and botToken (xoxb-…) are required");
    return new SlackAdapter({
      appToken, botToken,
      webApiBase: cfg.webApiBase.replace(/\/+$/, ""),
      allowedUserIds: cfg.allowedUserIds,
      allowedBotIds: cfg.allowedBotIds,
      operatorUserIds: cfg.operatorUserIds ?? cfg.allowedUserIds,
      defaultMode: cfg.defaultMode,
      channelModes: Object.fromEntries(Object.entries(cfg.channels).map(([k, v]) => [k, v.mode])),
      attachmentsDir: join(ctx.stateDir, "attachments"),
      log: ctx.log.child("slack"),
    });
  },
});

export { SlackAdapter } from "./adapter.ts";
export { markdownToMrkdwn, slackReactionName } from "./format.ts";
