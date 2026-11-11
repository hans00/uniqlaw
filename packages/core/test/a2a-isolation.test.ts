// Inbound A2A sessions are isolated from the operator: fail closed on providers that can't isolate them, an empty
// working directory outside the project, no native memory, the exposed profile's own prompt, no file/agent tools.
import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { A2A_DENIED_GROUPS, ChannelManager, a2aSessionDir, StateStore, a2aPermissions, parseSettings, silentLogger, type SessionContext } from "../src/index.ts";
import { CAPS, FakePlatform, FakeProvider } from "./fakes.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

type Spec = { sessionId: string; cwd: string; isolated?: boolean; nativeMemory?: boolean; profile: { name: string } };

function setup(isolation: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "uq-a2a-iso-"));
  const base = mkdtempSync(join(tmpdir(), "uq-a2a-base-"));
  const store = new StateStore(join(dir, "state.db"));
  // memory.nativeMemory on: chats keep the provider's own memory, so an A2A session's `false` is the isolation's doing.
  const settings = parseSettings({ profiles: { main: { provider: "fake" }, other: { provider: "fake" } }, queue: { debounceMs: 0 }, memory: { nativeMemory: true } });
  const provider = new FakeProvider((input, s) => s.emit({ type: "text", segmentId: "a", final: `ok: ${input.text.split("\n").at(-1)}` }, { type: "turn_end", turnId: s.turnId(), reason: "done" }),
    { ...CAPS, isolation });
  const prompts: (SessionContext | undefined)[] = [];
  const profile = (name: string) => ({ name, provider: "fake", permissions: settings.profiles[name]!.permissions, options: {} });
  const mgr = new ChannelManager({ log: silentLogger, settings, store, projectDir: dir, instanceId: "t", a2aSessionsBase: base,
    providers: new Map([["fake", provider]]), platforms: new Map([["tg", new FakePlatform()]]),
    profiles: new Map([["main", profile("main")], ["other", profile("other")]]),
    gatewayFor: () => undefined, systemPrompt: async (_p, _m, _t, session) => { prompts.push(session); return { fragments: [] }; }, providerEnv: async () => ({}) });
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }), () => rmSync(base, { recursive: true, force: true }), () => store.close(), () => mgr.stop());
  return { mgr, provider, prompts, dir, base, specs: () => provider.specs as unknown as Spec[] };
}
const req = (o: Record<string, unknown> = {}) => ({ profile: "main", caller: "alice", remote: "alice", contextId: "c1", taskId: crypto.randomUUID(), text: "hi", hop: 1, ...o });

test("fail closed: a provider without the isolation capability never opens an inbound A2A session", async () => {
  const { mgr, specs } = setup(false);
  const r = await mgr.runInbound(req());
  expect(r).toEqual({ ok: false, text: 'profile "main" runs on a provider that cannot isolate remote requests' });
  expect(mgr.runtimes.has("a2a:main:alice:c1")).toBe(false); // refused before any session or task was created
  expect(specs()).toHaveLength(0);
  // The runtime refuses too (e.g. a session restored after a restart, opened without runInbound).
  const rt = mgr.runtime("a2a:main:alice:c2");
  await rt.ensureOpen(); // open() reports failures to the turn's origin and leaves the runtime closed
  expect(rt.state).toBe("closed");
  expect(specs()).toHaveLength(0);
});

test("unsafeProvider (operator opt-in) opens it anyway, still flagged isolated", async () => {
  const { mgr, specs } = setup(false);
  expect(await mgr.runInbound(req({ unsafeProvider: true }))).toEqual({ ok: true, text: "ok: hi" });
  expect(specs()[0]!.isolated).toBe(true);
});

test("isolated spec: empty working directory of its own outside the project, no native memory, the exposed prompt only", async () => {
  const { mgr, specs, prompts, dir, base } = setup(true);
  await mgr.runInbound(req({ prompt: "You are the public research agent." }));
  await mgr.runInbound(req({ caller: "bob" }));
  const [a, b] = specs();
  expect(a!.isolated).toBe(true);
  expect(a!.nativeMemory).toBe(false);
  expect(a!.cwd.startsWith(base)).toBe(true);
  expect(a!.cwd.startsWith(dir)).toBe(false);
  expect(a!.cwd).not.toBe(b!.cwd);
  expect(readdirSync(a!.cwd)).toEqual([]);
  expect(existsSync(join(a!.cwd, ".git"))).toBe(false);
  expect(a!.cwd).not.toContain("alice"); // the path names no caller
  expect(prompts[0]).toMatchObject({ channelKey: "a2a:main:alice:c1", a2a: { prompt: "You are the public research agent." } });
  expect(prompts[1]!.a2a).toEqual({});
  // Chats keep the project directory, their native memory setting and no a2a context.
  await mgr.runtime("tg:1").ensureOpen();
  expect(specs().at(-1)!.cwd).toBe(dir);
  expect(specs().at(-1)!.nativeMemory).toBe(true);
  expect(specs().at(-1)!.isolated).toBeUndefined();
  expect(prompts.at(-1)!.a2a).toBeUndefined();
});

test("a restored A2A session runs on the profile its key names, not the default binding", () => {
  const { mgr } = setup(true);
  expect(mgr.profileFor("a2a:other:alice:c1").name).toBe("other");
  expect(mgr.profileFor("a2a:other:alice:c1").permissions.level).toBe("strict");
});

test("default denied set also covers file reads and sub-agents/skills", () => {
  const p = a2aPermissions(parseSettings({ profiles: { m: { provider: "x" } } }).profiles.m!.permissions);
  for (const t of ["Read", "Grep", "Glob", "LSP", "Task", "Agent", "Workflow", "Skill"]) expect(p.denyTools).toContain(t);
  expect(Object.keys(A2A_DENIED_GROUPS)).toEqual(expect.arrayContaining(["files.read", "agents"]));
});

test("session directory: 0700, and a pre-created world-writable one (shared temp dir) is refused", () => {
  const base = mkdtempSync(join(tmpdir(), "uq-a2a-dir-"));
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  const d = a2aSessionDir("i1", "a2a:main:alice:c", base);
  expect(statSync(d).mode & 0o777).toBe(0o700);
  expect(statSync(join(base, "uniqlaw-a2a-i1")).mode & 0o777).toBe(0o700);
  mkdirSync(join(base, "uniqlaw-a2a-i2"));
  chmodSync(join(base, "uniqlaw-a2a-i2"), 0o777); // planted by another user
  expect(() => a2aSessionDir("i2", "a2a:main:alice:c", base)).toThrow(/refusing A2A session directory/);
});
