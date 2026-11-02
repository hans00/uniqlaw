// Official Slack types: Web API method arguments (@slack/web-api) and Block Kit / Events API payloads
// (@slack/types), both published by Slack. Used to generate test/spec/slack.schema.json.
import type {
  ChatPostMessageArguments, ChatUpdateArguments, ChatDeleteArguments, ChatPostEphemeralArguments,
  ReactionsAddArguments, UsersInfoArguments, ConversationsOpenArguments,
} from "@slack/web-api";
import type { AppMentionEvent, FileShareMessageEvent, KnownBlock } from "@slack/types";
export type ChatPostMessage = ChatPostMessageArguments;
export type ChatUpdate = ChatUpdateArguments;
export type ChatDelete = ChatDeleteArguments;
export type ChatPostEphemeral = ChatPostEphemeralArguments;
export type ReactionsAdd = ReactionsAddArguments;
export type UsersInfo = UsersInfoArguments;
export type ConversationsOpen = ConversationsOpenArguments;
export type FileShareEvent = FileShareMessageEvent;
export type MentionEvent = AppMentionEvent;
export type SlackKnownBlock = KnownBlock;
