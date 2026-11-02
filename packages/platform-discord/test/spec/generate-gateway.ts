// Regenerate: bun test/spec/generate-gateway.ts
import * as TJS from "typescript-json-schema";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const dir = import.meta.dir;
const pkg = JSON.parse(readFileSync(join(dir, "../../node_modules/discord-api-types/package.json"), "utf8"));
const program = TJS.getProgramFromFiles([join(dir, "gateway-types.ts")], { strict: true, skipLibCheck: true, moduleResolution: 100, module: 99, target: 99 }, join(dir, "../.."));
const gen = TJS.buildGenerator(program, { required: true, noExtraProps: true, ignoreErrors: true, ref: true, aliasRef: false })!;
const want = ["Identify", "Resume", "Heartbeat", "MessageCreate", "Ready", "ButtonInteraction", "SlashInteraction"];
const schema = gen.getSchemaForSymbols(gen.getUserSymbols().filter((n) => want.includes(n))) as Record<string, unknown>;
// discord-api-types keeps deprecated enum aliases (e.g. GuildNews = GuildAnnouncement) → duplicate enum values.
const dedupe = (v: unknown): void => {
  if (Array.isArray(v)) return v.forEach(dedupe);
  if (v && typeof v === "object") for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (k === "enum" && Array.isArray(x)) (v as Record<string, unknown>)[k] = [...new Set(x)];
    else dedupe(x);
  }
};
dedupe(schema);
// Bitfields (…Flags) are typed as enums of single bits; real payloads carry 0 or OR-ed combinations.
for (const [name, def] of Object.entries(schema.definitions as Record<string, any>)) {
  if (/Flags$/.test(name) && Array.isArray(def.enum) && def.enum.every((x: unknown) => typeof x === "number")) {
    (schema.definitions as Record<string, unknown>)[name] = { type: "integer", minimum: 0, $comment: `bitfield of ${name} (${def.enum.join("|")})` };
  }
}
schema.$comment = `Generated from discord-api-types@${pkg.version} (v10) on ${new Date().toISOString().slice(0, 10)} by test/spec/generate-gateway.ts`;
writeFileSync(join(dir, "discord-gateway.schema.json"), JSON.stringify(schema));
console.log("defs:", Object.keys(schema.definitions as object).length, "top:", want.filter((w) => (schema.definitions as Record<string, unknown>)[w]).join(","));
