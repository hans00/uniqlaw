// Real claude TUI contract run. `UNIQLAW_E2E=1 bun test packages/provider-claude-tmux/test/contract.e2e.test.ts`
import { afterAll } from "bun:test";
import { runProviderContract } from "@uniqlaw/testkit";
import { createLogger } from "@uniqlaw/core";
import { ClaudeTmuxProvider } from "../src/index.ts";
import { configSchema } from "../src/index.ts";

const stateDir = `${import.meta.dir}/../../testkit/.work/claude-tmux-state`;
const provider = new ClaudeTmuxProvider(configSchema.parse({}), {
  log: createLogger({ file: `${stateDir}/contract.log`, level: "debug" }),
  stateDir,
});

runProviderContract(provider, { model: "haiku", altModel: "sonnet", instanceId: "contract" });

afterAll(async () => {
  const tmux = provider.tmuxFor("contract");
  for (const s of await tmux.listSessions()) await tmux.killSession(s);
});
