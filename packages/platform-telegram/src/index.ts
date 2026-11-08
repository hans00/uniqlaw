import { join } from "node:path";
import { z } from "zod";
import { definePlugin, resolveSecret, type SecretRef } from "@uniqlaw/core";
import { TelegramAdapter } from "./adapter.ts";

const secretRef = z.union([
  z.object({ env: z.string() }),
  z.object({ file: z.string() }),
  z.object({ command: z.string() }),
]);
const id = z.union([z.string(), z.number()]).transform(String);

export const telegramConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /** Bot token: prefer {env}/{file}/{command}; a literal string is accepted (v2 compat). */
  token: z.union([z.string().min(1), secretRef]),
  /** Users whose messages are accepted. Empty = nobody (fail closed). */
  allowedUserIds: z.array(id).default([]),
  /** When set, group messages are only accepted from these chat ids. */
  allowedGroupIds: z.array(id).default([]),
  /** Who may answer approvals / receives operator notifications. Default = allowedUserIds. */
  operatorUserIds: z.array(id).optional(),
  pollSeconds: z.number().int().min(0).max(50).default(25),
  /** Bot API base URL (override for tests / self-hosted Bot API server). */
  apiBase: z.string().url().default("https://api.telegram.org"),
});

export type TelegramConfig = z.infer<typeof telegramConfigSchema>;

export default definePlugin({
  kind: "platform",
  name: "telegram",
  configSchema: telegramConfigSchema,
  async create(ctx, cfg) {
    const token = typeof cfg.token === "string" ? cfg.token : await resolveSecret(cfg.token as SecretRef);
    return new TelegramAdapter({
      token,
      apiBase: cfg.apiBase.replace(/\/+$/, ""),
      allowedUserIds: cfg.allowedUserIds,
      allowedGroupIds: cfg.allowedGroupIds,
      operatorUserIds: cfg.operatorUserIds ?? cfg.allowedUserIds,
      pollSeconds: cfg.pollSeconds,
      attachmentsDir: join(ctx.stateDir, "attachments"),
      log: ctx.log.child("telegram"),
    });
  },
});

export { TelegramAdapter, startTypingPulse } from "./adapter.ts";
export { markdownToTelegramHtml, chunkHtml, chunkText } from "./format.ts";
