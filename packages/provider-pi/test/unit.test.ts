import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_PERMISSIONS, silentLogger, type AgentEvent, type AgentSession, type Credential, type PermissionPolicy, type SessionSpec,
} from "@uniqlaw/core";
import { startTestGateway } from "@uniqlaw/testkit";
import { PiProvider, classifyError, decide, excludedTools } from "../src/index.ts";

const ROOT = join(import.meta.dir, "..", ".work", "unit");
const CWD = join(ROOT, "cwd");
const opened: AgentSession[] = [];
// Default = inherit the user's pi agent dir (PI_CODING_AGENT_DIR or ~/.pi/agent): point it at a
// throwaway dir so tests never touch the real ~/.pi/agent.
const USER_AGENT_DIR = join(ROOT, "user-pi-agent");
process.env.PI_CODING_AGENT_DIR = USER_AGENT_DIR;
afterEach(async () => { for (const s of opened.splice(0)) await s.close(); process.env.PI_CODING_AGENT_DIR = USER_AGENT_DIR; });
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(CWD, { recursive: true });

const policy = (p: Partial<PermissionPolicy> = {}): PermissionPolicy => ({ ...DEFAULT_PERMISSIONS, ...p, approval: { ...DEFAULT_PERMISSIONS.approval, ...p.approval } });

function harness(steps: FauxResponseFactory | FauxResponseFactory[]) {
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-a" }, { id: "faux-b" }], tokensPerSecond: 2000 });
  const list = Array.isArray(steps) ? steps : [steps];
  faux.setResponses(list);
  const runtimes: ModelRuntime[] = [];
  const provider = new PiProvider({ allowModelNetwork: false }, {
    log: silentLogger, stateDir: join(ROOT, "state"),
    configureRuntime: (rt) => { rt.registerNativeProvider(faux.provider); runtimes.push(rt); },
  });
  const open = async (extra: Partial<SessionSpec> & { permissions?: Partial<PermissionPolicy>; options?: Record<string, unknown>; credential?: Credential; model?: string } = {}) => {
    const { permissions, options, credential, model, ...rest } = extra;
    const s = await provider.open({
      sessionId: `s-${Math.random().toString(36).slice(2, 8)}`, cwd: CWD, instanceId: "unit", env: {}, systemPrompt: { fragments: [{ id: "f", text: "FRAGMENT_7731" }] },
      profile: { name: "p", provider: "pi", model: model ?? "faux/faux-a", permissions: policy(permissions), options: options ?? {}, credentialResolved: credential },
      ...rest,
    });
    opened.push(s);
    const events: AgentEvent[] = [];
    void (async () => { for await (const e of s.events) events.push(e); })();
    const until = async (pred: (e: AgentEvent) => boolean, ms = 5000) => {
      const end = Date.now() + ms;
      for (;;) { const hit = events.find(pred); if (hit) return hit; if (Date.now() > end) throw new Error(`timeout; got ${events.map((e) => e.type)}`); await Bun.sleep(10); }
    };
    return { s, events, until };
  };
  return { faux, provider, open, runtimes };
}

const userText = (ctx: Parameters<FauxResponseFactory>[0]) => JSON.stringify(ctx.messages);
const lastToolResult = (ctx: Parameters<FauxResponseFactory>[0]) => [...(ctx.messages as unknown as { role: string; isError?: boolean; content: { text?: string }[] }[])].reverse().find((m) => m.role === "toolResult");

describe("policy", () => {
  test("decide", () => {
    expect(decide(policy(), "bash", false)).toEqual({ action: "ask" });
    expect(decide(policy(), "read", false)).toEqual({ action: "allow" });
    expect(decide(policy({ allowTools: ["Bash"] }), "bash", false)).toEqual({ action: "allow" });
    expect(decide(policy({ denyTools: ["mcp__evil__*"] }), "mcp__evil__x", false).action).toBe("deny");
    expect(decide(policy({ level: "locked" }), "write", false).action).toBe("deny");
    expect(decide(policy({ approval: { mode: "auto-allow", timeoutSec: 1 } }), "bash", false)).toEqual({ action: "allow" });
    expect(decide(policy({ approval: { mode: "auto-deny", timeoutSec: 1 } }), "bash", false).action).toBe("deny");
    expect(decide(policy({ approval: { mode: "auto-deny", timeoutSec: 1 } }), "mcp__uniqlaw__notify", true)).toEqual({ action: "allow" });
  });
  test("excludedTools", () => {
    expect(excludedTools(policy({ level: "locked" })).sort()).toEqual(["bash", "edit", "write"]);
    expect(excludedTools(policy({ level: "strict", denyTools: ["Write", "mcp__x__*"] })).sort()).toEqual(["bash", "write"]);
    expect(excludedTools(policy())).toEqual([]);
  });
  test("classifyError", () => {
    expect(classifyError("429 Too Many Requests")).toBe("rate_limit");
    expect(classifyError("Resource exhausted: quota")).toBe("rate_limit");
    expect(classifyError("401 Unauthorized: invalid api key")).toBe("auth");
    expect(classifyError("boom")).toBe("boom");
  });
});

describe("PiProvider (faux model, real harness)", () => {
  test("system prompt fragments, token streaming, usage, inherits the user's agent dir", async () => {
    let sys = "";
    const { open } = harness((ctx) => { sys = userText(ctx); return fauxAssistantMessage("hello there"); });
    const { s, events, until } = await open();
    await s.send({ text: "hi", attachments: [] });
    const end = await until((e) => e.type === "turn_end");
    expect(end).toMatchObject({ reason: "done" });
    expect(sys).toContain("FRAGMENT_7731");
    expect(events.filter((e) => e.type === "text" && e.delta).length).toBeGreaterThan(0);
    expect(events.some((e) => e.type === "text" && e.final === "hello there")).toBe(true);
    expect((end as Extract<AgentEvent, { type: "turn_end" }>).usage?.inputTokens).toBeGreaterThan(0);
    expect(process.env.PI_CODING_AGENT_DIR).toBe(USER_AGENT_DIR);
  });

  test("isolate:true uses a UniQlaw-private agent dir; mixing dirs in one daemon is refused", async () => {
    const { open } = harness(() => fauxAssistantMessage("ok"));
    await open({ options: { isolate: true } });
    expect(process.env.PI_CODING_AGENT_DIR).toBe(join(ROOT, "state", "pi-agent", "unit"));
    await expect(open()).rejects.toThrow(/share one agent dir/);
  });

  test("permission: ask → allow runs the tool; deny blocks it with the operator's reason", async () => {
    const f1 = join(CWD, "allowed.txt"), f2 = join(CWD, "denied.txt");
    const script = (file: string): FauxResponseFactory[] => [
      () => fauxAssistantMessage([fauxToolCall("bash", { command: `touch ${file}` })], { stopReason: "toolUse" }),
      (ctx) => fauxAssistantMessage(lastToolResult(ctx)?.isError ? `BLOCKED ${lastToolResult(ctx)!.content.map((c) => c.text).join("")}` : "DONE"),
    ];
    const { open, faux } = harness(script(f1));
    const a = await open();
    await a.s.send({ text: "go", attachments: [] });
    const p = await a.until((e) => e.type === "permission_request");
    expect(p).toMatchObject({ tool: "bash", title: `bash: touch ${f1}` });
    await a.s.respondPermission!((p as { id: string }).id, { behavior: "allow" });
    await a.until((e) => e.type === "turn_end");
    expect(existsSync(f1)).toBe(true);

    faux.setResponses(script(f2));
    const b = await open();
    await b.s.send({ text: "go", attachments: [] });
    const p2 = await b.until((e) => e.type === "permission_request");
    await b.s.respondPermission!((p2 as { id: string }).id, { behavior: "deny", message: "nope from operator" });
    await b.until((e) => e.type === "turn_end");
    expect(existsSync(f2)).toBe(false);
    expect(b.events.some((e) => e.type === "text" && e.final?.includes("BLOCKED") && e.final.includes("nope from operator"))).toBe(true);
  });

  test("timeoutSec 0: the permission waits for the operator indefinitely", async () => {
    const steps: FauxResponseFactory[] = [
      () => fauxAssistantMessage([fauxToolCall("bash", { command: "echo x" })], { stopReason: "toolUse" }),
      (ctx) => fauxAssistantMessage(lastToolResult(ctx)?.isError ? "BLOCKED" : "RAN"),
    ];
    const { open } = harness(steps);
    const a = await open({ permissions: { approval: { mode: "ask-operator", timeoutSec: 0 } } });
    await a.s.send({ text: "go", attachments: [] });
    const p = await a.until((e) => e.type === "permission_request");
    await Bun.sleep(150);
    expect(a.events.some((e) => e.type === "turn_end" || (e.type === "text" && e.final === "BLOCKED"))).toBe(false);
    await a.s.respondPermission!((p as { id: string }).id, { behavior: "allow" });
    await a.until((e) => e.type === "turn_end");
    expect(a.events.some((e) => e.type === "text" && e.final === "RAN")).toBe(true);
  });

  test("permission times out to deny; auto-deny never asks; bus tools are not gated", async () => {
    const steps: FauxResponseFactory[] = [
      () => fauxAssistantMessage([fauxToolCall("bash", { command: "echo x" })], { stopReason: "toolUse" }),
      (ctx) => fauxAssistantMessage(lastToolResult(ctx)?.isError ? "BLOCKED" : "RAN"),
    ];
    const { open, faux } = harness(steps);
    const a = await open({ permissions: { approval: { mode: "ask-operator", timeoutSec: 0.2 } } });
    await a.s.send({ text: "go", attachments: [] });
    await a.until((e) => e.type === "turn_end");
    expect(a.events.some((e) => e.type === "text" && e.final === "BLOCKED")).toBe(true);

    faux.setResponses(steps);
    const b = await open({ permissions: { approval: { mode: "auto-deny", timeoutSec: 5 } } });
    await b.s.send({ text: "go", attachments: [] });
    await b.until((e) => e.type === "turn_end");
    expect(b.events.some((e) => e.type === "permission_request")).toBe(false);
    expect(b.events.some((e) => e.type === "text" && e.final === "BLOCKED")).toBe(true);

    let called = 0;
    faux.setResponses([
      () => fauxAssistantMessage([fauxToolCall("agents_list", {})], { stopReason: "toolUse" }),
      (ctx) => fauxAssistantMessage(lastToolResult(ctx)!.content.map((c) => c.text).join("")),
    ]);
    const c = await open({ permissions: { approval: { mode: "auto-deny", timeoutSec: 5 } },
      nativeTools: [{ name: "agents_list", description: "list", inputSchema: { type: "object", properties: {} }, handler: async () => { called++; return { text: "[global]" }; } }] });
    await c.s.send({ text: "list", attachments: [] });
    await c.until((e) => e.type === "turn_end");
    expect(called).toBe(1);
    expect(c.events.some((e) => e.type === "text" && e.final === "[global]")).toBe(true);
  });

  test("skills: user-level skills load by default and can be turned off", async () => {
    let sys = "";
    const { open, faux } = harness((ctx) => { sys = userText(ctx); return fauxAssistantMessage("ok"); });
    const skillDir = join(ROOT, "skills", "uq-marker-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "---\nname: uq-marker-skill\ndescription: marker skill for tests\n---\nbody\n");
    const a = await open({ options: { skillPaths: [join(ROOT, "skills")] } });
    await a.s.send({ text: "x", attachments: [] });
    await a.until((e) => e.type === "turn_end");
    expect(sys).toContain("uq-marker-skill");
    faux.setResponses([(ctx) => { sys = userText(ctx); return fauxAssistantMessage("ok"); }]);
    const b = await open({ options: { skills: false, skillPaths: [join(ROOT, "skills")] } });
    await b.s.send({ text: "x", attachments: [] });
    await b.until((e) => e.type === "turn_end");
    expect(sys).not.toContain("<available_skills>");
  });

  test("locked level removes write tools from the session", async () => {
    let tools = "";
    const { open } = harness((ctx) => { tools = userText(ctx); return fauxAssistantMessage("ok"); });
    const { s, until } = await open({ permissions: { level: "locked" } });
    await s.send({ text: "x", attachments: [] });
    await until((e) => e.type === "turn_end");
    expect(tools).toContain("- read:");
    expect(tools).not.toContain("- bash:");
    expect(tools).not.toContain("- write:");
  });

  test("project trust: the agent project's .pi/ resources load by default; trustProject:false skips them", async () => {
    mkdirSync(join(CWD, ".pi"), { recursive: true });
    writeFileSync(join(CWD, ".pi", "APPEND_SYSTEM.md"), "TRUST_MARKER_4242\n");
    try {
      let sys = "";
      const { open, faux } = harness((ctx) => { sys = userText(ctx); return fauxAssistantMessage("ok"); });
      const a = await open({ options: { trustProject: false } });
      await a.s.send({ text: "x", attachments: [] });
      await a.until((e) => e.type === "turn_end");
      expect(sys).not.toContain("TRUST_MARKER_4242");
      faux.setResponses([(ctx) => { sys = userText(ctx); return fauxAssistantMessage("ok"); }]);
      const b = await open();
      await b.s.send({ text: "x", attachments: [] });
      await b.until((e) => e.type === "turn_end");
      expect(sys).toContain("TRUST_MARKER_4242");
    } finally { rmSync(join(CWD, ".pi"), { recursive: true, force: true }); }
  });

  test("resume by providerSessionId; unknown id starts fresh with a non-fatal error", async () => {
    const { open, faux } = harness([() => fauxAssistantMessage("NOTED")]);
    const a = await open();
    const sid = (await a.until((e) => e.type === "session")) as { providerSessionId: string };
    await a.s.send({ text: "remember PAPAYA-9", attachments: [] });
    await a.until((e) => e.type === "turn_end");
    await a.s.close();
    faux.setResponses([(ctx) => fauxAssistantMessage(userText(ctx).includes("PAPAYA-9") ? "PAPAYA-9" : "LOST")]);
    const b = await open({ providerSessionId: sid.providerSessionId });
    expect(((await b.until((e) => e.type === "session")) as { providerSessionId: string }).providerSessionId).toBe(sid.providerSessionId);
    await b.s.send({ text: "what?", attachments: [] });
    await b.until((e) => e.type === "turn_end");
    expect(b.events.some((e) => e.type === "text" && e.final === "PAPAYA-9")).toBe(true);

    faux.setResponses([() => fauxAssistantMessage("x")]);
    const c = await open({ providerSessionId: "does-not-exist" });
    const err = await c.until((e) => e.type === "error");
    expect(err).toMatchObject({ fatal: false });
  });

  test("interrupt, steer mid-turn, live setModel", async () => {
    const { open, faux } = harness([() => fauxAssistantMessage("word ".repeat(5000)), () => fauxAssistantMessage("AFTER")]);
    const a = await open();
    await a.s.send({ text: "long", attachments: [] });
    await a.until((e) => e.type === "text" && !!e.delta);
    await a.s.interrupt!();
    expect(await a.until((e) => e.type === "turn_end")).toMatchObject({ reason: "interrupted" });

    let sawSteer = false;
    faux.setResponses([
      () => fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 0.3" })], { stopReason: "toolUse" }),
      (ctx) => { sawSteer = userText(ctx).includes("STEER-NOTE"); return fauxAssistantMessage("FIN"); },
    ]);
    const b = await open({ permissions: { allowTools: ["bash"] } });
    await b.s.send({ text: "work", attachments: [] });
    await b.until((e) => e.type === "tool_start");
    await b.s.steer!({ text: "STEER-NOTE", attachments: [] });
    await b.until((e) => e.type === "turn_end");
    expect(sawSteer).toBe(true);
    expect(b.events.filter((e) => e.type === "turn_end")).toHaveLength(1);

    faux.setResponses([(_c, _o, _s, m) => fauxAssistantMessage(`model=${m.id}`)]);
    await b.s.setModel!("faux/faux-b");
    expect(b.events.some((e) => e.type === "model" && e.model === "faux/faux-b")).toBe(true);
    const n = b.events.length;
    await b.s.send({ text: "which?", attachments: [] });
    await b.until((e) => e.type === "text" && e.final === "model=faux-b");
    expect(b.events.length).toBeGreaterThan(n);
  });

  test("provider errors map to typed turn_end.error", async () => {
    const { open } = harness(() => fauxAssistantMessage("", { stopReason: "error", errorMessage: "401 Unauthorized: invalid api key" }));
    const { s, until } = await open();
    await s.send({ text: "x", attachments: [] });
    expect(await until((e) => e.type === "turn_end", 30_000)).toMatchObject({ reason: "error", error: "auth" });
  });

  test("MCP gateway per session (token identity) and attachments", async () => {
    const gw = startTestGateway();
    try {
      let seen = "";
      const { open } = harness([
        () => fauxAssistantMessage([fauxToolCall("mcp__uniqlaw__uniqlaw_ping", { note: "n" })], { stopReason: "toolUse" }),
        (ctx) => { seen = userText(ctx); return fauxAssistantMessage(lastToolResult(ctx)!.content.map((c) => c.text).join("")); },
      ]);
      const img = join(CWD, "dot.png");
      writeFileSync(img, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
      const { s, until, events } = await open({ mcp: { url: gw.url("tok-unit"), token: "tok-unit", toolNames: ["uniqlaw_ping"] } });
      await s.send({ text: "ping", attachments: [{ kind: "image", path: img }, { kind: "voice", path: "/tmp/v.ogg", durationSec: 3 }] });
      await until((e) => e.type === "turn_end", 15_000);
      expect(gw.calls.map((c) => c.token)).toEqual(["tok-unit"]);
      expect(events.some((e) => e.type === "text" && e.final?.includes("caller=tok-unit"))).toBe(true);
      expect(seen).toContain("[Attached voice · 3s: /tmp/v.ogg]");
      expect(seen).toContain("\"type\":\"image\"");
    } finally { gw.stop(); }
  });
});

describe("credentials → pi runtime", () => {
  test("aws credential is scoped into the runtime's store (not process.env)", async () => {
    const h = harness(() => fauxAssistantMessage("x"));
    await h.open({ model: "amazon.nova-lite-v1:0", credential: { kind: "aws", region: "eu-central-1", profile: "uq-test" } });
    const auth = await h.runtimes.at(-1)!.getAuth("amazon-bedrock");
    // pi-ai takes only AWS_PROFILE from the stored credential; region/keys go in the per-session
    // request env (see test/conformance.test.ts for the SigV4 request on the wire).
    expect(auth?.env).toMatchObject({ AWS_PROFILE: "uq-test" });
    expect(process.env.AWS_PROFILE).not.toBe("uq-test");
    expect(process.env.AWS_REGION).not.toBe("eu-central-1");
  });

  test("gcp credential → google-vertex with project/location", async () => {
    const h = harness(() => fauxAssistantMessage("x"));
    const sa = join(ROOT, "sa.json");
    writeFileSync(sa, JSON.stringify({ type: "service_account", project_id: "proj-x" }));
    await h.open({ model: "gemini-2.5-flash", credential: { kind: "gcp", project: "proj-x", location: "us-central1", serviceAccountFile: sa } });
    const auth = await h.runtimes.at(-1)!.getAuth("google-vertex");
    expect(auth?.env).toMatchObject({ GOOGLE_CLOUD_PROJECT: "proj-x", GOOGLE_CLOUD_LOCATION: "us-central1", GOOGLE_APPLICATION_CREDENTIALS: sa });
  });

  test("api keys stay per session; openai-compatible registers a custom provider", async () => {
    const env = { UQ_TEST_OPENAI: "sk-unit-a" };
    Object.assign(process.env, env);
    try {
      const h = harness(() => fauxAssistantMessage("x"));
      await h.open({ model: "gpt-4", credential: { kind: "openai-api-key", key: { env: "UQ_TEST_OPENAI" } } });
      expect((await h.runtimes.at(-1)!.getAuth("openai"))?.auth.apiKey).toBe("sk-unit-a");
      await h.open({ model: "llama3", credential: { kind: "openai-compatible", baseUrl: "http://127.0.0.1:9/v1" } });
      expect(h.runtimes.at(-1)!.getModel("uniqlaw-compat", "llama3")).toBeDefined();
      await expect(h.open({ model: "nope-model", credential: { kind: "anthropic-api-key", key: { env: "UQ_TEST_OPENAI" } } })).rejects.toThrow(/unknown model "anthropic\/nope-model"/);
      await expect(h.open({ model: "gpt-4" })).rejects.toThrow(/provider prefix/);
    } finally { delete process.env.UQ_TEST_OPENAI; }
  });
});
