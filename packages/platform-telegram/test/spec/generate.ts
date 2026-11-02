// Regenerate: bun test/spec/generate.ts
// Builds test/spec/telegram.schema.json from @grammyjs/types (hand-maintained to track the official
// Telegram Bot API docs — Telegram publishes no OpenAPI) using the TypeScript checker.
import * as TJS from "typescript-json-schema";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const dir = import.meta.dir;
const pkg = JSON.parse(readFileSync(join(dir, "../../node_modules/@grammyjs/types/package.json"), "utf8"));
const program = TJS.getProgramFromFiles([join(dir, "official-types.ts")], { strict: true, skipLibCheck: true, moduleResolution: 100, module: 99, target: 99 }, join(dir, "../.."));
const gen = TJS.buildGenerator(program, { required: true, noExtraProps: true, ignoreErrors: true, ref: true, aliasRef: false })!;
const want = ["GetMe", "GetUpdates", "SendMessage", "EditMessageText", "DeleteMessage", "SetMessageReaction", "SendChatAction", "SetMyCommands", "AnswerCallbackQuery", "GetFile", "TgUpdate"];
const names = gen.getUserSymbols().filter((n) => want.includes(n));
const schema = gen.getSchemaForSymbols(names) as Record<string, unknown>;
schema.$comment = `Generated from @grammyjs/types@${pkg.version} on ${new Date().toISOString().slice(0, 10)} by test/spec/generate.ts`;
writeFileSync(join(dir, "telegram.schema.json"), JSON.stringify(schema));
console.log("symbols:", names.join(","), "defs:", Object.keys(schema.definitions as object).length);
