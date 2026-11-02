import { describe, expect, test } from "bun:test";
import { silentLogger, type AgentEvent } from "@uniqlaw/core";
import { AcpSession, capabilitiesFor, elicitationContent, errorCode, pickOption, stopReasonToEnd } from "../src/index.ts";
import type { AcpAgent } from "../src/agent.ts";

class FakeAgent {
  requests: { method: string; params: any }[] = [];
  notes: { method: string; params: any }[] = [];
  resolvers: ((r: unknown) => void)[] = [];
  caps = { promptCapabilities: { image: true } };
  request(method: string, params: any) {
    this.requests.push({ method, params });
    if (method === "session/prompt") return new Promise((r) => this.resolvers.push(r));
    if (method === "session/set_config_option") return Promise.resolve({});
    return Promise.resolve({});
  }
  notify(method: string, params: any) { this.notes.push({ method, params }); }
  alive() { return true; }
}

function mk(steer = true) {
  const agent = new FakeAgent();
  const s = new AcpSession(capabilitiesFor({ steer, modelSwitch: "live", shareProcess: false }), agent as unknown as AcpAgent, silentLogger, { onClose: async () => {} });
  s.id = "sess1";
  const evs: AgentEvent[] = [];
  void (async () => { for await (const e of s.events) evs.push(e); })();
  return { agent, s, evs };
}
const tick = () => Bun.sleep(5);

describe("mapping", () => {
  test("permission option picking", () => {
    const opts = [{ optionId: "a1", name: "Allow", kind: "allow_once" }, { optionId: "a2", name: "Always", kind: "allow_always" }, { optionId: "r1", name: "Reject", kind: "reject_once" }];
    expect(pickOption(opts, { behavior: "allow" })).toBe("a1");
    expect(pickOption(opts, { behavior: "allow", scope: "session" })).toBe("a2");
    expect(pickOption(opts, { behavior: "deny" })).toBe("r1");
    expect(pickOption([{ optionId: "x", name: "Nope", kind: "reject_always" }], { behavior: "deny" })).toBe("x");
  });
  test("stop reasons, error codes, elicitation content", () => {
    expect(stopReasonToEnd("cancelled")).toEqual({ reason: "interrupted" });
    expect(stopReasonToEnd("refusal")).toEqual({ reason: "error", error: "refusal" });
    expect(stopReasonToEnd("max_tokens")).toEqual({ reason: "done" });
    expect(errorCode(new Error("429 Too Many Requests"))).toBe("rate_limit");
    expect(elicitationContent({ properties: { code: {} } }, "123")).toEqual({ code: "123" });
    expect(elicitationContent({ properties: { a: {}, b: {} } }, '{"a":1,"b":2}')).toEqual({ a: 1, b: 2 });
  });
  test("capabilities: per-process MCP unless shareProcess", () => {
    expect(capabilitiesFor({ steer: false, modelSwitch: "spawn", shareProcess: false })).toMatchObject({ mcp: "per-process", steer: false, modelSwitch: "spawn" });
    expect(capabilitiesFor({ steer: true, modelSwitch: "live", shareProcess: true }).mcp).toBe("per-session");
  });
});

describe("AcpSession", () => {
  test("prompt → chunks → end_turn: text deltas flushed as final, usage reported", async () => {
    const { agent, s, evs } = mk();
    await s.send({ text: "hi", attachments: [] });
    await tick();
    expect(agent.requests[0]).toMatchObject({ method: "session/prompt", params: { sessionId: "sess1", prompt: [{ type: "text", text: "hi" }] } });
    s.onUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "PO" } });
    s.onUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "NG" } });
    agent.resolvers[0]!({ stopReason: "end_turn", usage: { inputTokens: 3, outputTokens: 1 } });
    await tick();
    expect(evs.map((e) => e.type)).toEqual(["turn_start", "text", "text", "text", "turn_end"]);
    expect(evs[3]).toMatchObject({ final: "PONG" });
    expect(evs[4]).toMatchObject({ reason: "done", usage: { inputTokens: 3, outputTokens: 1 } });
  });
  test("concurrent-prompt steer: one turn ends only after both prompts resolve", async () => {
    const { agent, s, evs } = mk(true);
    await s.send({ text: "first", attachments: [] });
    await tick();
    await s.steer!({ text: "also", attachments: [] });
    await tick();
    expect(agent.requests.filter((r) => r.method === "session/prompt")).toHaveLength(2);
    agent.resolvers[0]!({ stopReason: "end_turn" });
    await tick();
    expect(evs.some((e) => e.type === "turn_end")).toBe(false);
    agent.resolvers[1]!({ stopReason: "end_turn" });
    await tick();
    expect(evs.filter((e) => e.type === "turn_end")).toHaveLength(1);
  });
  test("steer is refused when the agent isn't known to support it", async () => {
    const { s } = mk(false);
    await s.send({ text: "first", attachments: [] });
    await expect(s.steer!({ text: "x", attachments: [] })).rejects.toThrow(/steer/);
  });
  test("permission round-trip; interrupt cancels pending permissions and the turn", async () => {
    const { agent, s, evs } = mk();
    await s.send({ text: "rm", attachments: [] });
    const answer = s.onPermission({ sessionId: "sess1", toolCall: { toolCallId: "tc1", kind: "execute", title: "rm x", rawInput: { command: "rm x" } },
      options: [{ optionId: "ok", name: "Allow", kind: "allow_once" }, { optionId: "no", name: "Reject", kind: "reject_once" }] });
    await tick();
    expect(evs.find((e) => e.type === "permission_request")).toMatchObject({ id: "tc1", tool: "execute", title: "rm x" });
    await s.respondPermission!("tc1", { behavior: "deny" });
    expect(await answer).toEqual({ outcome: { outcome: "selected", optionId: "no" } });
    const pending = s.onPermission({ sessionId: "sess1", toolCall: { toolCallId: "tc2" }, options: [] });
    await s.interrupt!();
    expect(await pending).toEqual({ outcome: { outcome: "cancelled" } });
    expect(agent.notes[0]).toEqual({ method: "session/cancel", params: { sessionId: "sess1" } });
    agent.resolvers[0]!({ stopReason: "cancelled" });
    await tick();
    expect(evs.at(-1)).toMatchObject({ type: "turn_end", reason: "interrupted" });
  });
  test("replayed history (session/load) is never forwarded; updates outside a turn are dropped", async () => {
    const { s, evs } = mk();
    s.replaying = true;
    s.onUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "old history" } });
    s.replaying = false;
    s.onUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "stray" } });
    s.onUpdate({ sessionUpdate: "available_commands_update", availableCommands: [{ name: "review" }] });
    await tick();
    expect(evs).toHaveLength(0);
    expect(s.commands).toEqual([{ name: "review" }]);
  });
  test("tools, model switch via config option, elicitation, system prompt on first prompt, prompt errors", async () => {
    const { agent, s, evs } = mk();
    s.configOptions = [{ id: "model", category: "model", type: "select", currentValue: "p/a", options: [{ value: "p/a" }, { value: "p/b", name: "B" }] }];
    s.pendingSystem = "BE NICE";
    await s.setModel!("b");
    expect(agent.requests.at(-1)).toEqual({ method: "session/set_config_option", params: { sessionId: "sess1", configId: "model", value: "p/b" } });
    await expect(s.setModel!("zzz")).rejects.toThrow(/not offered/);
    await s.send({ text: "go", attachments: [] });
    await tick();
    expect(agent.requests.at(-1)!.params.prompt[0].text).toBe("[Instructions for this session]\nBE NICE\n\n[Message]\ngo");
    s.onUpdate({ sessionUpdate: "tool_call", toolCallId: "t1", kind: "execute", title: "ls", rawInput: { command: "ls" }, status: "pending" });
    s.onUpdate({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", rawOutput: "a b" });
    const el = s.onElicitation({ sessionId: "sess1", mode: "form", message: "Your name?", requestedSchema: { properties: { name: { type: "string" } } } });
    await tick();
    const req = evs.find((e) => e.type === "input_request")!;
    await s.respondInput!((req as { id: string }).id, "Hans");
    expect(await el).toEqual({ action: "accept", content: { name: "Hans" } });
    agent.resolvers[0]!(Promise.reject(new Error("429 rate limit")));
    await tick();
    expect(evs.filter((e) => e.type === "tool_start" || e.type === "tool_end").map((e) => e.type)).toEqual(["tool_start", "tool_end"]);
    expect(evs.at(-1)).toMatchObject({ type: "turn_end", reason: "error", error: "rate_limit" });
    expect(evs.find((e) => e.type === "model")).toMatchObject({ model: "p/b" });
  });
});

describe("opencode log watchdog", () => {
  test("fatal stream errors map to typed codes; title-agent (small) and unrelated lines are ignored", async () => {
    const { opencodeLogError } = await import("../src/index.ts");
    const usage = 'timestamp=x level=ERROR run=1 message="stream error" providerID=opencode modelID=glm session.id=ses_9 small=false agent=build error.error="AI_APICallError: Free usage limit reached"';
    expect(opencodeLogError(usage)).toEqual({ sessionId: "ses_9", code: "usage_limit" });
    expect(opencodeLogError(usage.replace("small=false", "small=true"))).toBeUndefined();
    expect(opencodeLogError('level=INFO message="stream" session.id=ses_9')).toBeUndefined();
    expect(opencodeLogError('level=ERROR message="stream error" session.id=ses_9 small=false error.error="AI_RetryError: Failed after 3 attempts. Last error: overloaded"')).toEqual({ sessionId: "ses_9", code: "rate_limit" });
  });
  test("providerError cancels the stuck prompt and ends the turn with the typed error", async () => {
    const { agent, s, evs } = mk();
    await s.send({ text: "x", attachments: [] });
    await tick();
    await s.providerError("usage_limit");
    expect(agent.notes.at(-1)).toEqual({ method: "session/cancel", params: { sessionId: "sess1" } });
    agent.resolvers[0]!({ stopReason: "cancelled" });
    await tick();
    expect(evs.at(-1)).toMatchObject({ type: "turn_end", reason: "error", error: "usage_limit" });
  });
});
