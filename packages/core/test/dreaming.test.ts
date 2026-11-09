import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_DREAMING, MemoryStore, StateStore, extractJson, rankCandidates, runDreamSweep, type DreamDeps } from "../src/index.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "uq-dream-"));
  dirs.push(dir);
  const store = new StateStore(join(dir, "state.db"));
  let now = new Date("2026-11-07T04:00:00Z");
  const mem = new MemoryStore(dir, store, { timezone: "UTC", now: () => now });
  const memFile = join(dir, "memory", "MEMORY.md");
  const setMemory = (s: string) => { mkdirSync(join(dir, "memory"), { recursive: true }); writeFileSync(memFile, s); };
  const calls: { kind: string; prompt: string }[] = [];
  let consolidate: (prompt: string) => { ok: boolean; text: string } = () => ({ ok: false, text: "not scripted" });
  const deps = (over: Partial<DreamDeps> = {}): DreamDeps => ({
    memory: mem, maxMemoryBytes: 24_000, now: () => now,
    complete: async (kind, prompt) => {
      calls.push({ kind, prompt });
      return kind === "diary" ? { ok: true, text: "A quiet night of tidy thoughts." } : consolidate(prompt);
    },
    ...over,
  });
  return {
    dir, mem, memFile, setMemory, calls, deps,
    setNow: (d: Date) => { now = d; },
    script: (f: typeof consolidate) => { consolidate = f; },
    readMemory: () => readFileSync(memFile, "utf8"),
  };
}

/** Candidate ids in the consolidation prompt, by text. */
const candidateIds = (prompt: string) => {
  const j = JSON.parse(prompt.slice(prompt.indexOf("\n\n{") + 2)) as { candidates: { id: string; text: string }[]; currentEntries: { id: string; text: string }[] };
  return { c: Object.fromEntries(j.candidates.map((x) => [x.text, x.id])), e: Object.fromEntries(j.currentEntries.map((x) => [x.text, x.id])) };
};

describe("ranking (light + deep gates)", () => {
  test("gates: recall, recurrence, importance; internal origins and MEMORY.md duplicates are excluded", () => {
    const t = setup();
    t.setMemory("# Memory\n\n- Hans uses vim\n");
    t.mem.write("The NAS lives at nas.local", { origin: "chat", source: "telegram:1" });
    t.mem.write("Remember to water the plants", { origin: "chat", source: "telegram:1" });
    t.mem.write("Deploys happen on Fridays now", { origin: "chat", source: "telegram:1", importance: 9 });
    t.mem.write("Heartbeat checked the inbox", { origin: "internal", source: "heartbeat", importance: 10 });
    t.mem.write("The deploy password is hunter2", { origin: "group", source: "telegram:-100", importance: 10 });
    t.mem.write("hans uses vim", { origin: "chat", source: "telegram:1" });
    t.setNow(new Date("2026-11-08T04:00:00Z"));
    t.mem.write("Remember to water the plants", { origin: "chat", source: "telegram:1" }); // second day → recurring
    t.mem.search("NAS lives", { recall: true });
    t.mem.search("nas.local", { recall: true });
    const { all } = rankCandidates(t.mem, DEFAULT_DREAMING, new Date("2026-11-08T04:00:00Z"));
    const by = (s: string) => all.find((c) => c.text === s)!;
    expect(by("The NAS lives at nas.local").passed).toEqual(["recall"]);
    expect(by("Remember to water the plants").passed).toEqual(["recurring"]);
    expect(by("Deploys happen on Fridays now").passed).toEqual(["important"]);
    expect(by("Heartbeat checked the inbox").excluded).toContain("origin internal");
    expect(by("The deploy password is hunter2").excluded).toContain("origin group"); // told by someone in a group: never promoted
    expect(by("hans uses vim").excluded).toBe("already in MEMORY.md");
  });

  test("dry run explains and writes nothing", async () => {
    const t = setup();
    t.mem.write("Lunch was ramen", { origin: "chat", source: "telegram:1" });
    const r = await runDreamSweep(t.deps(), DEFAULT_DREAMING, { dryRun: true });
    expect(r.candidates).toHaveLength(0);
    expect(r.rejected![0]!.excluded).toContain("recalled 0×");
    expect(t.calls).toHaveLength(0);
    expect(existsSync(t.memFile)).toBe(false);
    expect(existsSync(join(t.dir, "memory", "DREAMS.md"))).toBe(false);
  });
});

describe("deep phase", () => {
  test("superseded: the model picks the stale entry; the written line is the source entry, with its source", async () => {
    const t = setup();
    t.setMemory("# Memory\n\n- Hans uses vim\n- Deploys happen on Thursdays\n");
    t.mem.write("Deploys happen on Fridays now", { origin: "chat", source: "telegram:1", importance: 9 });
    t.script((p) => {
      const { c, e } = candidateIds(p);
      // The model also tries to sneak in its own text: it must be ignored.
      return { ok: true, text: "```json\n" + JSON.stringify({ operations: [{ candidate: c["Deploys happen on Fridays now"], action: "superseded", replaces: [e["Deploys happen on Thursdays"]], text: "INVENTED" }] }) + "\n```" };
    });
    const r = await runDreamSweep(t.deps());
    expect(r.deep).toMatchObject({ mode: "consolidated", superseded: 1, added: 0, removedEntries: ["Deploys happen on Thursdays"] });
    const m = t.readMemory();
    expect(m).toMatch(/^# Memory\n\n- Hans uses vim\n- Deploys happen on Fridays now <!-- src:m:[a-z0-9]+ memory\/2026-11-07\.md -->\n$/);
    expect(m).not.toContain("INVENTED");
    expect(readdirSync(join(t.dir, "memory", ".history"))).toHaveLength(1);
    const diary = readFileSync(join(t.dir, "memory", "DREAMS.md"), "utf8");
    expect(diary).toContain("## 2026-11-07");
    expect(diary).toContain("A quiet night of tidy thoughts.");
    expect(diary).toContain("~~Deploys happen on Thursdays~~");
    // handled candidates are not offered again
    t.calls.length = 0;
    const again = await runDreamSweep(t.deps());
    expect(again.candidates).toHaveLength(0);
    expect(t.calls.filter((c) => c.kind === "consolidate")).toHaveLength(0);
  });

  test("bad JSON → append-only; skip is honoured; missing candidates default to added", async () => {
    const t = setup();
    t.mem.write("Prefers short replies", { origin: "chat", source: "telegram:1", importance: 9 });
    t.script(() => ({ ok: true, text: "Sure! Here you go: not json" }));
    const r = await runDreamSweep(t.deps());
    expect(r.deep).toMatchObject({ mode: "append-only", added: 1, reason: "model reply was not valid operations JSON" });
    expect(t.readMemory()).toContain("- Prefers short replies <!-- src:");

    const u = setup();
    u.mem.write("Had pizza today", { origin: "chat", source: "telegram:1", importance: 8 });
    u.mem.write("Works at Acme on the infra team", { origin: "chat", source: "telegram:1", importance: 9 });
    u.script((p) => ({ ok: true, text: JSON.stringify({ operations: [{ candidate: candidateIds(p).c["Had pizza today"], action: "skip" }] }) }));
    const r2 = await runDreamSweep(u.deps());
    expect(r2.deep).toMatchObject({ mode: "consolidated", added: 1, skipped: 1 });
    expect(u.readMemory()).not.toContain("pizza");
    expect(u.readMemory()).toContain("Works at Acme");
  });

  test("entry-loss limit and size budget are enforced", async () => {
    const t = setup();
    t.setMemory("- a one\n- b two\n- c three\n- d four\n");
    t.mem.write("Everything changed", { origin: "chat", source: "telegram:1", importance: 9 });
    t.script((p) => {
      const { c, e } = candidateIds(p);
      return { ok: true, text: JSON.stringify({ operations: [{ candidate: c["Everything changed"], action: "merged", replaces: [e["a one"], e["b two"], e["c three"]] }] }) };
    });
    const r = await runDreamSweep(t.deps());
    expect(r.deep.mode).toBe("append-only");
    expect(r.deep.reason).toContain("would replace 3 of 4 entries (limit 1)");
    expect(t.readMemory()).toStartWith("- a one\n- b two\n- c three\n- d four\n- Everything changed");

    const u = setup();
    u.setMemory("- already quite a long entry here\n");
    u.mem.write("One more fact that does not fit", { origin: "chat", source: "telegram:1", importance: 9 });
    u.script(() => ({ ok: true, text: "{\"operations\":[]}" }));
    const r2 = await runDreamSweep(u.deps({ maxMemoryBytes: 50 }));
    expect(r2.deep.mode).toBe("unchanged");
    expect(u.readMemory()).toBe("- already quite a long entry here\n");
    // still eligible next time
    expect((await runDreamSweep(u.deps(), DEFAULT_DREAMING, { dryRun: true })).candidates).toHaveLength(1);
  });

  test("MEMORY.md edited during the sweep → no rewrite; a failed diary leaves a visible note", async () => {
    const t = setup();
    t.setMemory("- old\n");
    t.mem.write("New fact", { origin: "chat", source: "telegram:1", importance: 9 });
    t.script(() => { writeFileSync(t.memFile, "- old\n- edited by a human\n"); return { ok: true, text: "{\"operations\":[]}" }; });
    const r = await runDreamSweep(t.deps({
      complete: async (kind) => (kind === "diary" ? { ok: false, text: "timed out after 600s" } : (writeFileSync(t.memFile, "- old\n- edited by a human\n"), { ok: true, text: "{\"operations\":[]}" })),
    }));
    expect(r.deep.mode).toBe("unchanged");
    expect(r.deep.reason).toContain("changed during the sweep");
    expect(t.readMemory()).toBe("- old\n- edited by a human\n");
    expect(readFileSync(join(t.dir, "memory", "DREAMS.md"), "utf8")).toContain("(no diary text tonight: timed out after 600s)");
  });

  test("a night with new notes but no candidates still gets a diary entry; an empty night gets none", async () => {
    const t = setup();
    expect((await runDreamSweep(t.deps())).deep.mode).toBe("none");
    expect(existsSync(join(t.dir, "memory", "DREAMS.md"))).toBe(false);
    t.mem.write("Walked by the river", { origin: "chat", source: "telegram:1" });
    const r = await runDreamSweep(t.deps());
    expect(r.deep.mode).toBe("none");
    expect(t.calls.map((c) => c.kind)).toEqual(["diary"]);
    expect(t.calls[0]!.prompt).toContain("- Walked by the river");
    expect(readFileSync(join(t.dir, "memory", "DREAMS.md"), "utf8")).toContain("_No candidates for long-term memory._");
  });

  test("extractJson tolerates fences and prose", () => {
    expect(extractJson("Here:\n```json\n{\"a\":1}\n```\nbye")).toEqual({ a: 1 });
    expect(extractJson("ok {\"a\":{\"b\":2}} done")).toEqual({ a: { b: 2 } });
    expect(extractJson("nothing")).toBeUndefined();
  });
});
