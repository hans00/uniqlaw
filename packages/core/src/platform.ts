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
  /** Bot was explicitly addressed (@mention / reply-to-bot) in a multiparty chat. */
  addressed?: boolean;
  receivedAt: number;
}

export interface ChoiceRequest {
  title: string;
  body?: string;
  options: string[];
  /** Platform user ids allowed to answer. */
  approverIds: string[];
  timeoutMs: number;
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

export interface InboundSink {
  message(msg: InboundMessage): void;
}

export interface PlatformAdapter {
  readonly name: string;
  readonly capabilities: PlatformCapabilities;
  start(sink: InboundSink): Promise<void>;
  stop(): Promise<void>;
  /** Send markdown text (adapter converts + chunks). Returns ref of the FIRST chunk. */
  send(target: Target, markdown: string): Promise<MsgRef | undefined>;
  /** Replace a message's content; false if unsupported/failed (caller falls back to send). */
  edit?(ref: MsgRef, markdown: string): Promise<boolean>;
  delete?(ref: MsgRef): Promise<boolean>;
  react?(ref: MsgRef, emojis: string[]): Promise<void>;
  typing?(target: Target): Promise<void>;
  /** Show buttons; resolves with the chosen option index, or null on timeout. */
  askChoice?(target: Target, req: ChoiceRequest): Promise<number | null>;
  setCommands?(cmds: PlatformCommand[]): Promise<void>;
  /** Default targets for operator notifications (e.g. allowed DM user ids). */
  operatorTargets(): Target[];
  /** Resolve a v2-style target string ("telegram:<chatId>") into a Target. */
  parseTarget(s: string): Target | undefined;
  /** Inbox owner (channelKey) for messages sent to this target (v2 /api/send rule). */
  channelKeyForTarget(t: Target): string;
}
