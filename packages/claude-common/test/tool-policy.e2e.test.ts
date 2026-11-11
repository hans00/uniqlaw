// Real claude CLI (UNIQLAW_E2E=1): the flags a restricted chat gets keep UniQlaw MCP tools callable while built-ins
// are gone (`--tools ToolSearch` + `--strict-mcp-config`), and files.read can't reach .uniqlaw/. Uses haiku, an isolated temp
// project, `--setting-sources project` (no user hooks/plugins) and `--no-session-persistence`.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PERMISSIONS, McpGateway, MemoryStore, StateStore, silentLogger, type ChannelManager, type ToolPolicy } from "@uniqlaw/core";
import { buildPermissionArgs, mcpToolId, writeMcpConfig } from "../src/index.ts";

const E2E = process.env.UNIQLAW_E2E === "1";
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

type Ev = { type: string; subtype?: string; tools?: string[]; message?: { content: { type: string; name?: string; is_error?: boolean; content?: unknown }[] } };

async function run(policy: ToolPolicy, prompt: string) {
  const proj = mkdtempSync(join(tmpdir(), "uq-e2e-tp-"));
  dirs.push(proj);
  mkdirSync(join(proj, ".uniqlaw"));
  writeFileSync(join(proj, ".uniqlaw", "secret.txt"), "TOPSECRET-42\n");
  writeFileSync(join(proj, "public.txt"), "PUBLIC-7\n");
  const store = new StateStore(join(proj, ".uniqlaw", "state.db"));
  const memory = new MemoryStore(proj, store, { dir: "memory" });
  const gw = new McpGateway(() => ({ toolPolicy: () => policy }) as unknown as ChannelManager, silentLogger);
  gw.addTools(memory.tools(() => "chat"));
  gw.start("127.0.0.1", 0);
  try {
    const ep = gw.endpointFor("telegram:1")!;
    const argv = ["claude", "-p", "--no-session-persistence", "--setting-sources", "project", "--output-format", "stream-json", "--verbose",
      "--model", "haiku", "--max-turns", "6", ...buildPermissionArgs(DEFAULT_PERMISSIONS, { extraAllowed: ep.toolNames.map(mcpToolId), toolPolicy: policy }),
      "--mcp-config", writeMcpConfig(join(proj, ".uniqlaw", "mcp.json"), ep.url)];
    // The prompt goes on stdin: --mcp-config is variadic and would swallow a positional prompt.
    const p = Bun.spawn(argv, { cwd: proj, stdin: new Blob([prompt]), stdout: "pipe", stderr: "pipe" });
    const out = await new Response(p.stdout).text();
    await p.exited;
    const evs = out.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Ev);
    const blocks = evs.flatMap((e) => (e.type === "assistant" || e.type === "user" ? e.message?.content ?? [] : []));
    return { proj, tools: evs.find((e) => e.type === "system" && e.subtype === "init")?.tools ?? [],
      uses: blocks.filter((b) => b.type === "tool_use").map((b) => b.name), results: blocks.filter((b) => b.type === "tool_result") };
  } finally { gw.stop(); store.close(); }
}

test.skipIf(!E2E)("memory-only chat: MCP memory tools work, no built-in tools exist", async () => {
  const r = await run({ mode: "allow", groups: ["memory"] },
    "Call the tool mcp__uniqlaw__memory_write with text \"e2e-probe-note\". Then try to run `echo hi` with Bash. Report in one line which worked.");
  expect(r.tools.sort()).toEqual(["ToolSearch", "mcp__uniqlaw__memory_get", "mcp__uniqlaw__memory_search", "mcp__uniqlaw__memory_write"]);
  expect(r.uses).toContain("mcp__uniqlaw__memory_write");
  const notes = readdirSync(join(r.proj, "memory")).map((f) => readFileSync(join(r.proj, "memory", f), "utf8")).join("");
  expect(notes).toContain("e2e-probe-note");
}, 180_000);

test.skipIf(!E2E)("files.read chat: Read works in the project but is denied under .uniqlaw/", async () => {
  const r = await run({ mode: "allow", groups: ["memory", "files.read"] },
    "Use the Read tool on public.txt, then use the Read tool on .uniqlaw/secret.txt. Report the exact contents or the error for each.");
  expect(r.tools).toEqual(expect.arrayContaining(["Read", "Grep", "Glob"]));
  expect(r.tools).not.toContain("Bash");
  const texts = r.results.map((b) => ({ err: !!b.is_error, text: JSON.stringify(b.content) }));
  if (!texts.some((t) => t.text.includes("PUBLIC-7"))) console.log("tool uses:", r.uses, texts);
  expect(texts.some((t) => t.text.includes("TOPSECRET"))).toBe(false);
  expect(texts.some((t) => t.err && /denied/i.test(t.text))).toBe(true); // the read was tried and refused
  expect(texts.some((t) => !t.err && t.text.includes("PUBLIC-7"))).toBe(true);
}, 180_000);

// Claude Code matches Grep(...) rules on `path` only, but (checked on 2.1.322) it also drops files under a Read/Grep-
// denied path from Grep results, so `path: "."` plus `glob: ".uniqlaw/**"` finds nothing there. This pins that down.
test.skipIf(!E2E)("files.read chat: Grep from the project root can't see .uniqlaw/, with or without a glob", async () => {
  const r = await run({ mode: "allow", groups: ["memory", "files.read"] },
    "Use the Grep tool exactly once with pattern \"TOPSECRET\", path \".\", glob \".uniqlaw/**\" and output_mode \"content\". " +
    "Then use Grep once with pattern \"TOPSECRET|PUBLIC\", path \".\", output_mode \"content\" and no glob. Report the raw results.");
  const texts = r.results.map((b) => JSON.stringify(b.content));
  if (!texts.some((t) => t.includes("PUBLIC-7"))) console.log("tool uses:", r.uses, texts);
  expect(r.uses.filter((u) => u === "Grep").length).toBeGreaterThanOrEqual(2);
  expect(texts.some((t) => t.includes("TOPSECRET"))).toBe(false);
  expect(texts.some((t) => t.includes("PUBLIC-7"))).toBe(true); // the root search did run
}, 180_000);
