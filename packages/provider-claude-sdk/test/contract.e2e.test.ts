// Real Agent SDK contract run: UNIQLAW_E2E=1 bun test test/contract.e2e.test.ts
import { runProviderContract } from "@uniqlaw/testkit";
import { createLogger } from "@uniqlaw/core";
import { ClaudeSdkProvider } from "../src/index.ts";

const stateDir = `${import.meta.dir}/../../testkit/.work/claude-sdk-state`;
const provider = new ClaudeSdkProvider({}, createLogger({ file: `${stateDir}/contract.log`, level: "debug" }));

runProviderContract(provider, { model: "haiku", altModel: "sonnet", instanceId: "contract-sdk" });
