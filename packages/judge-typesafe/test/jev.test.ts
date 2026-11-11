// Jev client against a fake fetch (no network). Request/response shapes follow https://docs.typesafe.ai/api.md.
import { expect, test } from "bun:test";
import type { JudgeInput } from "@uniqlaw/core";
import { JevJudge, parseJevResponse } from "../src/index.ts";

const INPUT: JudgeInput = { tool: "Bash", input: { command: "ls" }, inputTrust: "untrusted", structured: true, cwd: "/w", scope: ["/w"], level: "moderate", sessionKind: "chat", channelPolicy: "unrestricted", humanRequest: "list files" };
const KEY = "test-key-not-a-secret";

function fakeFetch(respond: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit; body: any }[] = [];
  const f = (async (url: string, init: RequestInit) => { calls.push({ url, init, body: JSON.parse(String(init.body)) }); return respond(url, init); }) as unknown as typeof fetch;
  return { f, calls };
}
const answer = (safe: number, choice = safe >= 0.5 ? "safe" : "unsafe") => Response.json({ model: "jev-1", answers: { safety: { type: "choice", choice, confidence: 0.8, probabilities: { safe, unsafe: 1 - safe } } }, usage: { input_tokens: 1, output_tokens: 1 } });

test("POST /v1/systemone: bearer key, typed choice safe|unsafe, state = the judge input; pSafe = probabilities.safe", async () => {
  const { f, calls } = fakeFetch(() => answer(0.87));
  const j = new JevJudge({ key: async () => KEY, fetch: f });
  expect(await j.judge(INPUT, new AbortController().signal)).toEqual({ pSafe: 0.87, label: "safe", model: "jev-1" });
  const c = calls[0]!;
  expect(c.url).toBe("https://api.typesafe.ai/v1/systemone");
  expect((c.init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
  expect(c.body.model).toBe("jev-latest");
  expect(c.body.state).toEqual({ request: INPUT });
  expect(c.body.questions.safety.type).toBe("choice");
  expect(Object.keys(c.body.questions.safety.criteria)).toEqual(["safe", "unsafe"]);
  // The key travels only in the header.
  expect(JSON.stringify(c.body)).not.toContain(KEY);
});

test("model and base URL are configurable; the key is resolved once", async () => {
  let resolved = 0;
  const { f, calls } = fakeFetch(() => answer(0.1));
  const j = new JevJudge({ key: async () => { resolved++; return KEY; }, model: "jev-preview", baseUrl: "http://judge.test/", fetch: f });
  await j.judge(INPUT, new AbortController().signal);
  await j.judge(INPUT, new AbortController().signal);
  expect(resolved).toBe(1);
  expect(calls[0]!.url).toBe("http://judge.test/v1/systemone");
  expect(calls[1]!.body.model).toBe("jev-preview");
});

test("errors: HTTP status without the key, bad shapes, a failed key lookup is retried", async () => {
  const { f } = fakeFetch(() => new Response('{"detail":"invalid api key"}', { status: 401 }));
  const err = await new JevJudge({ key: async () => KEY, fetch: f }).judge(INPUT, new AbortController().signal).catch((e: Error) => e.message);
  expect(err).toBe('TypeSafe API HTTP 401: {"detail":"invalid api key"}');
  expect(() => parseJevResponse({ answers: { safety: { type: "noul", noul: 0.9 } } })).toThrow();
  expect(() => parseJevResponse({})).toThrow();
  let n = 0;
  const ok = fakeFetch(() => answer(0.9));
  const j = new JevJudge({ key: async () => { if (n++ === 0) throw new Error("vault locked"); return KEY; }, fetch: ok.f });
  expect(await j.judge(INPUT, new AbortController().signal).catch((e: Error) => e.message)).toBe("TypeSafe API key: vault locked");
  expect((await j.judge(INPUT, new AbortController().signal)).pSafe).toBe(0.9);
});

test("the abort signal reaches fetch", async () => {
  const { f, calls } = fakeFetch(() => answer(0.5));
  const ac = new AbortController();
  await new JevJudge({ key: async () => KEY, fetch: f }).judge(INPUT, ac.signal);
  expect(calls[0]!.init.signal).toBe(ac.signal);
});
