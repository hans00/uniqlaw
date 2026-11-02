// Real ACP contract run against `opencode acp`:
//   UNIQLAW_E2E=1 bun test packages/provider-acp/test/contract.e2e.test.ts
import { runProviderContract } from "@uniqlaw/testkit";
import { createLogger } from "@uniqlaw/core";
import { AcpProvider } from "../src/index.ts";

const work = `${import.meta.dir}/../../testkit/.work/acp`;
const provider = new AcpProvider(
  { command: ["opencode", "acp"], env: {}, preset: "auto", shareProcess: false, startTimeoutMs: 30_000 },
  { log: createLogger({ file: `${work}-state/contract.log`, level: "debug" }), stateDir: `${work}-state` },
);

runProviderContract(provider, {
  name: "acp → opencode acp",
  model: process.env.OPENCODE_MODEL ?? "opencode/glm-5.3-flash-free",
  altModel: process.env.OPENCODE_MODEL_ALT ?? "opencode/flint-40b-free",
  // Concurrent session/prompt = steer is verified for opencode acp (M0 S4); generic default is off.
  profileOptions: { steer: "concurrent-prompt" },
});
