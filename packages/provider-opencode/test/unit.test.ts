import { describe, expect, test } from "bun:test";
import { DEFAULT_PERMISSIONS, silentLogger, type AgentEvent } from "@uniqlaw/core";
import { OpencodeSession, errorCode, parseModel, permissionRules, serveEnv } from "../src/index.ts";
import type { OpencodeServer, RawEvent } from "../src/server.ts";

class FakeServer {
  calls: { method: string; path: string; body?: unknown }[] = [];
  private l?: (e: RawEvent) => void;
  on(fn: (e: RawEvent) => void) { this.l = fn; return () => {}; }
  fire(type: string, properties: unknown) { this.l!({ type, properties }); }
  async api(method: string, path: string, body?: unknown) { this.calls.push({ method, path, body }); return null; }
  async stop() {}
  alive() { return true; }
}

function mk() {
  const srv = new FakeServer();
  const s = new OpencodeSession(srv as unknown as OpencodeServer, silentLogger, { model: "opencode/m1", system: "SYS" });
  s.id = "ses_1";
  const evs: AgentEvent[] = [];
  void (async () => { for await (const e of s.events) evs.push(e); })();
  return { srv, s, evs };
}
const tick = () => Bun.sleep(5);
const ses = (o: object) => ({ sessionID: "ses_1", ...o });

describe("mapping", () => {
  test("permission rules per level, allow/deny lists, bus tools always allowed", () => {
    const m = permissionRules({ ...DEFAULT_PERMISSIONS, allowTools: ["Read"], denyTools: ["WebFetch"] });
    expect(m).toContainEqual({ permission: "bash", pattern: "*", action: "ask" });
    expect(m.at(-3)).toEqual({ permission: "read", pattern: "*", action: "allow" });
    expect(m.at(-2)).toEqual({ permission: "webfetch", pattern: "*", action: "deny" });
    expect(m.at(-1)).toEqual({ permission: "uniqlaw_*", pattern: "*", action: "allow" });
    expect(permissionRules({ ...DEFAULT_PERMISSIONS, level: "locked" })).toContainEqual({ permission: "bash", pattern: "*", action: "deny" });
    expect(permissionRules({ ...DEFAULT_PERMISSIONS, level: "unrestricted", approval: { mode: "auto-allow", timeoutSec: 1 } })[0])
      .toEqual({ permission: "*", pattern: "*", action: "allow" });
  });
  test("models and error codes", () => {
    expect(parseModel("opencode/nemotron")).toEqual({ providerID: "opencode", modelID: "nemotron" });
    expect(parseModel("x")).toEqual({ providerID: "opencode", modelID: "x" });
    expect(errorCode({ name: "APIError", data: { statusCode: 429, message: "slow down" } })).toBe("rate_limit");
    expect(errorCode({ name: "ProviderAuthError", data: { message: "nope" } })).toBe("auth");
    expect(errorCode({ name: "APIError", data: { message: "Insufficient credits" } })).toBe("usage_limit");
  });
  test("serve env is isolated: user config/data hidden, credential env applied, daemon env not inherited", () => {
    process.env.SOME_DAEMON_SECRET = "x";
    const spec = { sessionId: "s", cwd: "/p", instanceId: "i", env: { FOO: "1" }, systemPrompt: { fragments: [] },
      profile: { name: "p", provider: "opencode", permissions: DEFAULT_PERMISSIONS, options: {} } };
    const env = serveEnv(spec, { kind: "openai-api-key", key: "sk-1" }, { stateDir: "/st", userConfig: false, userData: false }, { a: 1 });
    expect(env.XDG_CONFIG_HOME).toStartWith("/st/opencode/");
    expect(env.XDG_DATA_HOME).toStartWith("/st/opencode/");
    expect(env.OPENAI_API_KEY).toBe("sk-1");
    expect(env.FOO).toBe("1");
    expect(env.SOME_DAEMON_SECRET).toBeUndefined();
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT!)).toEqual({ a: 1 });
    const user = serveEnv(spec, undefined, { stateDir: "/st", userConfig: true, userData: true }, {});
    expect(user.XDG_CONFIG_HOME).toBeUndefined();
    expect(user.XDG_DATA_HOME).toBeUndefined();
  });
});

describe("turn tracking", () => {
  test("stale idle before busy is ignored; first idle after busy ends the turn; duplicate idle dropped", async () => {
    const { srv, s, evs } = mk();
    await s.send({ text: "hi", attachments: [] });
    expect(srv.calls[0]).toMatchObject({ method: "POST", path: "/session/ses_1/prompt_async", body: { model: { providerID: "opencode", modelID: "m1" }, system: "SYS" } });
    srv.fire("session.idle", ses({}));            // stale (from before our prompt)
    srv.fire("session.status", ses({ status: { type: "busy" } }));
    srv.fire("message.updated", { info: { id: "m1", sessionID: "ses_1", role: "assistant", time: { created: Date.now() }, tokens: { input: 5, output: 2 }, cost: 0 } });
    srv.fire("message.part.updated", { part: { id: "p1", sessionID: "ses_1", messageID: "m1", type: "text", text: "" } });
    srv.fire("message.part.delta", ses({ partID: "p1", delta: "PO" }));
    srv.fire("message.part.updated", { part: { id: "p1", sessionID: "ses_1", messageID: "m1", type: "text", text: "PONG", time: { end: 1 } } });
    srv.fire("session.idle", ses({}));
    srv.fire("session.idle", ses({}));            // duplicate
    await tick();
    expect(evs.map((e) => e.type)).toEqual(["turn_start", "text", "text", "turn_end"]);
    expect(evs[3]).toMatchObject({ reason: "done", usage: { inputTokens: 5, outputTokens: 2 } });
  });
  test("abort → interrupted; an old error re-pushed in the next turn is ignored", async () => {
    const { srv, s, evs } = mk();
    await s.send({ text: "long", attachments: [] });
    srv.fire("session.status", ses({ status: { type: "busy" } }));
    await s.interrupt();
    srv.fire("message.updated", { info: { id: "m1", sessionID: "ses_1", role: "assistant", time: { created: Date.now() }, error: { name: "MessageAbortedError" } } });
    srv.fire("session.idle", ses({}));
    await tick();
    expect(evs.at(-1)).toMatchObject({ type: "turn_end", reason: "interrupted" });
    srv.fire("session.status", ses({ status: { type: "busy" } })); // late busy of the aborted run
    await tick();
    expect(evs.filter((e) => e.type === "turn_start")).toHaveLength(1);
    await Bun.sleep(1100);
    await s.send({ text: "next", attachments: [] });
    srv.fire("session.status", ses({ status: { type: "busy" } }));
    srv.fire("message.updated", { info: { id: "m1", sessionID: "ses_1", role: "assistant", time: { created: Date.now() - 60_000 }, error: { name: "MessageAbortedError" } } });
    srv.fire("session.idle", ses({}));
    await tick();
    expect(evs.at(-1)).toMatchObject({ type: "turn_end", reason: "done" });
  });
  test("error before busy ends the turn with a typed code", async () => {
    const { srv, s, evs } = mk();
    await s.send({ text: "x", attachments: [] });
    srv.fire("session.error", ses({ error: { name: "APIError", data: { statusCode: 429, message: "rate limited" } } }));
    srv.fire("session.idle", ses({}));
    await tick();
    expect(evs.at(-1)).toMatchObject({ type: "turn_end", reason: "error", error: "rate_limit" });
  });
  test("steer while busy, tools, permissions (deduped across v1/v2 events), questions, slash commands", async () => {
    const { srv, s, evs } = mk();
    await s.send({ text: "go", attachments: [{ kind: "image", path: "/tmp/a.png", mime: "image/png" }] });
    expect((srv.calls[0]!.body as { parts: unknown[] }).parts[1]).toEqual({ type: "file", mime: "image/png", url: "file:///tmp/a.png", filename: "a.png" });
    srv.fire("session.status", ses({ status: { type: "busy" } }));
    await s.steer!({ text: "also", attachments: [] });
    expect(srv.calls.at(-1)!.path).toBe("/session/ses_1/prompt_async");
    srv.fire("message.part.updated", { part: { id: "t1", callID: "c1", sessionID: "ses_1", messageID: "m1", type: "tool", tool: "bash", state: { status: "pending", input: {} } } });
    srv.fire("message.part.updated", { part: { id: "t1", callID: "c1", sessionID: "ses_1", messageID: "m1", type: "tool", tool: "bash", state: { status: "running", input: { command: "ls" } } } });
    srv.fire("permission.asked", ses({ id: "per_1", permission: "bash", patterns: ["ls"] }));
    srv.fire("permission.v2.asked", ses({ id: "per_1", action: "bash", resources: ["ls"] }));
    srv.fire("message.part.updated", { part: { id: "t1", callID: "c1", sessionID: "ses_1", messageID: "m1", type: "tool", tool: "bash", state: { status: "completed", input: { command: "ls" }, output: "a" } } });
    srv.fire("question.asked", ses({ id: "que_1", questions: [{ question: "Which?", options: [{ label: "A" }, { label: "B" }] }] }));
    await tick();
    expect(evs.filter((e) => e.type === "permission_request")).toHaveLength(1);
    expect(evs.find((e) => e.type === "tool_start")).toMatchObject({ name: "bash", input: { command: "ls" } });
    expect(evs.find((e) => e.type === "input_request")).toMatchObject({ id: "que_1", title: "Which? (A / B)" });
    await s.respondPermission!("per_1", { behavior: "allow", scope: "session" });
    await s.respondInput!("que_1", "A");
    expect(srv.calls.slice(-2)).toEqual([
      { method: "POST", path: "/permission/per_1/reply", body: { reply: "always" } },
      { method: "POST", path: "/question/que_1/reply", body: { answers: [["A"]] } },
    ]);
    srv.fire("session.idle", ses({}));
    await s.send({ text: "/review src", attachments: [], slashCommand: true });
    expect(srv.calls.at(-1)).toMatchObject({ path: "/session/ses_1/command", body: { command: "review", arguments: "src" } });
  });
  test("busy while idle = unsolicited turn; events of other sessions are ignored", async () => {
    const { srv, evs } = mk();
    srv.fire("session.status", { sessionID: "other", status: { type: "busy" } });
    srv.fire("session.status", ses({ status: { type: "busy" } }));
    await tick();
    expect(evs.map((e) => e.type)).toEqual(["unsolicited_turn", "turn_start"]);
  });
});
