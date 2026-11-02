// `.uniqlaw/settings.json` schema. Plugin sections (`plugins.<name>`) are validated
// by each plugin's own configSchema; everything else is validated here.
import { z } from "zod";

const secretRef = z.union([
  z.object({ env: z.string() }),
  z.object({ file: z.string() }),
  z.object({ command: z.string() }),
]);

export const credentialSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("anthropic-api-key"), key: secretRef }),
  z.object({ kind: z.literal("openai-api-key"), key: secretRef, baseUrl: z.string().optional(), org: z.string().optional() }),
  z.object({ kind: z.literal("gemini-api-key"), key: secretRef }),
  z.object({ kind: z.literal("openai-compatible"), baseUrl: z.string(), key: secretRef.optional() }),
  z.object({ kind: z.literal("aws"), region: z.string(), profile: z.string().optional(), roleArn: z.string().optional(),
    accessKey: secretRef.optional(), secretKey: secretRef.optional(), sessionToken: secretRef.optional() }),
  z.object({ kind: z.literal("gcp"), project: z.string(), location: z.string(),
    serviceAccountFile: z.string().optional(), impersonate: z.string().optional() }),
  z.object({ kind: z.literal("azure"), endpoint: z.string(), deployment: z.string().optional(), apiVersion: z.string().optional(),
    auth: z.union([z.object({ type: z.literal("api-key"), key: secretRef }), z.object({ type: z.literal("entra") })]) }),
  z.object({ kind: z.literal("provider-login"), provider: z.string(), home: z.string().optional() }),
]);

export const permissionSchema = z.object({
  level: z.enum(["locked", "strict", "moderate", "unrestricted"]).default("moderate"),
  allowTools: z.array(z.string()).default([]),
  denyTools: z.array(z.string()).default([]),
  approval: z.object({
    mode: z.enum(["ask-operator", "auto-deny", "auto-allow"]).default("ask-operator"),
    timeoutSec: z.number().int().positive().default(300),
  }).default({}),
  dirScope: z.array(z.string()).optional(),
});

export const profileSchema = z.object({
  provider: z.string(),
  model: z.string().optional(),
  credential: z.string().optional(),
  permissions: permissionSchema.default({}),
  /** Prompt fragment files (relative to project dir), appended in order. */
  prompts: z.array(z.string()).optional(),
  /** Provider-specific options. */
  options: z.record(z.unknown()).default({}),
});

export const settingsSchema = z.object({
  instance: z.object({
    id: z.string().regex(/^[a-z0-9-]{1,32}$/).optional(),
    name: z.string().optional(),
  }).default({}),
  timezone: z.string().default("UTC"),
  credentials: z.record(credentialSchema).default({}),
  profiles: z.record(profileSchema).default({ main: { provider: "claude-tmux" } as never }),
  bindings: z.object({
    default: z.string().default("main"),
    /** channelKey → profile name */
    channels: z.record(z.string()).default({}),
  }).default({}),
  prompts: z.object({
    /** Default prompt fragments for all profiles (relative paths). */
    files: z.array(z.string()).default(["prompts/IDENTITY.md", "prompts/USER.md", "prompts/SOUL.md"]),
  }).default({}),
  queue: z.object({
    mode: z.enum(["queue", "steer", "interrupt"]).default("queue"),
    debounceMs: z.number().int().nonnegative().default(1500),
    cap: z.number().int().positive().default(20),
    dropPolicy: z.enum(["old", "new", "summarize"]).default("summarize"),
  }).default({}),
  sessionCleanup: z.object({
    idleTimeoutHours: z.number().nonnegative().default(168),
    checkIntervalMinutes: z.number().positive().default(30),
  }).default({}),
  backgroundNotify: z.object({ mode: z.enum(["last", "all", "off"]).default("last") }).default({}),
  output: z.object({
    toolStatus: z.boolean().default(true),
    thinking: z.boolean().default(false),
    /** Edit-in-place streaming for platforms that support edits. */
    stream: z.enum(["replace", "keep", "off"]).default("replace"),
  }).default({}),
  turn: z.object({
    /** Abandon a turn after this long with no provider events (0 = off). Paused while a
     *  permission/input request waits for a human. Raise it for long silent tools. */
    stallTimeoutSec: z.number().int().nonnegative().default(900),
  }).default({}),
  bus: z.object({
    maxHops: z.number().int().positive().default(4),
    askTimeoutSec: z.number().int().positive().default(600),
  }).default({}),
  mcpGateway: z.object({ host: z.string().default("127.0.0.1"), port: z.number().int().nonnegative().default(0) }).default({}),
  web: z.object({
    enabled: z.boolean().default(true),
    host: z.string().default("127.0.0.1"),
    port: z.number().int().nonnegative().default(0),
    /** Required (Bearer header or `uq_token` cookie) when host is not loopback. */
    token: secretRef.optional(),
  }).default({}),
  /** plugin name → plugin config (must include `enabled`). */
  plugins: z.record(z.object({ enabled: z.boolean().default(true) }).passthrough()).default({}),
});

export type Settings = z.infer<typeof settingsSchema>;
export type ProfileConfig = z.infer<typeof profileSchema>;
export type QueueMode = Settings["queue"]["mode"];

export function parseSettings(raw: unknown): Settings {
  const r = settingsSchema.safeParse(raw);
  if (!r.success) {
    const msg = r.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    throw new Error(`invalid settings.json:\n${msg}`);
  }
  return r.data;
}
