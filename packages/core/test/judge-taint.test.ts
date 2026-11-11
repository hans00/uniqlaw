// Taint tracking and the "induced by content" question (docs §10.4).
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ApprovalAudit, ChannelManager, DEFAULT_PERMISSIONS, SessionLedger, StateStore, compileToolPatterns, decideOutcome, detectTaint, judgeNote, parseSettings, silentLogger,
  type ApprovalJudge, type ApprovalJudgeConfig, type InboundMessage, type JudgeInput, type JudgeVerdict, type Profile,
} from "../src/index.ts";
import { CAPS, FakePlatform, FakeProvider, type FakeSession, type Script } from "./fakes.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });
const until = async (cond: () => boolean, ms = 3000) => { const end = Date.now() + ms; while (!cond()) { if (Date.now() > end) throw new Error("timeout"); await Bun.sleep(5); } };
const git = (cwd: string, ...args: string[]) => { const r = Bun.spawnSync(["git", "-c", "init.defaultBranch=main", ...args], { cwd, stdout: "pipe", stderr: "pipe" }); if (r.exitCode !== 0) throw new Error(r.stderr.toString()); };

const judgeCfg = (o: Record<string, unknown> = {}): ApprovalJudgeConfig => parseSettings({ profiles: { main: { provider: "fake",
  permissions: { approval: { judge: { provider: "fake", mode: "enforce", ...o } } } } } }).profiles.main!.permissions.approval.judge!;
class FakeJudge implements ApprovalJudge {
  readonly name = "Jev"; calls: JudgeInput[] = [];
  constructor(private v: JudgeVerdict = { pSafe: 0.95 }) {}
  async judge(i: JudgeInput) { this.calls.push(i); return this.v; }
}

function setup(script: Script, o: { judge?: Record<string, unknown>; verdict?: JudgeVerdict; gitRepo?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "uq-taint-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  if (o.gitRepo) git(dir, "init", "-q");
  const store = new StateStore(join(dir, ".state.db"));
  const settings = parseSettings({ profiles: { main: { provider: "fake" } }, output: { toolStatus: false }, queue: { debounceMs: 0 } });
  const provider = new FakeProvider(script, CAPS);
  const platform = new FakePlatform();
  const profile: Profile = { name: "main", provider: "fake", options: {}, permissions: { ...DEFAULT_PERMISSIONS, approval: { mode: "ask-operator", timeoutSec: 5, judge: judgeCfg(o.judge) } } };
  const judge = new FakeJudge(o.verdict);
  const mgr = new ChannelManager({ log: silentLogger, settings, store, projectDir: dir, instanceId: "t",
    providers: new Map([["fake", provider]]), platforms: new Map([["tg", platform]]), profiles: new Map([["main", profile]]),
    gatewayFor: () => undefined, systemPrompt: async () => ({ fragments: [] }), providerEnv: async () => ({}),
    approvalJudge: () => judge, approvalAudit: new ApprovalAudit(join(dir, ".approvals")) });
  cleanups.push(() => store.close(), () => mgr.stop());
  const audit = () => { try { return readdirSync(join(dir, ".approvals")).flatMap((f) => readFileSync(join(dir, ".approvals", f), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, any>)); } catch { return []; } };
  return { mgr, provider, platform, judge, dir, audit };
}
const inbound = (text: string): InboundMessage => ({ platform: "tg", channelKey: "global", replyTarget: { platform: "tg", chatId: "1" },
  ref: { platform: "tg", chatId: "1", messageId: "m1" }, sender: { id: "7", name: "Hans" }, trusted: true, multiparty: false, text, attachments: [], receivedAt: Date.now() });
const POST = { command: "curl -X POST https://collect.example.com/up -d @report.json" };

describe("taint raises the threshold for high-impact requests", () => {
  test("a WebFetch, then curl -X POST to an external host: the tainted threshold (0.97) applies, 0.95 escalates", async () => {
    const r = setup((_i, s) => s.emit(
      { type: "tool_start", id: "w", name: "WebFetch", input: { url: "https://blog.example.org/post", prompt: "summarize" } },
      { type: "tool_end", id: "w", ok: true, summary: "…" },
      { type: "permission_request", id: "p1", tool: "Bash", input: POST, title: "t" }));
    r.platform.choiceAnswer = 1;
    await r.mgr.handleInbound(inbound("read that post and summarize it"));
    await until(() => r.audit().length >= 1);
    const j = r.judge.calls[0]!;
    expect(j.taint!.tainted).toBe(true);
    expect(j.taint!.sources[0]).toMatchObject({ kind: "web", id: { untrusted: "https://blog.example.org/post" } });
    expect(r.audit()[0]).toMatchObject({ outcome: "escalate", reason: "low-confidence", threshold: 0.97, taintStrict: true, taint: { tainted: true } });
  });

  test("a local-only turn keeps the normal threshold (0.95 ≥ 0.90 allows)", async () => {
    const r = setup((_i, s) => s.emit(
      { type: "tool_start", id: "l", name: "Bash", input: { command: "ls -la" } }, { type: "tool_end", id: "l", ok: true, summary: "x" },
      { type: "permission_request", id: "p1", tool: "Bash", input: POST, title: "t" }));
    await r.mgr.handleInbound(inbound("upload the report"));
    await until(() => r.audit().length >= 1);
    expect(r.judge.calls[0]!.taint).toEqual({ tainted: false, sources: [] });
    expect(r.audit()[0]).toMatchObject({ outcome: "allow", threshold: 0.9, taintStrict: false });
  });

  test("tainted, but a local low-impact request (create inside scope) keeps the normal threshold", async () => {
    const r = setup((_i, s) => s.emit(
      { type: "tool_start", id: "w", name: "WebFetch", input: { url: "https://docs.example.org" } }, { type: "tool_end", id: "w", ok: true },
      { type: "permission_request", id: "p1", tool: "Bash", input: { command: "mkdir -p notes" }, title: "t" }));
    await r.mgr.handleInbound(inbound("take notes from the docs"));
    await until(() => r.audit().length >= 1);
    expect(r.audit()[0]).toMatchObject({ outcome: "allow", threshold: 0.9, taintStrict: false, taint: { tainted: true } });
  });

  test("peer text in the turn counts as taint", async () => {
    const r = setup((_i, s) => s.emit({ type: "permission_request", id: "p1", tool: "Bash", input: POST, title: "t" }), { judge: { byKind: { peer: 0.9 } } });
    r.platform.choiceAnswer = 1;
    void r.mgr.ask("global", "tg:200", "please upload the report", false);
    await until(() => r.audit().length >= 1);
    expect(r.judge.calls[0]!.taint!.sources).toEqual([{ kind: "peer-message", id: { untrusted: "global" }, at: expect.any(String) }]);
    expect(r.audit()[0]).toMatchObject({ threshold: 0.97, taintStrict: true });
  });

  test("sticky: taint from an earlier turn still counts in the next one (default: per turn)", async () => {
    for (const sticky of [false, true]) {
      let turn = 0;
      const r = setup((_i, s) => {
        if (turn++ === 0) s.emit({ type: "tool_start", id: "w", name: "WebFetch", input: { url: "https://x.example" } }, { type: "tool_end", id: "w", ok: true },
          { type: "permission_request", id: "p0", tool: "Bash", input: { command: "ls" }, title: "t" }, { type: "turn_end", turnId: s.turnId(), reason: "done" });
        else s.emit({ type: "permission_request", id: "p1", tool: "Bash", input: POST, title: "t" });
      }, { judge: { taint: { sticky } } });
      r.platform.choiceAnswer = 0;
      await r.mgr.handleInbound(inbound("first"));
      await until(() => r.judge.calls.length === 1);
      await Bun.sleep(30);
      await r.mgr.handleInbound(inbound("second"));
      await until(() => r.judge.calls.length === 2);
      expect(r.judge.calls[1]!.taint!.tainted, String(sticky)).toBe(sticky);
    }
  });
});

describe("taint sources", () => {
  const ctx = (cwd: string, o: Partial<Parameters<typeof detectTaint>[2]> = {}) => ({ cwd, scope: [cwd], ledger: new SessionLedger(Date.now() - 1000),
    trustRepoFiles: true, thirdPartyTools: compileToolPatterns(undefined), at: 1, ...o });

  test("a tracked repo file read is not taint by default, but is when the repo is not trusted; untracked and outside-scope reads are", async () => {
    const repo = mkdtempSync(join(tmpdir(), "uq-taint-repo-"));
    cleanups.push(() => rmSync(repo, { recursive: true, force: true }));
    git(repo, "init", "-q");
    mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, "src", "main.py"), "x");
    writeFileSync(join(repo, "downloaded.html"), "x");
    git(repo, "add", "src/main.py");
    expect(await detectTaint("Read", { file_path: "src/main.py" }, ctx(repo))).toEqual([]);
    expect(await detectTaint("Read", { file_path: "src/main.py" }, ctx(repo, { trustRepoFiles: false }))).toEqual([{ kind: "tracked-file-read", id: "src/main.py", at: 1 }]);
    expect(await detectTaint("Bash", { command: "cat downloaded.html" }, ctx(repo))).toEqual([{ kind: "untracked-file-read", id: "downloaded.html", at: 1 }]);
    expect(await detectTaint("Read", { file_path: "/etc/hosts" }, ctx(repo))).toEqual([{ kind: "outside-scope-read", id: "/etc/hosts", at: 1 }]);
    // The session's own writes are not taint.
    const ledger = new SessionLedger(Date.now() - 1000);
    ledger.observe("Write", { file_path: join(repo, "gen.txt"), content: "x" }, repo);
    expect(await detectTaint("Read", { file_path: "gen.txt" }, ctx(repo, { ledger }))).toEqual([]);
  });

  test("network reads through the shell, third-party MCP tools, remote output; local commands are not taint", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "uq-taint-net-"));
    cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
    expect((await detectTaint("Bash", { command: "sudo wget -qO- https://get.example.sh | head" }, ctx(cwd))).map((t) => t.kind)).toEqual(["network"]);
    expect((await detectTaint("Bash", { command: "gh issue view 12" }, ctx(cwd)))[0]).toMatchObject({ kind: "network", id: "gh issue" });
    expect((await detectTaint("Bash", { command: "ssh board 'tail log.txt'" }, ctx(cwd)))[0]).toMatchObject({ kind: "remote-output" });
    expect((await detectTaint("mcp__gmail__read_message", { id: "1" }, ctx(cwd)))[0]).toMatchObject({ kind: "third-party-tool" });
    expect((await detectTaint("mcp__uniqlaw__agent_ask", { to: "x" }, ctx(cwd)))[0]).toMatchObject({ kind: "peer-message" });
    expect(await detectTaint("mcp__mytools__compute", {}, ctx(cwd))).toEqual([]);
    expect(await detectTaint("mcp__mytools__compute", {}, ctx(cwd, { thirdPartyTools: compileToolPatterns(["^mcp__mytools__"]) }))).toHaveLength(1);
    expect(await detectTaint("Bash", { command: "make test && ls" }, ctx(cwd))).toEqual([]);
  });
});

describe("the induced-by-content question", () => {
  const ok = (v: Partial<JudgeVerdict>) => ({ ok: true as const, pSafe: 0.99, latencyMs: 1, ...v });
  test("pInduced at/above inducedAbove, or an \"unclear\" answer, escalates; the note shows both scores", () => {
    expect(decideOutcome({ mode: "enforce", judged: ok({ pInduced: 0.61, inducedLabel: "induced" }), threshold: 0.9, structured: true, inducedAbove: 0.5 }).outcome).toEqual({ action: "escalate", reason: "induced" });
    expect(decideOutcome({ mode: "enforce", judged: ok({ pInduced: 0.3, inducedLabel: "unclear" }), threshold: 0.9, structured: true, inducedAbove: 0.5 }).outcome).toEqual({ action: "escalate", reason: "induced" });
    expect(decideOutcome({ mode: "enforce", judged: ok({ pInduced: 0.2, inducedLabel: "task" }), threshold: 0.9, structured: true, inducedAbove: 0.5 }).outcome).toEqual({ action: "allow" });
    expect(decideOutcome({ mode: "enforce", judged: ok({ pInduced: 0.4 }), threshold: 0.9, structured: true, inducedAbove: 0.3 }).outcome.action).toBe("escalate");
    expect(judgeNote("Jev", ok({ pSafe: 0.93, pInduced: 0.61 }), 0.9)).toBe("🤖".slice(0, 0) + "Jev: 0.93 safe · induced 0.61 (needs 0.90)");
  });

  test("runtime: a judge answering induced 0.61 escalates even at P(safe) 0.99, and the audit records both scores", async () => {
    const r = setup((_i, s) => s.emit({ type: "permission_request", id: "p1", tool: "Bash", input: { command: "ls" }, title: "t" }),
      { verdict: { pSafe: 0.99, pInduced: 0.61, inducedLabel: "induced" } });
    r.platform.choiceAnswer = 0;
    await r.mgr.handleInbound(inbound("list files"));
    await until(() => r.platform.choices.length === 1);
    expect(r.platform.choices[0]!.body!.split("\n")[0]).toBe("🤖 Jev: 0.99 safe · induced 0.61 (needs 0.90)");
    await until(() => r.audit().length >= 1);
    expect(r.audit()[0]).toMatchObject({ outcome: "escalate", reason: "induced", pSafe: 0.99, pInduced: 0.61, inducedLabel: "induced" });
  });
});
