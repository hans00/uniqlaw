import { expect, test } from "bun:test";
import { SdkMapper, classifyError } from "../src/mapper.ts";

test("prompted turn: deltas, finals, tools, usage", () => {
  const m = new SdkMapper();
  expect(m.beginTurn()).toEqual([{ type: "turn_start", turnId: "t1" }]);
  const evs = [
    { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text" } } },
    { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "PO" } } },
    { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "NG" } } },
    { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
    { type: "assistant", message: { model: "claude-haiku", content: [{ type: "text", text: "PONG" }] } },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls" } }] } },
    { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "a\nb", is_error: false }] } },
    { type: "result", subtype: "success", is_error: false, usage: { input_tokens: 10, output_tokens: 2 }, total_cost_usd: 0.001 },
  ].flatMap((x) => m.map(x));
  expect(evs).toEqual([
    { type: "text", segmentId: "s1", delta: "PO" },
    { type: "text", segmentId: "s1", delta: "NG" },
    { type: "text", segmentId: "s1", final: "PONG" },
    { type: "tool_start", id: "tu1", name: "Bash", input: { command: "ls" } },
    { type: "tool_end", id: "tu1", ok: true, summary: "a\nb" },
    { type: "turn_end", turnId: "t1", reason: "done", usage: { inputTokens: 10, outputTokens: 2, costUsd: 0.001 } },
  ]);
  expect(m.inTurn).toBe(false);
});

test("interrupt and error results", () => {
  const m = new SdkMapper();
  m.beginTurn();
  expect(m.map({ type: "result", subtype: "error_during_execution", is_error: true, terminal_reason: "aborted_streaming" })[0])
    .toMatchObject({ type: "turn_end", reason: "interrupted" });
  m.beginTurn();
  expect(m.map({ type: "result", subtype: "success", is_error: true, result: "API Error: 429 rate_limit_error" })[0])
    .toMatchObject({ type: "turn_end", reason: "error", error: "rate_limit" });
  m.beginTurn();
  m.map({ type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "five_hour" } });
  expect(m.map({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["Claude AI usage limit reached"] })[0])
    .toMatchObject({ error: "usage_limit" });
});

test("output without a prompt is an unsolicited (background) turn", () => {
  const m = new SdkMapper();
  const evs = m.map({ type: "assistant", message: { content: [{ type: "text", text: "wakeup" }] } });
  expect(evs.map((e) => e.type)).toEqual(["unsolicited_turn", "turn_start", "text"]);
  expect(evs[0]).toEqual({ type: "unsolicited_turn", source: "background" });
});

test("native peer message is flagged as external", () => {
  const m = new SdkMapper();
  const evs = m.map({ type: "user", message: { role: "user", content: '<cross-session-message from="uds:/x" from-name="peer">hi</cross-session-message>' } });
  expect(evs[0]).toEqual({ type: "unsolicited_turn", source: "external" });
  expect(m.inTurn).toBe(true);
  // replays of our own prompts are ignored
  expect(new SdkMapper().map({ type: "user", isReplay: true, message: { content: "<cross-session-message from=x>" } })).toEqual([]);
});

test("init only re-emits session when the id changes", () => {
  const m = new SdkMapper();
  m.sessionId = "abc";
  expect(m.map({ type: "system", subtype: "init", session_id: "abc", model: "x" })).toEqual([]);
  expect(m.map({ type: "system", subtype: "init", session_id: "def" })).toEqual([{ type: "session", providerSessionId: "def" }]);
});

test("classifyError", () => {
  expect(classifyError("Invalid API key · Please run /login")).toBe("auth");
  expect(classifyError("Overloaded")).toBe("rate_limit");
  expect(classifyError("something odd")).toBe("something odd");
});
