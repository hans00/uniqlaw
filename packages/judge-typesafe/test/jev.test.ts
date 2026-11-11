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
  expect(await j.judge(INPUT, new AbortController().signal).catch((e: Error) => e.message)).toBe("judge API key: vault locked");
  expect((await j.judge(INPUT, new AbortController().signal)).pSafe).toBe(0.9);
});

test("the abort signal reaches fetch", async () => {
  const { f, calls } = fakeFetch(() => answer(0.5));
  const ac = new AbortController();
  await new JevJudge({ key: async () => KEY, fetch: f }).judge(INPUT, ac.signal);
  expect(calls[0]!.init.signal).toBe(ac.signal);
});

// ── typesafe-compatible (self-hosted) ──────────────────────────────────────
import { createTypeSafeJudge, TYPESAFE_API } from "../src/index.ts";

test("typesafe-compatible: configurable baseUrl, auth header and scheme, extra headers; no credential = no auth header", async () => {
  const { f, calls } = fakeFetch(() => answer(0.7));
  const resolve = async () => KEY;
  const j = createTypeSafeJudge("typesafe-compatible", { baseUrl: "http://ts.local:8080", model: "jev-selfhosted", authHeader: "x-api-key", authScheme: "", headers: { "x-tenant": "t1" }, credential: { env: "X" } }, resolve);
  (j as unknown as { o: { fetch: typeof fetch } }).o.fetch = f;
  expect((await j.judge(INPUT, new AbortController().signal)).pSafe).toBe(0.7);
  const h = calls[0]!.init.headers as Record<string, string>;
  expect(calls[0]!.url).toBe("http://ts.local:8080/v1/systemone");
  expect(calls[0]!.body.model).toBe("jev-selfhosted");
  expect(h["x-api-key"]).toBe(KEY);
  expect(h.authorization).toBeUndefined();
  expect(h["x-tenant"]).toBe("t1");
  expect(j.name).toBe("TypeSafe");

  const open = createTypeSafeJudge("typesafe-compatible", { baseUrl: "http://ts.local" }, resolve);
  const o2 = fakeFetch(() => answer(0.2));
  (open as unknown as { o: { fetch: typeof fetch } }).o.fetch = o2.f;
  await open.judge(INPUT, new AbortController().signal);
  expect(Object.keys(o2.calls[0]!.init.headers as object).some((k) => /auth|key/i.test(k))).toBe(false);
});

test("typesafe-jev is the hosted service with defaults; options are validated", () => {
  const j = createTypeSafeJudge("typesafe-jev", { credential: { env: "X" } }, async () => KEY);
  expect((j as unknown as { o: { baseUrl: string; model: string } }).o).toMatchObject({ baseUrl: TYPESAFE_API, model: "jev-latest" });
  expect(j.name).toBe("Jev");
  expect(() => createTypeSafeJudge("typesafe-jev", {}, async () => KEY)).toThrow(/credential/);
  expect(() => createTypeSafeJudge("typesafe-compatible", {}, async () => KEY)).toThrow(/baseUrl/);
  expect(() => createTypeSafeJudge("typesafe-compatible", { baseUrl: "not a url" }, async () => KEY)).toThrow();
  expect(() => createTypeSafeJudge("typesafe-compatible", { baseUrl: "http://x", typo: 1 }, async () => KEY)).toThrow();
});

test("the question tells the judge about shell shape and reviewer-addressed comments", () => {
  const { f, calls } = fakeFetch(() => answer(0.5));
  void new JevJudge({ key: async () => KEY, fetch: f }).judge(INPUT, new AbortController().signal);
  return Bun.sleep(5).then(() => {
    const consider = calls[0]!.body.questions.safety.instructions.consider.join(" ");
    expect(consider).toContain("request.shape");
    expect(consider).toContain("request.reviewerAddressedComment");
  });
});

test("the question states each field's trust level and a generic effect x provenance x task guide", () => {
  const { f, calls } = fakeFetch(() => answer(0.5));
  void new JevJudge({ key: async () => KEY, fetch: f }).judge(INPUT, new AbortController().signal);
  return Bun.sleep(5).then(() => {
    const q = calls[0]!.body.questions.safety.instructions;
    const all = [q.data, ...q.consider].join(" ");
    for (const field of ["humanRequest", "actionTrace", "targets", "observedOutput", "agentRationale", "createdThisSession", "unrecognized"]) expect(all, field).toContain(field);
    expect(q.data).toMatch(/Trusted facts: `humanRequest`.*`actionTrace`/);
    expect(q.data).toMatch(/Untrusted content.*\{untrusted: …\}.*`observedOutput`.*`input` and `agentRationale` \(written by the AI agent/);
    expect(all).not.toMatch(/\brm\b/);
  });
});

test("one request carries both questions (safety + induced), for typesafe-jev and typesafe-compatible; pInduced is parsed", async () => {
  const both = () => Response.json({ model: "jev-1", answers: {
    safety: { type: "choice", choice: "safe", confidence: 0.9, probabilities: { safe: 0.93, unsafe: 0.07 } },
    induced: { type: "choice", choice: "induced", confidence: 0.3, probabilities: { task: 0.29, induced: 0.61, unclear: 0.1 } } }, usage: { input_tokens: 1, output_tokens: 1 } });
  for (const make of [(f: typeof fetch) => new JevJudge({ key: async () => KEY, fetch: f }),
    (f: typeof fetch) => { const j = createTypeSafeJudge("typesafe-compatible", { baseUrl: "http://ts.local" }, async () => KEY); (j as unknown as { o: { fetch: typeof fetch } }).o.fetch = f; return j; }]) {
    const { f, calls } = fakeFetch(both);
    expect(await make(f).judge(INPUT, new AbortController().signal)).toEqual({ pSafe: 0.93, label: "safe", model: "jev-1", pInduced: 0.61, inducedLabel: "induced" });
    expect(calls).toHaveLength(1);
    const q = calls[0]!.body.questions;
    expect(Object.keys(q)).toEqual(["safety", "induced"]);
    expect(q.induced).toMatchObject({ type: "choice" });
    expect(Object.keys(q.induced.criteria)).toEqual(["task", "induced", "unclear"]);
  }
  // A server that answers only the first question still works (no induced check then).
  expect(parseJevResponse({ answers: { safety: { type: "choice", choice: "safe", probabilities: { safe: 0.9 } } } })).toEqual({ pSafe: 0.9, label: "safe" });
});
