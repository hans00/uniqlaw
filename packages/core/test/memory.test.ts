import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, StateStore, chunkMarkdown } from "../src/index.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function setup(now = new Date("2026-11-08T06:30:00Z"), maxInjectBytes?: number) {
  const dir = mkdtempSync(join(tmpdir(), "uq-mem-"));
  dirs.push(dir);
  const store = new StateStore(join(dir, "state.db"));
  let t = now;
  const mem = new MemoryStore(dir, store, { timezone: "Asia/Taipei", now: () => t, ...(maxInjectBytes ? { maxInjectBytes } : {}) });
  return { dir, store, mem, setNow: (d: Date) => { t = d; } };
}

describe("memory store", () => {
  test("write appends to today's note in the configured timezone, with an id, and dedupes", () => {
    const { dir, mem } = setup();
    const a = mem.write("Hans prefers TypeScript over Python for tooling", { origin: "chat", source: "telegram:1", importance: 7 });
    expect(a).toMatchObject({ path: "2026-11-08.md", duplicate: false });
    const b = mem.write("  hans prefers typescript over python for tooling ", { origin: "chat", source: "telegram:2" });
    expect(b.duplicate).toBe(true);
    const text = readFileSync(join(dir, "memory", "2026-11-08.md"), "utf8");
    expect(text).toStartWith("# 2026-11-08\n\n- 14:30 Hans prefers TypeScript");
    expect(text.match(/<!-- m:[a-z0-9]+ -->/g)).toHaveLength(1);
    expect(mem.meta(a.key)).toMatchObject({ origin: "chat", source: "telegram:1", importance: 7 });
  });

  test("search: CJK substrings, short queries, ranking, recall only when asked", () => {
    const { mem } = setup();
    mem.write("今天跟小金討論語音模型的 VLAN 設定", { origin: "chat", source: "telegram:1" });
    mem.write("The router VLAN 20 is for IoT devices", { origin: "chat", source: "telegram:1" });
    mem.write("Lunch was ramen", { origin: "chat", source: "telegram:1" });
    expect(mem.search("語音模型").map((h) => h.text)).toEqual(["今天跟小金討論語音模型的 VLAN 設定"]);
    expect(mem.search("小金").map((h) => h.text)).toEqual(["今天跟小金討論語音模型的 VLAN 設定"]); // 2 chars → LIKE fallback
    expect(mem.search("VLAN").length).toBe(2);
    expect(mem.recallRows()).toHaveLength(0);
    const hits = mem.search("router VLAN", { recall: true });
    expect(hits[0]!.text).toContain("router VLAN 20");
    mem.search("IoT devices", { recall: true });
    const r = mem.recall(hits[0]!.key)!;
    expect(r.count).toBe(2);
    expect(r.queries).toHaveLength(2);
    expect(r.days).toEqual(["2026-11-08"]);
  });

  test("hand-edited files are re-indexed; deleted files drop out; DREAMS.md is never indexed", () => {
    const { dir, mem } = setup();
    mkdirSync(join(dir, "memory", "imports"), { recursive: true });
    writeFileSync(join(dir, "memory", "imports", "claude.md"), "# Notes\n\n- The staging server is called kelp\n");
    writeFileSync(join(dir, "memory", "DREAMS.md"), "- kelp forests at night\n");
    expect(mem.search("kelp").map((h) => h.path)).toEqual(["imports/claude.md"]);
    writeFileSync(join(dir, "memory", "imports", "claude.md"), "- The staging server is called kombu\n");
    utimesSync(join(dir, "memory", "imports", "claude.md"), new Date(), new Date(Date.now() + 5000));
    expect(mem.search("kelp")).toHaveLength(0);
    expect(mem.search("kombu")).toHaveLength(1);
    rmSync(join(dir, "memory", "imports", "claude.md"));
    expect(mem.search("kombu")).toHaveLength(0);
  });

  test("get stays inside the memory dir and pages long files", () => {
    const { dir, mem } = setup();
    mkdirSync(join(dir, "memory"), { recursive: true });
    writeFileSync(join(dir, "memory", "MEMORY.md"), Array.from({ length: 10 }, (_, i) => `- line ${i + 1}`).join("\n"));
    writeFileSync(join(dir, "secret.txt"), "nope");
    expect(mem.get("MEMORY.md", 3, 2)).toBe("- line 3\n- line 4\n[… 6 more lines; continue with from=5]");
    expect(() => mem.get("../secret.txt")).toThrow("outside");
    expect(() => mem.get("/etc/passwd")).toThrow("outside");
  });

  test("injectText caps MEMORY.md at a line boundary and says how to read the rest", () => {
    const { dir, mem } = setup(undefined, 60);
    mkdirSync(join(dir, "memory"), { recursive: true });
    writeFileSync(join(dir, "memory", "MEMORY.md"), Array.from({ length: 10 }, (_, i) => `- entry number ${i + 1}`).join("\n"));
    const t = mem.injectText();
    expect(t).toStartWith("- entry number 1\n- entry number 2\n- entry number 3");
    expect(t).toContain("truncated at 60 bytes");
    expect(t).not.toContain("entry number 10");
  });

  test("chunking keeps continuation lines with their list item and strips annotations", () => {
    const c = chunkMarkdown("2026-11-08.md", "# 2026-11-08\n\n- 09:00 first\n  more of first <!-- m:abc -->\n- second\n\nA paragraph\nspanning lines\n");
    expect(c.map((x) => [x.key, x.text, x.startLine, x.endLine])).toEqual([
      ["m:abc", "first more of first", 3, 4],
      [expect.stringMatching(/^2026-11-08\.md#/), "second", 5, 5],
      [expect.stringMatching(/^2026-11-08\.md#/), "A paragraph spanning lines", 7, 8],
    ]);
    expect(c[0]!.day).toBe("2026-11-08");
  });

  test("tools: dream session can't write; chat searches record recall, internal ones don't", async () => {
    const { mem } = setup();
    const tools = Object.fromEntries(mem.tools((c) => (c.startsWith("telegram:") ? "chat" : "internal"), (c) => c !== "dream").map((t) => [t.name, t]));
    expect(await tools.memory_write!.handler({ text: "Deploys happen on Fridays" }, "telegram:1")).toMatchObject({ saved: true });
    await expect(tools.memory_write!.handler({ text: "x" }, "dream")).rejects.toThrow("cannot write");
    await tools.memory_search!.handler({ query: "Deploys" }, "heartbeat");
    expect(mem.recallRows()).toHaveLength(0);
    const r = await tools.memory_search!.handler({ query: "Deploys" }, "telegram:1") as { ref: string }[];
    expect(r[0]!.ref).toMatch(/^memory\/2026-11-08\.md#L3-L3$/);
    expect(mem.recallRows()).toHaveLength(1);
    expect(await tools.memory_get!.handler({ path: "memory/2026-11-08.md" }, "telegram:1")).toContain("Deploys happen on Fridays");
  });
});
