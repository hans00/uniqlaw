// Provider contract against the REAL pi harness.
//  - Faux model (no credentials): UNIQLAW_E2E=1 bun test test/contract.e2e.test.ts
//  - Real model: UNIQLAW_E2E=1 UNIQLAW_PI_E2E_CREDENTIAL='{"kind":"openai-api-key","key":{"env":"OPENAI_API_KEY"}}' \
//      UNIQLAW_PI_E2E_MODEL=gpt-5-mini UNIQLAW_PI_E2E_ALT_MODEL=gpt-5 bun test test/contract.e2e.test.ts
import { rmSync } from "node:fs";
import { createLogger, type AgentProvider, type Credential, type SessionSpec } from "@uniqlaw/core";
import { runProviderContract } from "@uniqlaw/testkit";
import { PiProvider } from "../src/index.ts";
import { createFauxBrain } from "./faux-brain.ts";

const stateDir = `${import.meta.dir}/../.work/contract-state`;
rmSync(stateDir, { recursive: true, force: true });
// Never touch the real ~/.pi/agent in tests (default is to inherit the user's agent dir).
process.env.PI_CODING_AGENT_DIR = `${stateDir}/user-pi-agent`;
const log = createLogger({ file: `${stateDir}/contract.log`, level: "debug" });
const realCred = process.env.UNIQLAW_PI_E2E_CREDENTIAL ? (JSON.parse(process.env.UNIQLAW_PI_E2E_CREDENTIAL) as Credential) : undefined;

if (!realCred) {
  const faux = createFauxBrain();
  const provider = new PiProvider({ allowModelNetwork: false }, { log, stateDir, configureRuntime: (rt) => rt.registerNativeProvider(faux.provider) });
  runProviderContract(provider, { name: "pi (faux model)", model: "faux/faux-a", altModel: "faux/faux-b", timeoutMs: 60_000 });
} else {
  // Inject the credential into every session the suite opens.
  const base = new PiProvider({ allowModelNetwork: true }, { log, stateDir });
  const provider: AgentProvider = {
    name: "pi",
    capabilities: (p) => base.capabilities(p),
    open: (spec: SessionSpec) => base.open({ ...spec, profile: { ...spec.profile, credentialResolved: realCred } }),
  };
  runProviderContract(provider, { name: `pi (${realCred.kind})`, model: process.env.UNIQLAW_PI_E2E_MODEL!, altModel: process.env.UNIQLAW_PI_E2E_ALT_MODEL });
}
