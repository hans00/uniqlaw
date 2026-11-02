// claude-tmux ↔ claude-sdk share one session jsonl: a session started in one adapter
// resumes in the other. UNIQLAW_E2E=1 bun test test/interop.e2e.test.ts
import { afterAll, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createLogger, DEFAULT_PERMISSIONS, type AgentProvider, type AgentEvent, type SessionSpec } from "@uniqlaw/core";
import { EventCollector } from "@uniqlaw/testkit";
import { ClaudeTmuxProvider, configSchema as tmuxSchema } from "@uniqlaw/provider-claude-tmux";
import { ClaudeSdkProvider } from "../src/index.ts";

const E2E = process.env.UNIQLAW_E2E === "1";
const work = join(import.meta.dir, "..", "..", "testkit", ".work", "claude-interop");
mkdirSync(work, { recursive: true });
const log = createLogger({ file: join(work, "interop.log"), level: "debug" });
const tmux = new ClaudeTmuxProvider(tmuxSchema.parse({}), { log, stateDir: work });
const sdk = new ClaudeSdkProvider({}, log);
const INSTANCE = "interop";

const spec = (id: string, providerSessionId?: string): SessionSpec => ({
  sessionId: id, providerSessionId, cwd: work, instanceId: INSTANCE, env: {}, systemPrompt: { fragments: [] },
  profile: { name: "i", provider: "x", model: "haiku", permissions: { ...DEFAULT_PERMISSIONS }, options: {} },
});

async function turn(p: AgentProvider, s: SessionSpec, prompt: string) {
  const sess = await p.open(s);
  const ev = new EventCollector(sess);
  const sid = (await ev.waitFor((e) => e.type === "session", 120_000)) as Extract<AgentEvent, { type: "session" }>;
  const m = ev.mark();
  await sess.send({ text: prompt, attachments: [] });
  await ev.turnEnd(150_000, m);
  const text = ev.texts(m);
  await sess.close();
  return { sid: sid.providerSessionId, text };
}

const code = () => `KIWI-${Math.floor(Math.random() * 9000 + 1000)}`;
const ASK = "What codeword did I ask you to remember? Answer with just the codeword.";

test.skipIf(!E2E)("tmux → sdk", async () => {
  const c = code();
  const a = await turn(tmux, spec(`i-ts-${Date.now()}`), `Remember the codeword ${c}. Reply with exactly: NOTED`);
  const b = await turn(sdk, spec("i-ts-b", a.sid), ASK);
  expect(b.sid).toBe(a.sid);
  expect(b.text).toContain(c);
}, 400_000);

test.skipIf(!E2E)("sdk → tmux", async () => {
  const c = code();
  const a = await turn(sdk, spec(`i-st-${Date.now()}`), `Remember the codeword ${c}. Reply with exactly: NOTED`);
  const b = await turn(tmux, spec(`i-st-b-${Date.now()}`, a.sid), ASK);
  expect(b.sid).toBe(a.sid);
  expect(b.text).toContain(c);
}, 400_000);

afterAll(async () => {
  if (!E2E) return;
  const t = tmux.tmuxFor(INSTANCE);
  for (const s of await t.listSessions()) await t.killSession(s);
});
