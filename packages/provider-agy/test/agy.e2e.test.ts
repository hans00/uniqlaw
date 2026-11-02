// agy-specific e2e (UNIQLAW_E2E=1): pre-allow permissions + denied-action surfacing, and
// spawn-style model switch keeping history.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createLogger, DEFAULT_PERMISSIONS, type AgentSession, type SessionSpec } from "@uniqlaw/core";
import { EventCollector } from "@uniqlaw/testkit";
import { AgyProvider } from "../src/index.ts";

const E2E = process.env.UNIQLAW_E2E === "1";
const MODEL = process.env.AGY_MODEL ?? "gemini-3.8-flash-low";
const work = `${import.meta.dir}/../../testkit/.work/agy`;
const provider = new AgyProvider({ agyPath: "agy", extraArgs: [], isolateHome: false },
  { log: createLogger({ file: `${work}-state/agy-e2e.log`, level: "debug" }), stateDir: `${work}-state` });
const run = Date.now().toString(36);
const open: AgentSession[] = [];
afterEach(async () => { for (const s of open.splice(0)) await s.close().catch(() => {}); });

const spec = (id: string, allowTools: string[] = [], model = MODEL, providerSessionId?: string): SessionSpec => {
  mkdirSync(work, { recursive: true });
  return { sessionId: `${id}-${run}`, providerSessionId, cwd: work, instanceId: "contract", env: {}, systemPrompt: { fragments: [] },
    profile: { name: "agy-e2e", provider: "agy", model, permissions: { ...DEFAULT_PERMISSIONS, allowTools }, options: {} } };
};
const txt = (t: string) => ({ text: t, attachments: [] });

describe.skipIf(!E2E)("agy-specific", () => {
  test("pre-allowed command runs; anything else is auto-denied and surfaced", async () => {
    const ok = join(work, `agy-ok-${run}.txt`), no = join(work, `agy-no-${run}.txt`);
    rmSync(ok, { force: true }); rmSync(no, { force: true });
    const s = await provider.open(spec("perm", [`Bash(touch ${ok})`])); open.push(s);
    const ev = new EventCollector(s);
    let m = ev.mark();
    await s.send(txt(`Run exactly this shell command: touch ${ok} — then reply DONE.`));
    await ev.turnEnd(180_000, m);
    expect(existsSync(ok)).toBe(true);
    m = ev.mark();
    await s.send(txt(`Run exactly this shell command: touch ${no} — then reply DONE (or BLOCKED if you cannot).`));
    await ev.turnEnd(180_000, m);
    expect(existsSync(no)).toBe(false);
    expect(ev.texts(m)).toContain("Blocked by the permission policy");
    expect(ev.events.slice(m).some((e) => e.type === "tool_end" && !e.ok && (e.summary ?? "").startsWith("blocked by policy"))).toBe(true);
  }, 400_000);

  test("setModel respawns with --conversation and keeps history", async () => {
    const s = await provider.open(spec("model")); open.push(s);
    const ev = new EventCollector(s);
    let m = ev.mark();
    await s.send(txt("Remember the codeword KIWI-77. Reply with exactly: NOTED"));
    await ev.turnEnd(120_000, m);
    await s.setModel!(process.env.AGY_MODEL_ALT ?? "gemini-3.8-flash-medium");
    await ev.waitFor((e) => e.type === "model", 5000, m);
    m = ev.mark();
    await s.send(txt("What codeword did I ask you to remember? Answer with just the codeword."));
    const end = await ev.turnEnd(120_000, m);
    expect(end.reason).toBe("done");
    expect(ev.texts(m)).toContain("KIWI-77");
  }, 300_000);
});
