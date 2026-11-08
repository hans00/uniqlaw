import { join } from "node:path";
import { z } from "zod";
import { definePlugin, resolveSecret, type SecretRef } from "@uniqlaw/core";
import { DiscordAdapter } from "./adapter.ts";

const secretRef = z.union([z.object({ env: z.string() }), z.object({ file: z.string() }), z.object({ command: z.string() })]);
const id = z.union([z.string(), z.number()]).transform(String);

/** Accepts the v2 `discord` block as copied over by docs/MIGRATE.md (incl. messageStream). */
export const discordConfigSchema = z.object({
  enabled: z.boolean().default(true),
  token: z.union([z.string().min(1), secretRef]),
  /** Users whose messages are accepted. Empty = nobody (fail closed; v2 allowed everyone). */
  allowedUserIds: z.array(id).default([]),
  allowedBotIds: z.array(id).default([]),
  /** Who may answer approvals / receives operator DMs. Default = allowedUserIds. */
  operatorUserIds: z.array(id).optional(),
  /** Guild channels the bot participates in (keyed by channel id). Unlisted guild channels are ignored. */
  channels: z.record(z.object({
    enabled: z.boolean().default(true),
    requireMention: z.boolean().default(false),
    ignoreOtherMentions: z.boolean().default(false),
  }).passthrough()).default({}),
  apiBase: z.string().url().default("https://discord.com/api/v10"),
  gatewayUrl: z.string().default("wss://gateway.discord.gg/?v=10&encoding=json"),
  cdnBase: z.string().url().default("https://media.discordapp.net"),
}).passthrough();

export type DiscordConfig = z.infer<typeof discordConfigSchema>;

export default definePlugin({
  kind: "platform",
  name: "discord",
  configSchema: discordConfigSchema,
  async create(ctx, cfg) {
    const token = typeof cfg.token === "string" ? cfg.token : await resolveSecret(cfg.token as SecretRef);
    return new DiscordAdapter({
      token,
      apiBase: cfg.apiBase.replace(/\/+$/, ""),
      gatewayUrl: cfg.gatewayUrl,
      cdnBase: cfg.cdnBase.replace(/\/+$/, ""),
      allowedUserIds: cfg.allowedUserIds,
      allowedBotIds: cfg.allowedBotIds,
      operatorUserIds: cfg.operatorUserIds ?? cfg.allowedUserIds,
      channels: Object.fromEntries(Object.entries(cfg.channels).map(([k, v]) => [k, { enabled: v.enabled, requireMention: v.requireMention, ignoreOtherMentions: v.ignoreOtherMentions }])),
      attachmentsDir: join(ctx.stateDir, "attachments"),
      log: ctx.log.child("discord"),
    });
  },
});

export { DiscordAdapter } from "./adapter.ts";
