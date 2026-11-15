// Chat platform contract. Platforms translate native updates to InboundMessage
// and render outbound text/buttons/reactions. All routing logic lives in core.
import type { Attachment } from "./provider.ts";

/** Where to deliver output. `chatId` is the platform-native chat/channel id. */
export interface Target {
  platform: string;
  chatId: string;
  threadId?: string;
  /** Reply to (quote) this message when posting. */
  replyToMessageId?: string;
}

export interface MsgRef {
  platform: string;
  chatId: string;
  messageId: string;
  threadId?: string;
}

export interface Sender {
  id: string;
  name: string;
  username?: string;
  isBot?: boolean;
}

/** The message an inbound message replies to (Telegram reply_to_message, Discord message reference). */
export interface ReplyContext {
  /** Platform message id of the replied message (turn metadata; not shown to the agent). */
  messageId: string;
  /** Display name of its author. */
  author: string;
  /** It is the bot's own message (shown as "you"). */
  fromBot: boolean;
  /** When it was sent (epoch ms), if known. */
  sentAt?: number;
  /** Already shortened (replySnippet / mediaLabel). */
  snippet: string;
}

export interface InboundMessage {
  platform: string;
  /** Session routing key, decided by the platform: every chat is its own session, DMs included
   *  ("telegram:<userId>", "discord:dm:<userId>", "slack:dm:<userId>", "line:<userId>"; groups
   *  "telegram:<chatId>", "discord:<channelId>", …). Must round-trip: channelKeyForTarget(parseTarget(key)) === key. */
  channelKey: string;
  /** Where replies for this message go. */
  replyTarget: Target;
  /** Message identity, for reactions/quotes. */
  ref: MsgRef;
  sender: Sender;
  /** Sender passed the platform allowlist (only allowed messages reach core;
   *  this flags operator-level trust for approvals). */
  trusted: boolean;
  multiparty: boolean;
  text: string;
  attachments: Attachment[];
  /** The message this one replies to, if any. */
  replyTo?: ReplyContext;
  /** Bot was explicitly addressed (@mention / reply-to-bot) in a multiparty chat. */
  addressed?: boolean;
  /** Message @mentions someone other than the bot (and not the bot). */
  mentionsOthers?: boolean;
  /** Platform-level per-channel group settings (e.g. Discord `channels.<id>.requireMention`); core settings
   *  `groups.channels` and `/activation` take precedence. */
  groupPolicy?: { mode?: "mention" | "always"; ignoreOtherMentions?: boolean };
  receivedAt: number;
}

/** A local file to post to a chat (send_file). `kind` picks how the platform shows it. */
export interface OutboundFile {
  path: string;
  /** File name shown in the chat (default: the path's basename). */
  name: string;
  kind: "image" | "audio" | "voice" | "video" | "file";
  mime?: string;
  caption?: string;
}

export interface ChoiceRequest {
  title: string;
  body?: string;
  options: string[];
  /** Platform user ids allowed to answer. */
  approverIds: string[];
  /** Resolve null after this long without an answer; 0 = no deadline (wait until answered). */
  timeoutMs: number;
  /** Aborted: the question was settled elsewhere. The adapter resolves null, marks the message cancelled and drops it. */
  signal?: AbortSignal;
}

export interface PlatformCapabilities {
  edit: boolean;
  delete: boolean;
  reactions: boolean;
  buttons: boolean;
  typing: boolean;
  maxMessageLength: number;
}

export interface PlatformCommand {
  name: string;
  description: string;
}

/** A DM from someone not on the allowlist (pairing). Never sent for groups or bots. */
export interface UnknownSender {
  platform: string;
  userId: string;
  name: string;
  username?: string;
  /** Where to answer them (their DM). */
  replyTarget: Target;
}

export interface InboundSink {
  message(msg: InboundMessage): void;
  unknownSender?(s: UnknownSender): void;
}

/** What an adapter knows about its own connection (docs §11.4): the daemon's channel supervisor merges it into the
 *  channel's health. Times are epoch ms. */
export interface PlatformHealth {
  /** Last successful receive (poll / event / socket message). */
  lastPollAt?: number;
  /** Last successful outbound API call (send, edit, react…). */
  lastSendAt?: number;
  lastError?: string;
  lastErrorAt?: number;
  /** API calls that failed in a row (any success resets it). */
  consecutiveFailures: number;
}

/** Thrown by start() for an error retrying won't fix (bad token: 401/404). The channel is marked failed. */
export class PlatformStartError extends Error {
  readonly permanent = true;
  constructor(message: string) { super(message); this.name = "PlatformStartError"; }
}

export interface PlatformAdapter {
  readonly name: string;
  readonly capabilities: PlatformCapabilities;
  /** Connect and begin receiving. The daemon calls it in the background with a deadline (and an abort signal) and
   *  retries with backoff; it must not block on the platform beyond the signal. */
  start(sink: InboundSink, signal?: AbortSignal): Promise<void>;
  stop(): Promise<void>;
  /** Send markdown text (adapter converts + chunks). Returns ref of the FIRST chunk. */
  send(target: Target, markdown: string): Promise<MsgRef | undefined>;
  /** Replace a message's content; false if unsupported/failed (caller falls back to send). */
  edit?(ref: MsgRef, markdown: string): Promise<boolean>;
  delete?(ref: MsgRef): Promise<boolean>;
  /** Post a local file (photo / audio / voice note / video / document). Absent = the platform can't upload files. */
  sendFile?(target: Target, file: OutboundFile): Promise<MsgRef | undefined>;
  react?(ref: MsgRef, emojis: string[]): Promise<void>;
  typing?(target: Target): Promise<void>;
  /** Show buttons; resolves with the chosen option index, or null on timeout. */
  askChoice?(target: Target, req: ChoiceRequest): Promise<number | null>;
  setCommands?(cmds: PlatformCommand[]): Promise<void>;
  /** Users approved by pairing: accepted like allowedUserIds, but never operators. Replaces the previous set. */
  setPairedUsers?(userIds: string[]): void;
  /** Connection health (optional; without it only the supervisor's own start state is shown). */
  health?(): PlatformHealth;
  /** Default targets for operator notifications (e.g. allowed DM user ids). */
  operatorTargets(): Target[];
  /** Resolve a v2-style target string ("telegram:<chatId>") into a Target. */
  parseTarget(s: string): Target | undefined;
  /** Inbox owner (channelKey) for messages sent to this target (v2 /api/send rule). */
  channelKeyForTarget(t: Target): string;
}
