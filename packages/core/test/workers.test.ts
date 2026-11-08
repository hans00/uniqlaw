// Workers: sessions that run another coding agent (a profile) in a chosen directory, started by a
// session via worker_start; humans take them over from a chat (/attach) or a terminal (takeover).
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChannelManager, StateStore, parseSettings, silentLogger, type Profile } from "../src/index.ts";
import { CAPS, FakePlatform, FakeProvider, type Script } from "./fakes.ts";

let dir: string;
let outside: string;
let store: StateStore;
let managers: ChannelManager[] = [];
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "uq-work-")));
  outside = realpathSync(mkdtempSync(join(tmpdir(), "uq-out-")));
  mkdirSync(join(dir, "repo"));
  store = new StateStore(join(dir, "state.db"));
});
afterEach(async () => {
  for (const m of managers) await m.stop();
  managers = [];
  store.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

class AttachableProvider extends FakeProvider {
  live = true;
  attachCommand(o: { sessionId: string; providerSessionId?: string; cwd: string }) {
    return { argv: ["agent", "--resume", o.providerSessionId ?? "?"], live: this.live };
  }
}

function setup(script: Script, settings: Record<string, unknown> = {}) {
  const s = parseSettings({ profiles: { main: { provider: "fake" }, coder: { provider: "fake" } }, output: { toolStatus: false }, queue: { debounceMs: 0 }, ...settings });
  const provider = new AttachableProvider(script, CAPS);
  const platform = new FakePlatform();
  const prof = (name: string): Profile => ({ name, provider: "fake", permissions: s.profiles.main!.permissions, options: {} });
  const mgr = new ChannelManager({
    log: silentLogger, settings: s, store, projectDir: dir, instanceId: "test",
    providers: new Map([["fake", provider]]), platforms: new Map([["tg", platform]]),
    profiles: new Map([["main", prof("main")], ["coder", prof("coder")]]),
    gatewayFor: () => undefined, providerEnv: async () => ({}),
    systemPrompt: async (_p, _m, _t, session) => ({ fragments: session?.worker ? [{ id: "worker-session", text: `${session.cwd}|${session.worker.owner}` }] : [] }),
  });
  managers.push(mgr);
  return { mgr, provider, platform };
}

const until = async (cond: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error("timeout"); await Bun.sleep(5); }
};
const echo: Script = (input, s) => {
  const text = input.text.includes("from session") ? "done: fixed the bug" : `you said: ${input.text.slice(-20)}`;
  s.emit({ type: "text", segmentId: "a", final: text }, { type: "turn_end", turnId: s.turnId(), reason: "done" });
};
const dm = (chatId: string, text: string) => ({ platform: "tg", channelKey: `tg:${chatId}`, replyTarget: { platform: "tg", chatId }, ref: { platform: "tg", chatId, messageId: "m" },
  sender: { id: chatId, name: "u" + chatId }, trusted: true, multiparty: false, text, attachments: [], receivedAt: Date.now() });

test("worker_start runs the profile in the chosen directory and reports back to the caller", async () => {
  const { mgr, provider } = setup(echo);
  await mgr.handleInbound(dm("100", "hi"));
  // from the CLI: the async result stays in the task, no "cli" session appears
  const viaCli = await mgr.startWorker("cli", { name: "cli-job", profile: "coder", cwd: "repo", task: "go" });
  await until(() => mgr.taskStatus(viaCli.taskId!)?.state === "completed");
  await Bun.sleep(20);
  expect(mgr.runtimes.has("cli")).toBe(false);
  const r = await mgr.startWorker("tg:100", { name: "fix", profile: "coder", cwd: "repo", task: "fix the bug", wait: true });
  expect(r).toMatchObject({ worker: "worker:fix", cwd: join(dir, "repo"), profile: "coder", created: true, result: { ok: true, text: "done: fixed the bug" } });
  const spec = provider.specs.find((x) => x.sessionId === "worker:fix")!;
  expect(spec.cwd).toBe(join(dir, "repo"));
  expect(spec.profile!.name).toBe("coder");
  expect(spec.systemPrompt!.fragments).toEqual([{ id: "worker-session", text: `${join(dir, "repo")}|tg:100` }]);
  expect(provider.specs.find((x) => x.sessionId === "tg:100")!.cwd).toBe(dir);
  const w = mgr.listAgents().find((a) => a.name === "worker:fix")!;
  expect(w).toMatchObject({ kind: "worker", cwd: join(dir, "repo"), owner: "tg:100", profile: "coder" });
  // follow-ups go through agent_ask; the bare name resolves too
  const again = await mgr.ask("tg:100", "fix", "and add a test", true);
  expect(again.result?.text).toBe("done: fixed the bug");
});

test("directory, profile and count limits", async () => {
  const { mgr } = setup(echo, { workers: { profiles: ["coder"], max: 1 } });
  await expect(mgr.startWorker("tg:1", { name: "a", profile: "coder", cwd: outside })).rejects.toThrow(/outside the allowed worker directories/);
  await expect(mgr.startWorker("tg:1", { name: "a", profile: "coder", cwd: join(dir, "nope") })).rejects.toThrow(/not found/);
  await expect(mgr.startWorker("tg:1", { name: "a", profile: "main" })).rejects.toThrow(/not allowed for workers/);
  await expect(mgr.startWorker("tg:1", { name: "a" })).rejects.toThrow(/profile is required/);
  await expect(mgr.startWorker("tg:1", { name: "Bad Name", profile: "coder" })).rejects.toThrow(/invalid worker name/);
  await mgr.startWorker("tg:1", { name: "a", profile: "coder", cwd: "repo" });
  await expect(mgr.startWorker("tg:1", { name: "b", profile: "coder" })).rejects.toThrow(/limit reached/);
  await expect(mgr.startWorker("tg:1", { name: "a", cwd: dir })).rejects.toThrow(/directory is fixed/);
  // ../ tricks resolve before the check
  const { mgr: m2 } = setup(echo, { workers: { roots: [join(dir, "repo")] } });
  await expect(m2.startWorker("tg:1", { name: "c", profile: "coder", cwd: join(dir, "repo", "..") })).rejects.toThrow(/outside/);
  await expect(m2.startWorker("tg:1", { name: "c", profile: "coder", cwd: outside })).rejects.toThrow(/outside/);
});

test("roots allow other directories; cwd and profile survive a restart", async () => {
  const { mgr, provider } = setup(echo, { workers: { roots: [outside] } });
  await mgr.startWorker("tg:1", { name: "ext", profile: "coder", cwd: outside });
  await until(() => provider.sessions.has("worker:ext"));
  await mgr.stop();
  const { mgr: m2, provider: p2 } = setup(echo, { workers: { roots: [outside] } });
  await m2.restore();
  await m2.ask("tg:1", "worker:ext", "status?", true);
  const spec = p2.specs.find((x) => x.sessionId === "worker:ext")!;
  expect(spec).toMatchObject({ cwd: outside, providerSessionId: "p-worker:ext", profile: { name: "coder" } });
});

test("/attach routes a chat to the worker; the owner is refused until /detach", async () => {
  const { mgr, provider, platform } = setup(echo);
  await mgr.handleInbound(dm("100", "hi"));
  await until(() => platform.sent.length === 1);
  await mgr.startWorker("tg:100", { name: "fix", profile: "coder", cwd: "repo" });
  await mgr.handleInbound(dm("100", "/attach fix"));
  expect(platform.sent.at(-1)!.text).toMatch(/^Attached to worker:fix/);
  await mgr.handleInbound(dm("100", "use the other approach"));
  await until(() => provider.sessions.get("worker:fix")?.sent.length === 1);
  await until(() => platform.sent.at(-1)!.text.endsWith("other approach"));
  expect(platform.sent.at(-1)!.target).toEqual({ platform: "tg", chatId: "100", replyToMessageId: "m" });
  expect(provider.sessions.get("tg:100")!.sent).toHaveLength(1); // chat's own session untouched
  expect(mgr.listAgents().find((a) => a.name === "worker:fix")!.heldBy).toBe("tg:100");
  await expect(mgr.ask("tg:100", "worker:fix", "status?", false)).rejects.toThrow(/driven by a human \(tg:100\)/);
  // another chat can't grab it
  await mgr.handleInbound(dm("200", "/attach fix"));
  expect(platform.sent.at(-1)!.text).toMatch(/already held by tg:100/);
  await mgr.handleInbound(dm("100", "/detach"));
  expect(platform.sent.at(-1)!.text).toMatch(/^Detached from worker:fix/);
  expect(store.drainPending("tg:100").map((p) => (JSON.parse(p.payload) as { label: string }).label)).toEqual(["a human was driving worker:fix and has detached"]);
  await mgr.handleInbound(dm("100", "back to you"));
  await until(() => provider.sessions.get("tg:100")!.sent.length === 2);
});

test("live terminal takeover holds the worker; its background output stays out of chats", async () => {
  const { mgr, provider, platform } = setup(echo);
  await mgr.startWorker("tg:100", { name: "fix", profile: "coder", cwd: "repo" });
  const t = await mgr.takeover("fix");
  expect(t).toEqual({ key: "worker:fix", argv: ["agent", "--resume", "p-worker:fix"], cwd: join(dir, "repo"), live: true });
  await expect(mgr.ask("tg:100", "worker:fix", "status?", false)).rejects.toThrow(/terminal/);
  await expect(mgr.takeover("worker:fix")).rejects.toThrow(/already held/);
  await expect(mgr.takeover("nope")).rejects.toThrow(/unknown session or worker/);
  // the human types in the terminal: a turn core did not start
  const s = provider.sessions.get("worker:fix")!;
  s.emit({ type: "text", segmentId: "x", final: "edited 3 files" }, { type: "turn_end", turnId: "h1", reason: "done" });
  await Bun.sleep(50);
  expect(platform.sent).toHaveLength(0); // not posted to operators (backgroundNotify)
  expect(s.closed).toBe(false);
  expect(mgr.release("worker:fix")).toBe(true);
  expect(mgr.release("worker:fix")).toBe(false);
  const r = await mgr.ask("tg:100", "worker:fix", "status?", true);
  expect(r.result?.ok).toBe(true);
});

test("handoff takeover closes the session; the next task resumes the same conversation", async () => {
  const { mgr, provider } = setup(echo);
  provider.live = false;
  await mgr.startWorker("tg:100", { name: "fix", profile: "coder", cwd: "repo", task: "go", wait: true });
  const first = provider.sessions.get("worker:fix")!;
  const t = await mgr.takeover("worker:fix");
  expect(t.live).toBe(false);
  expect(first.closed).toBe(true);
  mgr.release("worker:fix");
  await mgr.ask("tg:100", "worker:fix", "continue", true);
  const specs = provider.specs.filter((x) => x.sessionId === "worker:fix");
  expect(specs).toHaveLength(2);
  expect(specs[1]!.providerSessionId).toBe("p-worker:fix");
  // chat sessions are only attachable live
  mgr.runtime("tg:100");
  await expect(mgr.takeover("tg:100")).rejects.toThrow(/only workers/);
});

test("worker_stop keeps the conversation unless forget", async () => {
  const { mgr, provider } = setup(echo);
  await mgr.startWorker("tg:100", { name: "fix", profile: "coder", cwd: "repo", task: "go", wait: true });
  await mgr.stopWorker("fix");
  expect(provider.sessions.get("worker:fix")!.closed).toBe(true);
  expect(mgr.workerMeta("worker:fix")).toBeDefined();
  await mgr.stopWorker("fix", true);
  expect(mgr.workerMeta("worker:fix")).toBeUndefined();
  expect(store.getSession("worker:fix")).toBeUndefined();
  expect(mgr.listAgents().find((a) => a.name === "worker:fix")).toBeUndefined();
  await expect(mgr.ask("tg:100", "worker:fix", "hi", false)).rejects.toThrow(/unknown agent/);
});

test("a handoff survives a daemon restart; nothing reopens the worker while a human holds it", async () => {
  const { mgr, provider } = setup(echo);
  provider.live = false;
  await mgr.startWorker("tg:100", { name: "fix", profile: "coder", cwd: "repo", task: "go", wait: true });
  await mgr.takeover("fix");
  await mgr.stop();
  const { mgr: m2, provider: p2 } = setup(echo);
  await m2.restore();
  expect(m2.runtimes.has("worker:fix")).toBe(false);
  expect(m2.listAgents().find((a) => a.name === "worker:fix")!.heldBy).toBe("terminal");
  // these would otherwise open the session under the human's CLI
  await m2.startWorker("tg:100", { name: "fix" });
  await m2.fireScheduled({ channelKey: "worker:fix", job: "j", text: "x", sourceLine: "[j]" });
  await expect(m2.stopWorker("fix")).rejects.toThrow(/held by terminal/);
  await Bun.sleep(30);
  expect(p2.sessions.has("worker:fix")).toBe(false);
  expect(m2.release("fix")).toBe(true); // `uniqlaw release` after a lost terminal
  await m2.ask("tg:100", "worker:fix", "continue", true);
  expect(p2.specs.find((x) => x.sessionId === "worker:fix")!.providerSessionId).toBe("p-worker:fix");
});

test("a worker's own async results wait in its pending input while a human holds it", async () => {
  const { mgr } = setup(echo);
  await mgr.startWorker("tg:100", { name: "fix", profile: "coder", cwd: "repo" });
  await mgr.handleInbound(dm("100", "/attach fix"));
  // the worker asked the chat session something earlier; the answer comes back while attached
  await mgr.ask("worker:fix", "tg:200", "what's the API key name?", false);
  await until(() => store.countPending("worker:fix") === 1);
  // and the owner can't stop it out from under the human
  await expect(mgr.stopWorker("fix", true)).rejects.toThrow(/held by tg:100/);
});
