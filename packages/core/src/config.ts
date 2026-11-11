// `.uniqlaw/settings.json` schema. Plugin sections (`plugins.<name>`) are validated
// by each plugin's own configSchema; everything else is validated here.
import { z } from "zod";

const secretRef = z.union([
  z.object({ env: z.string() }),
  z.object({ file: z.string() }),
  z.object({ command: z.string() }),
]);

/** A secret reference ({env} | {file} | {command}); backends validate their own credential option with it. */
export const secretRefSchema = secretRef;

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

const judgeThreshold = z.union([z.number().min(0).max(1), z.literal("off")]);
/** permissions.approval.judge (docs §10.4). Absent or mode "off" = no judge. */
export const approvalJudgeSchema = z.object({
  provider: z.string(),
  mode: z.enum(["off", "shadow", "enforce"]).default("off"),
  /** Backend settings (baseUrl, model, credential, authHeader, headers, …), validated by the backend. */
  options: z.record(z.string(), z.unknown()).prefault({}),
  /** Shorthands for options.credential / options.model. */
  credential: secretRef.optional(),
  model: z.string().optional(),
  allowAbove: z.number().min(0).max(1).default(0.9),
  byKind: z.object({
    chat: judgeThreshold.default(0.9),
    worker: judgeThreshold.default(0.93),
    cron: judgeThreshold.default(0.97),
    peer: judgeThreshold.default(0.97),
    /** Accepted for symmetry, ignored: inbound A2A sessions are never auto-allowed. */
    a2a: judgeThreshold.optional(),
  }).prefault({}),
  timeoutMs: z.number().int().positive().default(5000),
  audit: z.boolean().default(true),
  /** Escalate when the judge's "induced by content" probability reaches this (or it answers "unclear"). */
  inducedAbove: z.number().min(0).max(1).default(0.5),
  /** Taint tracking: untrusted content that entered the agent's context this turn (docs §10.4). */
  taint: z.object({
    enabled: z.boolean().default(true),
    /** Threshold for a tainted request with a high-impact effect or an external / remote / global / protected target. */
    taintedAbove: z.number().min(0).max(1).default(0.97),
    /** Keep taint for the rest of the session instead of resetting it each turn. */
    sticky: z.boolean().default(false),
    /** Reads of files the project's git tracks are not taint (set false to treat the own repo as untrusted). */
    trustRepoFiles: z.boolean().default(true),
    /** Effects that count as high impact under taint. */
    highImpactEffects: z.array(z.enum(["read", "create", "modify", "delete", "execute", "send", "install", "publish"])).default(["send", "publish", "delete", "install"]),
    /** Tool-name patterns (regex, case-insensitive) of MCP tools whose results are third-party content; replaces the defaults. */
    thirdPartyTools: z.array(z.string()).optional(),
  }).prefault({}),
});

export const permissionSchema = z.object({
  level: z.enum(["locked", "strict", "moderate", "unrestricted"]).default("moderate"),
  allowTools: z.array(z.string()).default([]),
  denyTools: z.array(z.string()).default([]),
  approval: z.object({
    mode: z.enum(["ask-operator", "auto-deny", "auto-allow"]).default("ask-operator"),
    /** Seconds to wait for the operator before denying; 0 = wait indefinitely. */
    timeoutSec: z.number().int().nonnegative().default(300),
    judge: approvalJudgeSchema.optional(),
  }).prefault({}),
  dirScope: z.array(z.string()).optional(),
});

export const profileSchema = z.object({
  provider: z.string(),
  model: z.string().optional(),
  credential: z.string().optional(),
  permissions: permissionSchema.prefault({}),
  /** Prompt fragment files (relative to project dir), appended in order. */
  prompts: z.array(z.string()).optional(),
  /** Provider-specific options. */
  options: z.record(z.string(), z.unknown()).prefault({}),
  /** Profiles to offer when this one hits its usage limit (the owner is asked in chat). Empty = every other profile. */
  fallback: z.array(z.string()).default([]),
});

// Fields without defaults: per-channel entries (`groups.channels.<key>`) must carry only what the user set, or
// zod's defaults would overwrite the global `groups` values when merged.
const groupFields = {
  /** mention: only messages addressed to the bot (@mention, reply to the bot, command) start a turn; the rest is
   *  kept as context for the next turn. always: every message starts a turn and the agent decides whether to answer. */
  mode: z.enum(["mention", "always"]),
  /** always mode: a message that @mentions someone else but not the bot is context only (v2 `ignoreOtherMentions`). */
  ignoreOtherMentions: z.boolean(),
  /** How many unanswered messages are kept as context for the next turn (0 = none). */
  historyLimit: z.number().int().nonnegative(),
  /** Platform user ids allowed to wake the agent in this group: "telegram:<from.id>", "discord:<author.id>", …
   *  (in a per-channel entry a bare id means that channel's platform; in the global list it matches no one). Matched on the platform's immutable user id,
   *  never a name. Empty = anyone the platform lets through. */
  allowFrom: z.array(z.string()),
  /** Messages that don't wake the agent: context = kept as background for the next woken turn; ignore = dropped. */
  others: z.enum(["context", "ignore"]),
};
const groupSchema = z.object({
  mode: groupFields.mode.default("mention"),
  ignoreOtherMentions: groupFields.ignoreOtherMentions.default(false),
  historyLimit: groupFields.historyLimit.default(30),
  allowFrom: groupFields.allowFrom.default([]),
  others: groupFields.others.default("context"),
});
const groupChannelSchema = z.object(groupFields).partial();
export type GroupMode = z.infer<typeof groupSchema>["mode"];

/** Tool groups a channel can be given (see TOOL_GROUPS in channel-policy.ts for the concrete tools). */
export const TOOL_GROUP_NAMES = ["chat", "memory", "web", "files.read", "files.write", "bash", "agents", "cron", "worker", "xsession", "notify", "config"] as const;
const toolGroup = z.enum(TOOL_GROUP_NAMES);
const channelPolicySchema = z.object({
  /** Allowed tool groups; "*" = every group, plus UniQlaw plugin tools no group names. MCP servers from the user's own
   *  Claude Code config are cut by any policy (--strict-mcp-config), "*" included once `deny` makes it a policy. */
  tools: z.union([z.literal("*"), z.array(toolGroup)]).optional(),
  /** Groups subtracted from `tools`. */
  deny: z.array(toolGroup).optional(),
});
export type ChannelPolicyConfig = z.infer<typeof channelPolicySchema>;

export const settingsSchema = z.object({
  instance: z.object({
    id: z.string().regex(/^[a-z0-9-]{1,32}$/).optional(),
    name: z.string().optional(),
  }).prefault({}),
  timezone: z.string().default("UTC"),
  credentials: z.record(z.string(), credentialSchema).prefault({}),
  profiles: z.record(z.string(), profileSchema).prefault({ main: { provider: "claude-tmux" } as never }),
  bindings: z.object({
    default: z.string().default("main"),
    /** channelKey → profile name */
    channels: z.record(z.string(), z.string()).prefault({}),
  }).prefault({}),
  prompts: z.object({
    /** Default prompt fragments for all profiles (relative paths). */
    files: z.array(z.string()).default(["prompts/IDENTITY.md", "prompts/USER.md", "prompts/SOUL.md"]),
  }).prefault({}),
  queue: z.object({
    mode: z.enum(["queue", "steer", "interrupt"]).default("queue"),
    debounceMs: z.number().int().nonnegative().default(1500),
    cap: z.number().int().positive().default(20),
    dropPolicy: z.enum(["old", "new", "summarize"]).default("summarize"),
  }).prefault({}),
  /** Per-channel capabilities: what a chat's session may do, keyed by channel key ("telegram:<chatId>",
   *  "discord:<channelId>", …; a Slack thread key falls back to its channel). "defaults" applies to chats with no
   *  entry. No "defaults" = every chat keeps all tools (the behavior before this setting existed). Only chat
   *  sessions are affected: cron jobs, workers, heartbeat and A2A sessions keep their own settings. */
  channels: z.record(z.string(), channelPolicySchema).prefault({}),
  /** Group chats (multiparty channels). DMs are never gated. */
  groups: groupSchema.extend({
    /** Per-channel overrides, keyed by channel key ("telegram:<chatId>", "discord:<channelId>", "slack:<channel>", …).
     *  A Slack thread key ("slack:<channel>:<ts>") falls back to its channel's entry. */
    channels: z.record(z.string(), groupChannelSchema).prefault({}),
  }).prefault({}),
  sessionCleanup: z.object({
    idleTimeoutHours: z.number().nonnegative().default(168),
    checkIntervalMinutes: z.number().positive().default(30),
  }).prefault({}),
  backgroundNotify: z.object({ mode: z.enum(["last", "all", "off"]).default("last") }).prefault({}),
  output: z.object({
    toolStatus: z.boolean().default(true),
    thinking: z.boolean().default(false),
    /** Edit-in-place streaming for platforms that support edits. */
    stream: z.enum(["replace", "keep", "off"]).default("replace"),
  }).prefault({}),
  turn: z.object({
    /** Abandon a turn after this long with no provider events (0 = off). Paused while a
     *  permission/input request waits for a human. Raise it for long silent tools. */
    stallTimeoutSec: z.number().int().nonnegative().default(900),
  }).prefault({}),
  /** Graceful restart / reload (`uniqlaw restart`, `uniqlaw reload`, daemon_restart): new turns wait, running ones
   *  get this long to finish; turns still running then are recorded as interrupted and their sessions told. */
  restart: z.object({
    drainTimeoutSec: z.number().int().nonnegative().default(120),
  }).prefault({}),
  bus: z.object({
    maxHops: z.number().int().positive().default(4),
    /** Async agent_ask results that may drive a session in a row (result → ask → result …) before a human
     *  message resets the count. Results don't deepen the hop, so this is what bounds such rounds. */
    maxRounds: z.number().int().positive().default(20),
    /** Async agent_ask / agent_trigger / worker_start tasks one session may have outstanding at once (bounds fan-out). */
    maxPending: z.number().int().positive().default(8),
    /** agent_ask / agent_trigger / worker_start calls (waiting or not) one delegation chain may make in total, across
     *  every session it reaches. A chain starts with a human message (or a turn no human started). */
    maxChainTasks: z.number().int().positive().default(50),
    askTimeoutSec: z.number().int().positive().default(600),
  }).prefault({}),
  /** Worker sessions: other coding agents a session can start in a chosen directory (worker_start). */
  workers: z.object({
    /** Directories a worker may run in (it may also use any subdirectory). `~` is expanded.
     *  Empty = the project directory only. */
    roots: z.array(z.string()).default([]),
    /** Profiles a worker may use. Empty = any profile. */
    profiles: z.array(z.string()).default([]),
    max: z.number().int().positive().default(8),
  }).prefault({}),
  /** Switching a chat between profiles (/profile, usage-limit fallback): the conversation moves as raw transcript. */
  profileSwitch: z.object({
    /** Budget for the transcript handed to the new profile (newest entries win). */
    handoffMaxChars: z.number().int().positive().default(60_000),
  }).prefault({}),
  /** Inbound voice/audio. Default: the agent gets the file path and handles it itself. Set `engine` to a
   *  transcriber plugin ("whisper" = local whisper.cpp, "transcribe-api" = OpenAI-compatible API) to add a transcript. */
  transcription: z.object({
    engine: z.string().default("none"),
    /** unsupported: only when the session's provider can't take audio itself; always: every voice/audio attachment. */
    when: z.enum(["unsupported", "always"]).default("unsupported"),
    /** Language hint (ISO 639-1, e.g. "zh", "en"); "auto" = detect. */
    language: z.string().default("auto"),
    /** Skip clips longer than this (seconds, when the platform reports a duration). */
    maxSeconds: z.number().positive().default(600),
  }).prefault({}),
  /** DM pairing: a stranger who DMs the bot gets a code; an operator approves it (`/pair approve <code>` or
   *  `uniqlaw pairing approve <code>`). Approved users are accepted like allowedUserIds but are not operators. */
  pairing: z.object({
    enabled: z.boolean().default(true),
    ttlMinutes: z.number().positive().default(60),
    /** Open requests per platform; further strangers are ignored until one is answered or expires. */
    maxPending: z.number().int().positive().default(3),
  }).prefault({}),
  /** send_file: which local files an agent may post to a chat. Always allowed: the project directory, the
   *  session's working directory, workers.roots and the system temp directory. */
  files: z.object({
    roots: z.array(z.string()).default([]),
    maxMB: z.number().positive().default(50),
  }).prefault({}),
  /** UniQlaw's own long-term memory (memory/MEMORY.md + daily notes), shared by every session. */
  memory: z.object({
    enabled: z.boolean().default(true),
    /** Directory relative to the project. */
    dir: z.string().default("memory"),
    /** Bytes of MEMORY.md injected into prompts. */
    maxInjectBytes: z.number().int().positive().default(24_000),
    /** Keep provider-native memory too (Claude Code auto-memory / auto-dream). Off = UniQlaw memory only. */
    nativeMemory: z.boolean().default(false),
  }).prefault({}),
  mcpGateway: z.object({ host: z.string().default("127.0.0.1"), port: z.number().int().nonnegative().default(0) }).prefault({}),
  web: z.object({
    enabled: z.boolean().default(true),
    host: z.string().default("127.0.0.1"),
    port: z.number().int().nonnegative().default(0),
    /** Required (Bearer header or `uq_token` cookie) when host is not loopback. */
    token: secretRef.optional(),
  }).prefault({}),
  /** plugin name → plugin config (must include `enabled`). */
  plugins: z.record(z.string(), z.object({ enabled: z.boolean().default(true) }).passthrough()).prefault({}),
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
