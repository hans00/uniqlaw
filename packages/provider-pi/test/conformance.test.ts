// Credential → wire conformance (no real credentials; nothing leaves the machine).
// For each credential kind we build the real pi runtime the adapter builds, send one
// request, and capture it: fetch-based SDKs (OpenAI, Anthropic, Gemini, Vertex incl. its
// OAuth token exchange, Azure) via a global fetch interceptor that answers locally;
// Bedrock (AWS SDK http handler, not fetch) via a local endpoint. Then we assert the
// request matches the provider's official API: URL/path, auth scheme, required headers.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { silentLogger, type Profile } from "@uniqlaw/core";
import type { ResolvedCredential } from "@uniqlaw/credentials";
import { PiProvider, configSchema, profileOptionsSchema } from "../src/index.ts";

interface Captured { url: string; method: string; headers: Record<string, string>; body: string }
const captured: Captured[] = [];
const realFetch = globalThis.fetch;
let dir: string;
let mock: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "uq-pi-conf-"));
  // Local endpoint: Bedrock target + OAuth token_uri for the fake service account.
  mock = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    const u = new URL(req.url);
    if (u.pathname === "/token") return Response.json({ access_token: "ya29.FAKE-ACCESS", issued_token_type: "urn:ietf:params:oauth:token-type:access_token", expires_in: 3600, token_type: "Bearer" });
    captured.push({ url: req.url, method: req.method, headers: Object.fromEntries(req.headers), body: await req.text() });
    return Response.json({ message: "conformance mock: request captured" }, { status: 400 });
  } });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const u = new URL(req.url);
    if (u.hostname === "127.0.0.1") return realFetch(req);
    if (u.pathname.endsWith("/token") && u.hostname.includes("googleapis")) return Response.json({ access_token: "ya29.FAKE-ACCESS", expires_in: 3600, token_type: "Bearer" });
    captured.push({ url: req.url, method: req.method, headers: Object.fromEntries(req.headers), body: await req.text() });
    return Response.json({ error: { message: "conformance mock: request captured", type: "invalid_request_error" } }, { status: 400 });
  }) as typeof fetch;
});
afterAll(() => { globalThis.fetch = realFetch; mock.stop(true); rmSync(dir, { recursive: true, force: true }); });

async function capture(cred: ResolvedCredential, model: string, opts: { baseUrlOverride?: string; env?: Record<string, string> } = {}): Promise<Captured> {
  captured.length = 0;
  const provider = new PiProvider(configSchema.parse({}), { log: silentLogger, stateDir: dir });
  const profile = { name: "p", provider: "pi", model, permissions: {} as Profile["permissions"], options: {} } as Profile;
  const { runtime, model: m } = await (provider as unknown as { buildRuntime: (...a: unknown[]) => Promise<{ runtime: any; model: any }> })
    .buildRuntime(profile, cred, profileOptionsSchema.parse({}), join(dir, "agent"));
  const target = opts.baseUrlOverride ? { ...m, baseUrl: opts.baseUrlOverride } : m;
  const ctx = { systemPrompt: "sys", messages: [{ role: "user", content: [{ type: "text", text: "ping" }], timestamp: Date.now() }] };
  let err = "";
  try {
    const res = await runtime.complete(target, ctx, { maxRetries: 0, ...(opts.env ? { env: opts.env } : {}) });
    err = res?.errorMessage ?? "";
  } catch (e) { err = String(e); /* the mock rejects on purpose */ }
  if (!captured.length) throw new Error(`no request captured; provider error: ${err}`);
  return captured[0]!;
}

describe("pi credential → official API wire format", () => {
  test("openai-api-key → OpenAI Responses API, Bearer auth", async () => {
    const r = await capture({ kind: "openai-api-key", key: "sk-FAKE" }, "gpt-4.1");
    expect(r.method).toBe("POST");
    expect(r.url).toBe("https://api.openai.com/v1/responses");
    expect(r.headers.authorization).toBe("Bearer sk-FAKE");
    expect(JSON.parse(r.body)).toMatchObject({ model: "gpt-4.1", stream: true });
  });

  test("openai-api-key with baseUrl + org → proxy URL and OpenAI-Organization header", async () => {
    const r = await capture({ kind: "openai-api-key", key: "sk-FAKE", baseUrl: "https://proxy.example/v1/", org: "org-123" }, "gpt-4.1");
    expect(r.url).toBe("https://proxy.example/v1/responses");
    expect(r.headers["openai-organization"]).toBe("org-123");
    expect(r.headers.authorization).toBe("Bearer sk-FAKE");
  });

  test("anthropic-api-key → Messages API, x-api-key + anthropic-version", async () => {
    const r = await capture({ kind: "anthropic-api-key", key: "sk-ant-FAKE" }, "claude-haiku-4-5");
    const u = new URL(r.url);
    expect(`${u.origin}${u.pathname}`).toBe("https://api.anthropic.com/v1/messages"); // SDK adds ?beta=true (beta Messages endpoint)
    expect(r.headers["x-api-key"]).toBe("sk-ant-FAKE");
    expect(r.headers["anthropic-version"]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(r.headers.authorization).toBeUndefined();
    expect(JSON.parse(r.body)).toMatchObject({ model: "claude-haiku-4-5", stream: true });
  });

  test("gemini-api-key → Gemini API streamGenerateContent, x-goog-api-key", async () => {
    const r = await capture({ kind: "gemini-api-key", key: "AIza-FAKE" }, "gemini-2.5-flash");
    expect(r.url).toMatch(/^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-2\.5-flash:streamGenerateContent\?alt=sse$/);
    expect(r.headers["x-goog-api-key"]).toBe("AIza-FAKE");
  });

  test("gcp (ADC credential file) → Vertex streamGenerateContent with project/location in path, OAuth Bearer", async () => {
    // external_account (workload identity) credential: its token_url is taken from the file, so the
    // token exchange stays on the local mock. HTTPS_PROXY to a dead local port is a second guard:
    // google-auth (gaxios/node-fetch, not global fetch) can never reach Google from this test.
    const subject = join(dir, "subject.jwt");
    writeFileSync(subject, "fake-subject-token");
    const adc = join(dir, "adc.json");
    writeFileSync(adc, JSON.stringify({ type: "external_account",
      audience: "//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p/providers/x",
      subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
      token_url: `http://127.0.0.1:${mock.port}/token`, credential_source: { file: subject } }));
    const saved = { HTTPS_PROXY: process.env.HTTPS_PROXY, NO_PROXY: process.env.NO_PROXY };
    process.env.HTTPS_PROXY = "http://127.0.0.1:9";
    process.env.NO_PROXY = "127.0.0.1,localhost";
    try {
      const r = await capture({ kind: "gcp", project: "fake-proj", location: "us-central1", serviceAccountFile: adc }, "gemini-2.5-flash");
      expect(r.url).toMatch(/^https:\/\/us-central1-aiplatform\.googleapis\.com\/v1(beta1)?\/projects\/fake-proj\/locations\/us-central1\/publishers\/google\/models\/gemini-2\.5-flash:streamGenerateContent\?alt=sse$/);
      expect(r.headers.authorization).toBe("Bearer ya29.FAKE-ACCESS");
    } finally {
      for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  test("aws (static keys) → Bedrock ConverseStream, SigV4 for the configured region", async () => {
    const r = await capture({ kind: "aws", region: "eu-west-1", accessKey: "AKIAFAKEFAKEFAKE", secretKey: "secretFAKE" }, "amazon.nova-lite-v1:0",
      { baseUrlOverride: `http://127.0.0.1:${mock.port}`, env: { AWS_BEDROCK_FORCE_HTTP1: "1" } });
    expect(r.method).toBe("POST");
    expect(new URL(r.url).pathname).toBe(`/model/${encodeURIComponent("amazon.nova-lite-v1:0")}/converse-stream`);
    expect(r.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAFAKEFAKEFAKE\/\d{8}\/eu-west-1\/bedrock\/aws4_request, SignedHeaders=[^,]+, Signature=[0-9a-f]{64}$/);
    expect(r.headers["x-amz-date"]).toMatch(/^\d{8}T\d{6}Z$/);
    expect(JSON.parse(r.body)).toHaveProperty("messages");
  });

  test("aws (session token) → x-amz-security-token header", async () => {
    const r = await capture({ kind: "aws", region: "us-west-2", accessKey: "ASIAFAKE", secretKey: "s", sessionToken: "TOKEN-FAKE" }, "amazon.nova-lite-v1:0",
      { baseUrlOverride: `http://127.0.0.1:${mock.port}`, env: { AWS_BEDROCK_FORCE_HTTP1: "1" } });
    expect(r.headers["x-amz-security-token"]).toBe("TOKEN-FAKE");
    expect(r.headers.authorization).toContain("/us-west-2/bedrock/aws4_request");
  });

  test("azure (api key) → <endpoint>/openai/v1/responses with api-key header and api-version", async () => {
    const r = await capture({ kind: "azure", endpoint: "https://myres.openai.azure.com", deployment: "my-gpt41", apiVersion: "preview",
      auth: { type: "api-key", key: "AZ-FAKE" } } as ResolvedCredential, "gpt-4.1");
    const u = new URL(r.url);
    expect(u.hostname).toBe("myres.openai.azure.com");
    expect(u.pathname).toBe("/openai/v1/responses");
    expect(u.searchParams.get("api-version")).toBe("preview");
    expect(r.headers["api-key"]).toBe("AZ-FAKE");
    expect(JSON.parse(r.body)).toMatchObject({ model: "my-gpt41" }); // deployment name map applied
  });
});
