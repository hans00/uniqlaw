// openai-decision backend against a fake fetch (no network). Shapes from the official Decisions docs
// (developers.openai.com/api/docs/guides/decisions, reference "Create a decision").
import { expect, test } from "bun:test";
import type { JudgeInput } from "@uniqlaw/core";
import { createOpenAIDecisionJudge, OpenAIDecisionJudge, parseDecisionResponse } from "../src/index.ts";

const INPUT: JudgeInput = { tool: "Bash", input: { command: "ls" }, inputTrust: "untrusted", structured: true, cwd: "/w", level: "moderate", sessionKind: "chat", channelPolicy: "unrestricted" };
const KEY = "test-key-not-a-secret";
function fakeFetch(respond: () => Response) {
  const calls: { url: string; init: RequestInit; body: any }[] = [];
  const f = (async (url: string, init: RequestInit) => { calls.push({ url, init, body: JSON.parse(String(init.body)) }); return respond(); }) as unknown as typeof fetch;
  return { f, calls };
}
const answer = (safe: number) => Response.json({ id: "d1", model: "gpt-6-luna", answers: [{ type: "choice", name: "safety", choice: safe >= 0.5 ? "safe" : "unsafe",
  probabilities: [{ value: "safe", probability: safe }, { value: "unsafe", probability: 1 - safe }], confidence: 0.9 }], usage: { input_tokens: 10, output_tokens: 1 } });

test("POST /v1/decisions: gpt-6-luna, request as input_json, one choice question safe|unsafe; pSafe = probability of \"safe\"", async () => {
  const { f, calls } = fakeFetch(() => answer(0.83));
  const j = new OpenAIDecisionJudge({ key: async () => KEY, fetch: f, organization: "org-1", project: "proj-1" });
  expect(await j.judge(INPUT, new AbortController().signal)).toEqual({ pSafe: 0.83, label: "safe", model: "gpt-6-luna" });
  const c = calls[0]!;
  expect(c.url).toBe("https://api.openai.com/v1/decisions");
  const h = c.init.headers as Record<string, string>;
  expect(h.authorization).toBe(`Bearer ${KEY}`);
  expect(h["openai-organization"]).toBe("org-1");
  expect(h["openai-project"]).toBe("proj-1");
  expect(c.body.model).toBe("gpt-6-luna");
  expect(c.body.input[0].role).toBe("user");
  expect(c.body.input[0].content[1]).toEqual({ type: "input_json", data: { request: INPUT } });
  expect(c.body.questions).toHaveLength(2); // safety + induced, one request
  expect(c.body.questions[0]).toMatchObject({ type: "choice", name: "safety" });
  expect(c.body.questions[0].choices.map((x: { value: string }) => x.value)).toEqual(["safe", "unsafe", "uncertain"]);
  expect(JSON.stringify(c.body)).not.toContain(KEY);
});

test("refusals, missing answers and HTTP errors are errors (the request then goes to the operator)", async () => {
  expect(() => parseDecisionResponse({ answers: [{ type: "refusal", name: "safety" }] })).toThrow(/refused/);
  expect(() => parseDecisionResponse({ answers: [] })).toThrow();
  expect(() => parseDecisionResponse({ answers: [{ type: "predicate", name: "safety", probability: 0.9 }] })).toThrow();
  const { f } = fakeFetch(() => new Response('{"error":{"message":"bad key"}}', { status: 401 }));
  expect(await new OpenAIDecisionJudge({ key: async () => KEY, fetch: f }).judge(INPUT, new AbortController().signal).catch((e: Error) => e.message))
    .toBe('OpenAI Decisions HTTP 401: {"error":{"message":"bad key"}}');
});

test("options: credential required, baseUrl/model configurable, unknown keys rejected", async () => {
  expect(() => createOpenAIDecisionJudge({}, async () => KEY)).toThrow(/credential/);
  expect(() => createOpenAIDecisionJudge({ credential: { env: "X" }, nope: 1 }, async () => KEY)).toThrow();
  const j = createOpenAIDecisionJudge({ credential: { env: "X" }, baseUrl: "https://proxy.local/v1/", model: "gpt-6-luna-2026-11" }, async () => KEY);
  const { f, calls } = fakeFetch(() => answer(0.4));
  (j as unknown as { o: { fetch: typeof fetch } }).o.fetch = f;
  expect((await j.judge(INPUT, new AbortController().signal)).pSafe).toBe(0.4);
  expect(calls[0]!.url).toBe("https://proxy.local/v1/decisions");
  expect(calls[0]!.body.model).toBe("gpt-6-luna-2026-11");
  expect(j.name).toBe("Luna");
});

test("pSafe is the \"safe\" entry whatever the order of probabilities", () => {
  expect(parseDecisionResponse({ answers: [{ type: "choice", name: "safety", choice: "unsafe",
    probabilities: [{ value: "unsafe", probability: 0.8 }, { value: "safe", probability: 0.2 }] }] }).pSafe).toBe(0.2);
});

test("an \"uncertain\" answer leaves P(safe) as the safe probability (low), so the request escalates", () => {
  const v = parseDecisionResponse({ answers: [{ type: "choice", name: "safety", choice: "uncertain",
    probabilities: [{ value: "safe", probability: 0.3 }, { value: "unsafe", probability: 0.1 }, { value: "uncertain", probability: 0.6 }] }] });
  expect(v).toMatchObject({ pSafe: 0.3, label: "uncertain" });
});

test("one request carries both questions (safety + induced); pInduced is the \"induced\" probability", async () => {
  const { f, calls } = fakeFetch(() => Response.json({ model: "gpt-6-luna", answers: [
    { type: "choice", name: "safety", choice: "safe", probabilities: [{ value: "safe", probability: 0.93 }, { value: "unsafe", probability: 0.05 }, { value: "uncertain", probability: 0.02 }], confidence: 0.9 },
    { type: "choice", name: "induced", choice: "unclear", probabilities: [{ value: "unclear", probability: 0.5 }, { value: "induced", probability: 0.3 }, { value: "task", probability: 0.2 }], confidence: 0.2 },
  ] }));
  const v = await new OpenAIDecisionJudge({ key: async () => KEY, fetch: f }).judge(INPUT, new AbortController().signal);
  expect(v).toEqual({ pSafe: 0.93, label: "safe", model: "gpt-6-luna", pInduced: 0.3, inducedLabel: "unclear" });
  expect(calls).toHaveLength(1);
  expect(calls[0]!.body.questions.map((q: { name: string }) => q.name)).toEqual(["safety", "induced"]);
  expect(calls[0]!.body.questions[1].choices.map((c: { value: string }) => c.value)).toEqual(["task", "induced", "unclear"]);
});
