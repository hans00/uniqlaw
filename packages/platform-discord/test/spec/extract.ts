// Regenerate: bun test/spec/extract.ts <commit-sha>
// Downloads Discord's official OpenAPI spec (github.com/discord/discord-api-spec) at the given
// commit and keeps only the operations the adapter uses + every component they reference.
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const COMMIT = process.argv[2] ?? "main";
const URL_ = `https://raw.githubusercontent.com/discord/discord-api-spec/${COMMIT}/specs/openapi.json`;
const OPS: [string, string][] = [
  ["post", "/channels/{channel_id}/messages"],
  ["patch", "/channels/{channel_id}/messages/{message_id}"],
  ["delete", "/channels/{channel_id}/messages/{message_id}"],
  ["put", "/channels/{channel_id}/messages/{message_id}/reactions/{emoji_name}/@me"],
  ["post", "/channels/{channel_id}/typing"],
  ["put", "/applications/{application_id}/commands"],
  ["post", "/users/@me/channels"],
  ["post", "/interactions/{interaction_id}/{interaction_token}/callback"],
];
const spec = await (await fetch(URL_)).json() as any;
const keep = new Set<string>();
const walk = (v: unknown) => {
  if (Array.isArray(v)) return v.forEach(walk);
  if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      if (k === "$ref" && typeof x === "string" && x.startsWith("#/components/schemas/")) {
        const n = x.slice("#/components/schemas/".length);
        if (!keep.has(n)) { keep.add(n); walk(spec.components.schemas[n]); }
      } else walk(x);
    }
  }
};
const operations: Record<string, unknown> = {};
for (const [m, p] of OPS) {
  const op = spec.paths[p]?.[m];
  if (!op) throw new Error(`operation ${m} ${p} not in spec`);
  const body = op.requestBody?.content?.["application/json"]?.schema ?? null;
  const params = [...(spec.paths[p].parameters ?? []), ...(op.parameters ?? [])];
  walk(body); walk(params);
  operations[`${m.toUpperCase()} ${p}`] = { operationId: op.operationId, requestBody: body, parameters: params };
}
const out = {
  $comment: `Subset of ${URL_} (openapi ${spec.openapi}, API v${spec.info.version}) extracted ${new Date().toISOString().slice(0, 10)} by test/spec/extract.ts`,
  source: URL_, commit: COMMIT, operations,
  components: { schemas: Object.fromEntries([...keep].sort().map((n) => [n, spec.components.schemas[n]])) },
};
writeFileSync(join(import.meta.dir, "discord-openapi.subset.json"), JSON.stringify(out));
console.log(`operations ${OPS.length}, schemas ${keep.size}`);
