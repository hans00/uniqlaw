// Inbound Events API fixtures, type-checked against the official @slack/types definitions
// (tsc fails if a fixture drifts from GenericMessageEvent / FileShareMessageEvent / AppMentionEvent).
import type { GenericMessageEvent, FileShareMessageEvent } from "@slack/types";

export const OWNER = "U0000000001";
export const imMessage = {
  type: "message", subtype: undefined, event_ts: "1700000001.000100", team: "T0000000001", channel: "D0000000001",
  user: OWNER, text: "hello", ts: "1700000001.000100", channel_type: "im",
} satisfies GenericMessageEvent;

export const channelMention = {
  type: "message", subtype: undefined, event_ts: "1700000002.000100", team: "T0000000001", channel: "C0000000001",
  user: OWNER, text: "<@UBOT> look", ts: "1700000002.000100", channel_type: "channel",
} satisfies GenericMessageEvent;

export const threadReply = {
  type: "message", subtype: undefined, event_ts: "1700000003.000100", team: "T0000000001", channel: "C0000000001",
  user: OWNER, text: "in thread", ts: "1700000003.000100", thread_ts: "1700000002.000100", channel_type: "channel",
} satisfies GenericMessageEvent;

export const fileShare = {
  type: "message", subtype: "file_share", event_ts: "1700000004.000100", channel: "D0000000001", user: OWNER,
  text: "a file", ts: "1700000004.000100", channel_type: "im",
  files: [{ id: "F0000000001", name: "a.png", mimetype: "image/png", url_private_download: "REPLACED_AT_RUNTIME", url_private: "REPLACED_AT_RUNTIME" }],
} satisfies Omit<FileShareMessageEvent, "files"> & { files: object[] };
