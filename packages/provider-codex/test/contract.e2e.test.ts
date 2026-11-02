// Real codex contract run: `UNIQLAW_E2E=1 bun test packages/provider-codex/test/contract.e2e.test.ts`
import { afterAll } from "bun:test";
import { runProviderContract } from "@uniqlaw/testkit";
import { createLogger } from "@uniqlaw/core";
import { CodexProvider, configSchema } from "../src/index.ts";

const work = `${import.meta.dir}/../../testkit/.work/codex`;
const provider = new CodexProvider(configSchema.parse({ effort: "low", idleKillMs: 1000 }), {
  log: createLogger({ file: `${work}-state/contract.log`, level: "debug" }),
});

runProviderContract(provider, {
  model: process.env.CODEX_MODEL ?? "gpt-6-luna",
  altModel: process.env.CODEX_MODEL_ALT ?? "gpt-5.6-luna",
  // S1b asks for Claude's tool names; codex's in-session collaboration.list_agents/send_message
  // would make it answer "yes". Cross-session isolation is proven by isolation.e2e.test.ts instead.
  skip: ["S1b"],
});

afterAll(async () => { await provider.shutdown(); });
