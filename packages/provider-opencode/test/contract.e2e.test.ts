// Real opencode contract run: `UNIQLAW_E2E=1 bun test packages/provider-opencode/test/contract.e2e.test.ts`
import { runProviderContract } from "@uniqlaw/testkit";
import { createLogger } from "@uniqlaw/core";
import { OpencodeProvider } from "../src/index.ts";

const work = `${import.meta.dir}/../../testkit/.work/opencode`;
const provider = new OpencodeProvider({ opencodePath: "opencode", startTimeoutMs: 30_000 }, {
  log: createLogger({ file: `${work}-state/contract.log`, level: "debug" }),
  stateDir: `${work}-state`,
});

runProviderContract(provider, {
  model: process.env.OPENCODE_MODEL ?? "opencode/glm-5.3-flash-free",
  altModel: process.env.OPENCODE_MODEL_ALT ?? "opencode/flint-40b-free",
});
