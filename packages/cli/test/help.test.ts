// `<command> --help` / `-h` must print usage and do nothing else. A fake project whose runtime.json points at a
// live decoy process (stands in for the daemon pid: `stop` would SIGTERM it, `start` would see it as running)
// and a dummy HTTP server (stands in for the daemon API: counts every request) proves it.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isAlive } from "@uniqlaw/daemon";

const MAIN = join(import.meta.dir, "..", "src", "main.ts");

let root: string, project: string, state: string;
let decoy: ReturnType<typeof Bun.spawn>;
let server: ReturnType<typeof Bun.serve>;
const hits: string[] = [];

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "uniqlaw-help-"));
  project = join(root, "proj");
  state = join(root, "state");
  mkdirSync(join(project, ".uniqlaw"), { recursive: true });
  mkdirSync(state);
  decoy = Bun.spawn(["sleep", "300"], { stdio: ["ignore", "ignore", "ignore"] });
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) { hits.push(new URL(req.url).pathname); return Response.json({ ok: true }); } });
  writeFileSync(join(project, ".uniqlaw", "settings.json"), "{}\n");
  writeFileSync(join(project, ".uniqlaw", "runtime.json"), JSON.stringify({
    pid: decoy.pid, instanceId: "test", projectDir: project, startedAt: Date.now(), webPort: server.port, gatewayPort: 1, version: "test",
  }));
});

afterAll(() => {
  decoy.kill();
  server.stop(true);
  rmSync(root, { recursive: true, force: true });
});

/** Every path under the project and state dirs with its mtime: any write shows up as a difference. (HOME is
 *  left out: bun keeps its own install cache there.) */
function snapshot(): string {
  const out: string[] = [];
  const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); const s = statSync(p); out.push(`${p}:${s.mtimeMs}:${s.size}`); if (s.isDirectory()) walk(p); } };
  walk(project);
  walk(state);
  return out.sort().join("\n");
}

async function cli(args: string[]) {
  const p = Bun.spawn([process.execPath, MAIN, ...args], {
    cwd: project, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    env: { PATH: process.env.PATH!, HOME: join(root, "home"), XDG_STATE_HOME: state, UNIQLAW_SESSION: "" },
  });
  const timer = setTimeout(() => p.kill(), 10_000); // a command that ran instead of printing help (run, mcp-shim)
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  clearTimeout(timer);
  return { stdout, stderr, code };
}

/** Each command, with the positional words it needs to get past its own usage check. */
const COMMANDS: [string, string[]][] = [
  ["init", []], ["doctor", []], ["logs", []], ["run", []], ["start", []], ["stop", []], ["reload", []],
  ["restart", []], ["status", []], ["ls", []], ["send", ["telegram:1", "hi"]], ["trigger", ["telegram:1", "hi"]],
  ["pairing", []], ["pairing", ["approve", "ABCD1234"]], ["pairing", ["deny", "ABCD1234"]], ["pairing", ["revoke", "telegram", "1"]],
  ["workers", []], ["worker", ["start", "w1", "--profile", "main", "do", "it"]], ["worker", ["stop", "w1"]],
  ["attach", ["w1"]], ["release", ["w1"]], ["dream", []], ["mcp-shim", []],
];

for (const [cmd, extra] of COMMANDS) {
  for (const flag of ["--help", "-h"]) {
    for (const args of [[cmd, flag, ...extra], [cmd, ...extra, flag]]) {
      test(`uniqlaw ${args.join(" ")}: prints usage, exits 0, no side effects`, async () => {
        hits.length = 0;
        const before = snapshot();
        const r = await cli(args);
        expect(r.code).toBe(0);
        expect(r.stdout).toContain(`uniqlaw ${cmd}`);
        expect(hits).toEqual([]);
        expect(isAlive(decoy.pid)).toBe(true);
        expect(snapshot()).toBe(before);
      }, 15_000);
    }
  }
}

test("`uniqlaw`, `uniqlaw --help`, `-h`, `help` print the global usage and exit 0; `help <cmd>` the command's", async () => {
  for (const args of [[], ["--help"], ["-h"], ["help"]]) {
    const r = await cli(args);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("uniqlaw <command> [options]");
  }
  const r = await cli(["help", "stop"]);
  expect(r.code).toBe(0);
  expect(r.stdout).toContain("uniqlaw stop");
  expect(r.stdout).not.toContain("uniqlaw <command>");
  expect(hits).toEqual([]);
});

test("unknown options are rejected with exit 2 before anything runs", async () => {
  for (const args of [["stop", "--bogus"], ["restart", "--in", "1m", "--foce"], ["send", "telegram:1", "hi", "--bogus", "x"],
    ["worker", "stop", "w1", "--forgett"], ["pairing", "approve", "ABCD1234", "--yes"], ["start", "--project=."], ["dream", "--dryrun"], ["stop", "-x"], ["send", "telegram:1", "-v"]]) {
    hits.length = 0;
    const before = snapshot();
    const r = await cli(args);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("unknown option");
    expect(hits).toEqual([]);
    expect(isAlive(decoy.pid)).toBe(true);
    expect(snapshot()).toBe(before);
  }
});

test("unknown command exits 1 without contacting anything", async () => {
  for (const c of ["stpo", "toString", "constructor"]) {
    hits.length = 0;
    const r = await cli([c, "--help"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`unknown command "${c}"`);
    expect(hits).toEqual([]);
  }
});

test("control: without --help the same harness does see the API call (so the checks above are meaningful)", async () => {
  hits.length = 0;
  const r = await cli(["send", "--", "telegram:1", "--looks-like-a-flag", "-h"]);
  expect(r.code).toBe(0);
  expect(hits).toEqual(["/api/send"]);
});
