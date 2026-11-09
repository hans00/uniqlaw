// Dreaming e2e: the nightly sweep run on demand (POST /api/dream) with a real Claude model deciding
// how a recurring daily-note entry goes into MEMORY.md (it should replace the stale entry it contradicts),
// plus the dream diary. Gated: UNIQLAW_E2E=1 bun test test/dreaming-e2e.test.ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRuntime, startDaemon, type Daemon } from "../src/index.ts";

const E2E = process.env.UNIQLAW_E2E === "1";
const PROVIDER = process.env.UNIQLAW_E2E_PROVIDER ?? "claude-sdk";
const ID = `e2ed${process.pid}`;
let dir: string;
let daemon: Daemon | undefined;
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  if (!E2E) return;
  process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "uq-e2ed-xdg-"));
  dir = realpathSync(mkdtempSync(join(tmpdir(), "uq-e2ed-")));
  mkdirSync(join(dir, ".uniqlaw"), { recursive: true });
  mkdirSync(join(dir, "memory"), { recursive: true });
  writeFileSync(join(dir, "memory", "MEMORY.md"), "# Memory\n\n- Hans prefers TypeScript for tooling.\n- Hans's cat is called Tama.\n- Deploys happen on Fridays.\n- The NAS is at nas.local.\n");
  const line = "- Hans's cat is now Mochi (Tama was rehomed in October).\n";
  writeFileSync(join(dir, "memory", `${day(-1)}.md`), `# ${day(-1)}\n\n${line}- Had ramen for lunch.\n`);
  writeFileSync(join(dir, "memory", `${day(0)}.md`), `# ${day(0)}\n\n${line}`);
  writeFileSync(join(dir, ".uniqlaw", "settings.json"), JSON.stringify({
    instance: { id: ID },
    profiles: {
      main: { provider: PROVIDER, model: "haiku" },
      dreamer: { provider: PROVIDER, model: "haiku", permissions: { level: "locked", approval: { mode: "auto-deny" } } },
    },
    plugins: { dreaming: { profile: "dreamer" } },
  }));
  daemon = await startDaemon(dir);
});

afterAll(async () => {
  if (!E2E) return;
  await daemon?.stop();
  Bun.spawnSync(["tmux", "-L", `uniqlaw-${ID}`, "kill-server"]);
  rmSync(dir, { recursive: true, force: true });
});

test.skipIf(!E2E)("a real model consolidates: the recurring entry replaces the stale one; the diary gets an entry", async () => {
  const port = readRuntime(dir)!.webPort;
  const dry = await (await fetch(`http://127.0.0.1:${port}/api/dream`, { method: "POST", body: JSON.stringify({ dryRun: true }) })).json() as { report: { candidates: { text: string; passed: string[] }[] } };
  expect(dry.report.candidates.map((c) => [c.text, c.passed])).toEqual([["Hans's cat is now Mochi (Tama was rehomed in October).", ["recurring"]]]);

  const r = await (await fetch(`http://127.0.0.1:${port}/api/dream`, { method: "POST", body: "{}" })).json() as { ok: boolean; report: { deep: Record<string, unknown>; diary?: string } };
  if (process.env.UNIQLAW_E2E_VERBOSE) console.log(JSON.stringify(r, null, 1), readFileSync(join(dir, "memory", "MEMORY.md"), "utf8"));
  expect(r.ok).toBe(true);
  expect(r.report.deep.mode).toBe("consolidated"); // the model's JSON was valid and passed validation
  const m = readFileSync(join(dir, "memory", "MEMORY.md"), "utf8");
  expect(m).toContain("Hans's cat is now Mochi");
  expect(m).not.toContain("Hans's cat is called Tama."); // superseded/merged, not appended next to it
  expect(m).toContain("Deploys happen on Fridays."); // unrelated entries untouched
  expect(r.report.diary?.length ?? 0).toBeGreaterThan(20);
  expect(readFileSync(join(dir, "memory", "DREAMS.md"), "utf8")).toContain(r.report.diary!.slice(0, 20));
}, 400_000);
