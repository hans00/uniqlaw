import { join } from "node:path";
import { z } from "zod";
import { definePlugin, resolveSecret, type SecretRef } from "@uniqlaw/core";
import { LineAdapter } from "./adapter.ts";

const secretRef = z.union([z.object({ env: z.string() }), z.object({ file: z.string() }), z.object({ command: z.string() })]);
const secret = z.union([z.string(), secretRef]);

/** Accepts the v2 `line` block as copied over by docs/MIGRATE.md. */
export const lineConfigSchema = z.object({
  enabled: z.boolean().default(true),
  channelAccessToken: secret,
  channelSecret: secret,
  webhookPath: z.string().startsWith("/").default("/line/webhook"),
  /** 0 = pick a free port (logged). Expose it publicly yourself (tunnel / reverse proxy). */
  webhookPort: z.number().int().min(0).max(65535).default(0),
  /** v2 listened on 0.0.0.0; use 127.0.0.1 when a local tunnel (cloudflared…) fronts it. */
  webhookHost: z.string().default("0.0.0.0"),
  /** Users whose messages are accepted (DMs and groups). Empty + no groups = nobody (fail closed). */
  allowedUserIds: z.array(z.string()).default([]),
  /** Groups/rooms where anyone may talk to the bot. */
  allowedGroupIds: z.array(z.string()).default([]),
  /** Who may answer approvals / receives operator pushes. Default = allowedUserIds. */
  operatorUserIds: z.array(z.string()).optional(),
  apiBase: z.string().url().default("https://api.line.me"),
  dataApiBase: z.string().url().default("https://api-data.line.me"),
}).passthrough();

export type LineConfig = z.infer<typeof lineConfigSchema>;

const resolve = async (t: string | SecretRef) => (typeof t === "string" ? t : resolveSecret(t));

export default definePlugin({
  kind: "platform",
  name: "line",
  configSchema: lineConfigSchema,
  async create(ctx, cfg) {
    const channelAccessToken = await resolve(cfg.channelAccessToken as string | SecretRef);
    const channelSecret = await resolve(cfg.channelSecret as string | SecretRef);
    if (!channelAccessToken || !channelSecret) throw new Error("line: channelAccessToken and channelSecret are required");
    return new LineAdapter({
      channelAccessToken, channelSecret,
      webhookHost: cfg.webhookHost, webhookPort: cfg.webhookPort, webhookPath: cfg.webhookPath,
      apiBase: cfg.apiBase.replace(/\/+$/, ""), dataApiBase: cfg.dataApiBase.replace(/\/+$/, ""),
      allowedUserIds: cfg.allowedUserIds, allowedGroupIds: cfg.allowedGroupIds,
      operatorUserIds: cfg.operatorUserIds ?? cfg.allowedUserIds,
      attachmentsDir: join(ctx.stateDir, "attachments"),
      log: ctx.log.child("line"),
    });
  },
});

export { LineAdapter } from "./adapter.ts";
export { markdownToPlain } from "./format.ts";
