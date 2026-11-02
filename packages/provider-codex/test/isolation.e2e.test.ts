// Codex-specific replacement for contract S1b: native collaboration tools must not reach
// other UniQlaw sessions hosted on the same app-server process.
// `UNIQLAW_E2E=1 bun test packages/provider-codex/test/isolation.e2e.test.ts`
import { afterAll, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { DEFAULT_PERMISSIONS, createLogger, type AgentEvent, type AgentSession } from "@uniqlaw/core";
import { CodexProvider, configSchema } from "../src/index.ts";

const E2E = process.env.UNIQLAW_E2E === "1";
const work = `${import.meta.dir}/../../testkit/.work/codex-isolation`;
mkdirSync(work, { recursive: true });
const provider = new CodexProvider(configSchema.parse({ effort: "low" }), { log: createLogger({ file: `${work}/isolation.log`, level: "debug" }) });
const spec = (id: string) => ({ sessionId: `${id}-${Date.now().toString(36)}`, cwd: work, instanceId: "iso", env: {}, systemPrompt: { fragments: [] },
  profile: { name: "p", provider: "codex", model: process.env.CODEX_MODEL ?? "gpt-6-luna",
    permissions: { ...DEFAULT_PERMISSIONS, approval: { mode: "auto-allow" as const, timeoutSec: 5 } }, options: {} } });

async function turn(s: AgentSession, text: string) {
  const it = s.events[Symbol.asyncIterator]();
  const evs: AgentEvent[] = [];
  await s.send({ text, attachments: [] });
  for (;;) { const r = await it.next(); if (r.done) break; evs.push(r.value); if (r.value.type === "turn_end") break; }
  return { evs, text: evs.map((e) => (e.type === "text" && e.final) || "").join("\n") };
}

afterAll(async () => { await provider.shutdown(); });

test.skipIf(!E2E)("collaboration.list_agents sees only the thread's own tree, not sibling sessions", async () => {
  const A = await provider.open(spec("iso-A"));
  const B = await provider.open(spec("iso-B"));
  try {
    await turn(B, "Reply with exactly: B_READY");
    const r = await turn(A, "Call the collaboration.list_agents tool right now (do not spawn anything first), then reply with its raw output verbatim.");
    const used = r.evs.some((e) => e.type === "tool_start" && /list_agents|listAgents|Agent/i.test(e.name));
    // Either the tool ran and showed only "/root", or the model has no such tool.
    if (used || /agent_name/.test(r.text)) {
      expect(r.text).toContain("/root");
      const names = [...r.text.matchAll(/"agent_name"\s*:\s*"([^"]+)"/g)].map((m) => m[1]);
      expect(names.filter((n) => n !== "/root")).toEqual([]);
    }
  } finally { await A.close(); await B.close(); }
}, 300_000);
