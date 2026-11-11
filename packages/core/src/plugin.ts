// One plugin shell for every kind (docs §3).
import type { z } from "zod";
import type { AgentProvider } from "./provider.ts";
import type { PlatformAdapter } from "./platform.ts";
import type { MemoryStore } from "./memory.ts";

export interface Logger {
  debug(msg: string, extra?: Record<string, unknown>): void;
  info(msg: string, extra?: Record<string, unknown>): void;
  warn(msg: string, extra?: Record<string, unknown>): void;
  error(msg: string, extra?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

export interface PluginContext {
  log: Logger;
  instanceId: string;
  /** Project root (where `.uniqlaw/` lives). */
  projectDir: string;
  /** `.uniqlaw/` directory. */
  stateDir: string;
  timezone: string;
}

export interface ScheduledFire {
  channelKey: string; job: string; text: string; sourceLine: string;
  deliverTo?: string; raw?: boolean; profile?: string; model?: string;
}

/** What a scheduler plugin may do (docs §3). */
export interface SchedulerApi {
  /** Run a prompt in a session as a scheduled turn. channelKey may be a chat ("telegram:<id>") or an
   *  internal session name ("heartbeat", "cron:<job>"). deliverTo "none" = don't post the final reply.
   *  profile pins the session to a profile (sticky); model switches model for this turn only. */
  fire(o: ScheduledFire): Promise<void>;
  isBusy(channelKey: string): boolean;
  /** Durable per-plugin key/value (e.g. lastFiredAt for catch-up). */
  kvGet(key: string): string | undefined;
  kvSet(key: string, value: string): void;
  /** Run one turn in an internal session and get its final reply (ChannelManager.complete). */
  complete?(o: { channelKey: string; text: string; job: string; profile?: string; model?: string; timeoutMs?: number; fresh?: boolean }): Promise<{ ok: boolean; text: string }>;
  /** UniQlaw memory, when enabled. */
  memory?: MemoryStore;
  /** Leave a note for every open chat session (delivered with its next turn). */
  noteToOpenChats?(label: string, text: string): number;
  /** Set when this start follows a recorded restart / reload / stop (the previous process's restart record). */
  lastRestart?: { kind: "restart" | "reload" | "stop"; stoppedAt: number };
}

/** A tool a plugin contributes to the MCP Gateway. `caller` is the calling session (from its token). */
export interface GatewayTool {
  name: string;
  description: string;
  /** zod raw shape of the arguments. */
  inputSchema: Record<string, z.ZodTypeAny>;
  handler(args: Record<string, unknown>, caller: string): Promise<unknown>;
}

export interface Scheduler {
  start(api: SchedulerApi): void | Promise<void>;
  stop(): void | Promise<void>;
  /** Optional MCP tools for agents (e.g. cron job management). */
  tools?(): GatewayTool[];
  /** Optional manual run (`uniqlaw dream`, POST /api/scheduler/<name>/run). */
  runNow?(opts: Record<string, unknown>): Promise<unknown>;
}

/** An agent reachable through a transport (e.g. a remote A2A agent). Appears in agents_list. */
export interface RemoteAgent {
  /** Unique name, conventionally "<transport>:<name>", e.g. "a2a:research". */
  name: string;
  description?: string;
  ask(o: { from: string; message: string; hop: number; signal?: AbortSignal }): Promise<{ ok: boolean; text: string }>;
}

export interface TransportApi {
  /** Run an inbound request from a remote agent against a local profile. Resolves with the answer. */
  runInbound(o: { profile: string; remote: string; contextId: string; taskId: string; text: string; hop: number }): Promise<{ ok: boolean; text: string }>;
  /** Profiles that may be exposed (name + provider). */
  profiles(): { name: string; provider: string }[];
  maxHops: number;
}

export interface Transport {
  start(api: TransportApi): void | Promise<void>;
  stop(): void | Promise<void>;
  remoteAgents?(): RemoteAgent[];
  /** Actual listening ports after start() (published in runtime.json), e.g. { a2a: 41234, "a2a-grpc": 41235 }. */
  ports?(): Record<string, number>;
}

/** Speech-to-text for inbound voice/audio (settings `transcription.engine` names the plugin). */
export interface Transcriber {
  /** Transcribe a local audio file; returns plain text ("" if nothing was said). Throws on failure. */
  transcribe(input: { path: string; mime?: string; language?: string; signal?: AbortSignal }): Promise<string>;
  stop?(): void | Promise<void>;
}

export interface PluginInstanceMap {
  provider: AgentProvider;
  platform: PlatformAdapter;
  scheduler: Scheduler;
  transport: Transport;
  transcriber: Transcriber;
}
export type PluginKind = keyof PluginInstanceMap;

export interface PluginDef<K extends PluginKind = PluginKind, S extends z.ZodTypeAny = z.ZodTypeAny> {
  kind: K;
  name: string;
  configSchema: S;
  create(ctx: PluginContext, cfg: z.infer<S>): Promise<PluginInstanceMap[K]> | PluginInstanceMap[K];
}

export function definePlugin<K extends PluginKind, S extends z.ZodTypeAny>(def: PluginDef<K, S>): PluginDef<K, S> {
  return def;
}
