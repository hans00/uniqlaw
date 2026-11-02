// Request/payload types from @grammyjs/types (tracks the official Telegram Bot API docs; there is
// no official OpenAPI for the Bot API). Used to generate test/spec/telegram.schema.json.
import type { Opts, Update, BotCommand, File, Message } from "@grammyjs/types";
type O = Opts<string>;
export type GetMe = O["getMe"];
export type GetUpdates = O["getUpdates"];
export type SendMessage = O["sendMessage"];
export type EditMessageText = O["editMessageText"];
export type DeleteMessage = O["deleteMessage"];
export type SetMessageReaction = O["setMessageReaction"];
export type SendChatAction = O["sendChatAction"];
export type SetMyCommands = O["setMyCommands"];
export type AnswerCallbackQuery = O["answerCallbackQuery"];
export type GetFile = O["getFile"];
export type TgUpdate = Update;
export type TgBotCommand = BotCommand;
export type TgFile = File;
export type TgMessage = Message;
