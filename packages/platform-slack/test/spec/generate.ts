// Regenerate: bun test/spec/generate.ts
// (GenericMessageEvent overflows the generator — plain message fixtures are checked at type level in
//  test/spec/fixtures.ts with `satisfies GenericMessageEvent`, enforced by tsc.)
import * as TJS from "typescript-json-schema";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const dir = import.meta.dir;
const v = (p: string) => JSON.parse(readFileSync(join(dir, `../../node_modules/${p}/package.json`), "utf8")).version;
const program = TJS.getProgramFromFiles([join(dir, "official-types.ts")], { strict: true, skipLibCheck: true, moduleResolution: 100, module: 99, target: 99 }, join(dir, "../.."));
const gen = TJS.buildGenerator(program, { required: true, noExtraProps: true, ignoreErrors: true, ref: true, aliasRef: false })!;
const want = ["ChatPostMessage", "ChatUpdate", "ChatDelete", "ChatPostEphemeral", "ReactionsAdd", "UsersInfo", "ConversationsOpen", "FileShareEvent", "MentionEvent", "SlackKnownBlock"];
const schema = gen.getSchemaForSymbols(gen.getUserSymbols().filter((n) => want.includes(n))) as Record<string, unknown>;
schema.$comment = `Generated from @slack/web-api@${v("@slack/web-api")} + @slack/types@${v("@slack/types")} on ${new Date().toISOString().slice(0, 10)} by test/spec/generate.ts`;
writeFileSync(join(dir, "slack.schema.json"), JSON.stringify(schema));
console.log("defs:", Object.keys(schema.definitions as object).length, "top:", want.filter((w) => (schema.definitions as Record<string, unknown>)[w]).join(","));
