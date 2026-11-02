// Real agy contract run: `UNIQLAW_E2E=1 bun test packages/provider-agy/test/contract.e2e.test.ts`
// S2 / S4 / S7 self-skip per capabilities (no permission callback, no steer, spawn model switch);
// agy-specific replacements live in agy.e2e.test.ts.
import { runProviderContract } from "@uniqlaw/testkit";
import { createLogger } from "@uniqlaw/core";
import { AgyProvider } from "../src/index.ts";

const work = `${import.meta.dir}/../../testkit/.work/agy`;
const provider = new AgyProvider({ agyPath: "agy", extraArgs: [], isolateHome: false },
  { log: createLogger({ file: `${work}-state/contract.log`, level: "debug" }), stateDir: `${work}-state` });

runProviderContract(provider, { model: process.env.AGY_MODEL ?? "gemini-3.8-flash-low", timeoutMs: 300_000 });
