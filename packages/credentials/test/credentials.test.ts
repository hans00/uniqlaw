import { describe, expect, test } from "bun:test";
import type { Credential } from "@uniqlaw/core";
import { azureDeploymentMap, describeCredential, envFor, piAuthFor, resolveCredential, validateCredential } from "../src/index.ts";

const env = { OPENAI_KEY: "sk-test-openai", ANT: "sk-ant-test", AK: "AKIAFAKE", SK: "secretfake", EMPTY: "" };
const fakeFs = (files: Record<string, string>) => ({
  fileExists: (p: string) => p in files,
  readFile: (p: string) => { if (!(p in files)) throw new Error("ENOENT"); return files[p]!; },
  homedir: "/home/u",
});

describe("resolveCredential", () => {
  test("resolves env / file / command refs", async () => {
    expect(await resolveCredential({ kind: "openai-api-key", key: { env: "OPENAI_KEY" }, baseUrl: "https://x.test/v1" }, { env }))
      .toEqual({ kind: "openai-api-key", key: "sk-test-openai", baseUrl: "https://x.test/v1", org: undefined });
    const cmd = await resolveCredential({ kind: "anthropic-api-key", key: { command: "printf 'sk-from-cmd'" } }, { env });
    expect(cmd).toEqual({ kind: "anthropic-api-key", key: "sk-from-cmd" });
    await expect(resolveCredential({ kind: "gemini-api-key", key: { env: "MISSING" } }, { env })).rejects.toThrow(/MISSING is not set/);
  });

  test("aws keys and azure api-key", async () => {
    const aws = await resolveCredential({ kind: "aws", region: "us-west-2", accessKey: { env: "AK" }, secretKey: { env: "SK" } }, { env });
    expect(aws).toMatchObject({ region: "us-west-2", accessKey: "AKIAFAKE", secretKey: "secretfake" });
    const az = await resolveCredential({ kind: "azure", endpoint: "https://r.openai.azure.com", auth: { type: "api-key", key: { env: "OPENAI_KEY" } } }, { env });
    expect(az).toMatchObject({ auth: { type: "api-key", key: "sk-test-openai" } });
  });
});

describe("describeCredential never contains secret values", () => {
  const all: Credential[] = [
    { kind: "anthropic-api-key", key: { env: "ANT" } },
    { kind: "openai-api-key", key: { file: "~/.keys/openai" } },
    { kind: "aws", region: "eu-west-1", accessKey: { env: "AK" }, secretKey: { env: "SK" } },
    { kind: "aws", region: "eu-west-1", profile: "dev", roleArn: "arn:aws:iam::123456789012:role/x" },
    { kind: "gcp", project: "p", location: "us-central1" },
    { kind: "azure", endpoint: "https://r.openai.azure.com", auth: { type: "entra" } },
    { kind: "openai-compatible", baseUrl: "http://localhost:11434/v1" },
    { kind: "provider-login", provider: "anthropic", home: "~/.pi-alt" },
  ];
  for (const c of all) test(c.kind, () => {
    const d = describeCredential(c);
    for (const v of Object.values(env)) if (v) expect(d).not.toContain(v);
    expect(d.length).toBeGreaterThan(5);
  });
  test("shows where the secret lives", () => {
    expect(describeCredential({ kind: "anthropic-api-key", key: { env: "ANT" } })).toBe("Anthropic API key ($ANT)");
    expect(describeCredential({ kind: "aws", region: "us-east-1" })).toBe("AWS us-east-1 via default credential chain");
  });
});

describe("validateCredential", () => {
  test("api key: missing / empty secret is an error", async () => {
    expect((await validateCredential({ kind: "openai-api-key", key: { env: "OPENAI_KEY" } }, { env })).ok).toBe(true);
    const r = await validateCredential({ kind: "openai-api-key", key: { env: "NOPE" } }, { env });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain("NOPE");
    expect((await validateCredential({ kind: "gemini-api-key", key: { env: "EMPTY" } }, { env })).ok).toBe(false);
  });

  test("aws profile must exist in config or credentials file", async () => {
    const fs = fakeFs({ "/home/u/.aws/config": "[default]\nregion=x\n[profile dev]\nsso_session=y\n" });
    expect((await validateCredential({ kind: "aws", region: "us-east-1", profile: "dev" }, { env: {}, ...fs })).ok).toBe(true);
    const bad = await validateCredential({ kind: "aws", region: "us-east-1", profile: "prod" }, { env: {}, ...fs });
    expect(bad.errors[0]).toMatch(/profile "prod" not found/);
    const creds = fakeFs({ "/custom/creds": "[prod]\naws_access_key_id=x\n" });
    expect((await validateCredential({ kind: "aws", region: "us-east-1", profile: "prod" }, { env: { AWS_SHARED_CREDENTIALS_FILE: "/custom/creds" }, ...creds })).ok).toBe(true);
  });

  test("aws: half a key pair, bad role arn, default chain warning", async () => {
    const half = await validateCredential({ kind: "aws", region: "r", accessKey: { env: "AK" } }, { env });
    expect(half.errors.join()).toContain("together");
    const arn = await validateCredential({ kind: "aws", region: "r", profile: "dev", roleArn: "nope" }, { env: {}, ...fakeFs({ "/home/u/.aws/config": "[profile dev]" }) });
    expect(arn.errors.join()).toContain("roleArn");
    const chain = await validateCredential({ kind: "aws", region: "r" }, { env: {}, ...fakeFs({}) });
    expect(chain.ok).toBe(true);
    expect(chain.warnings[0]).toContain("default chain");
  });

  test("gcp: ADC file or service account file, plus project/location", async () => {
    const adc = fakeFs({ "/home/u/.config/gcloud/application_default_credentials.json": "{}" });
    expect((await validateCredential({ kind: "gcp", project: "p", location: "l" }, { env: {}, ...adc })).ok).toBe(true);
    const none = await validateCredential({ kind: "gcp", project: "p", location: "l" }, { env: {}, ...fakeFs({}) });
    expect(none.errors[0]).toContain("application-default login");
    const sa = await validateCredential({ kind: "gcp", project: "", location: "l", serviceAccountFile: "/sa.json" }, { env: {}, ...fakeFs({}) });
    expect(sa.errors).toEqual(["project is required", "service account file /sa.json does not exist"]);
    const envAdc = fakeFs({ "/x/adc.json": "{}" });
    expect((await validateCredential({ kind: "gcp", project: "p", location: "l" }, { env: { GOOGLE_APPLICATION_CREDENTIALS: "/x/adc.json" }, ...envAdc })).ok).toBe(true);
  });

  test("azure: endpoint URL + key or entra", async () => {
    expect((await validateCredential({ kind: "azure", endpoint: "not a url", auth: { type: "api-key", key: { env: "OPENAI_KEY" } } }, { env })).errors[0]).toContain("not a URL");
    const entra = await validateCredential({ kind: "azure", endpoint: "https://r.openai.azure.com", auth: { type: "entra" } }, { env: {} });
    expect(entra.ok).toBe(true);
    expect(entra.warnings[0]).toContain("Entra");
  });
});

describe("mappers", () => {
  test("envFor", () => {
    expect(envFor({ kind: "anthropic-api-key", key: "k" })).toEqual({ ANTHROPIC_API_KEY: "k" });
    expect(envFor({ kind: "aws", region: "us-west-2", profile: "dev" })).toEqual({ AWS_REGION: "us-west-2", AWS_DEFAULT_REGION: "us-west-2", AWS_PROFILE: "dev" });
    expect(envFor({ kind: "gcp", project: "p", location: "l", serviceAccountFile: "/sa.json" }))
      .toEqual({ GOOGLE_CLOUD_PROJECT: "p", GCLOUD_PROJECT: "p", GOOGLE_CLOUD_LOCATION: "l", GOOGLE_APPLICATION_CREDENTIALS: "/sa.json" });
    expect(envFor({ kind: "azure", endpoint: "https://e", auth: { type: "api-key", key: "k" } }))
      .toEqual({ AZURE_OPENAI_BASE_URL: "https://e", AZURE_OPENAI_ENDPOINT: "https://e", AZURE_OPENAI_API_KEY: "k" });
    expect(envFor({ kind: "provider-login", provider: "x" })).toEqual({});
  });

  test("piAuthFor maps to pi-ai provider ids with scoped env", () => {
    expect(piAuthFor({ kind: "openai-api-key", key: "k" })).toEqual({ provider: "openai", credential: { type: "api_key", key: "k" } });
    expect(piAuthFor({ kind: "gemini-api-key", key: "k" }).provider).toBe("google");
    expect(piAuthFor({ kind: "aws", region: "us-west-2", accessKey: "a", secretKey: "s" }))
      .toEqual({ provider: "amazon-bedrock", credential: { type: "api_key" },
        requestEnv: { AWS_REGION: "us-west-2", AWS_DEFAULT_REGION: "us-west-2", AWS_ACCESS_KEY_ID: "a", AWS_SECRET_ACCESS_KEY: "s" } });
    expect(piAuthFor({ kind: "aws", region: "us-east-1", profile: "dev" }))
      .toEqual({ provider: "amazon-bedrock", credential: { type: "api_key", env: { AWS_PROFILE: "dev" } },
        requestEnv: { AWS_REGION: "us-east-1", AWS_DEFAULT_REGION: "us-east-1", AWS_PROFILE: "dev" } });
    expect(piAuthFor({ kind: "gcp", project: "p", location: "l" }))
      .toEqual({ provider: "google-vertex", credential: { type: "api_key", env: { GOOGLE_CLOUD_PROJECT: "p", GOOGLE_CLOUD_LOCATION: "l" } } });
    expect(piAuthFor({ kind: "azure", endpoint: "https://e", apiVersion: "2025-04-01-preview", auth: { type: "api-key", key: "ak" } }))
      .toEqual({ provider: "azure", credential: { type: "api_key", key: "ak", env: { AZURE_OPENAI_BASE_URL: "https://e", AZURE_OPENAI_API_VERSION: "2025-04-01-preview" } } });
    // pi-ai 1.4 cannot honour these → refuse instead of silently ignoring
    expect(() => piAuthFor({ kind: "azure", endpoint: "https://e", auth: { type: "entra" } })).toThrow(/Entra ID auth is not supported/);
    expect(() => piAuthFor({ kind: "aws", region: "us-east-1", roleArn: "arn:aws:iam::1:role/x" })).toThrow(/roleArn is not supported/);
    expect(() => piAuthFor({ kind: "gcp", project: "p", location: "l", impersonate: "sa@p.iam" })).toThrow(/impersonate is not supported/);
    // OpenAI base URL / org go on the model (pi-ai reads no OPENAI_BASE_URL / OPENAI_ORG_ID env)
    expect(piAuthFor({ kind: "openai-api-key", key: "k", baseUrl: "https://proxy.example/v1/", org: "org-1" }))
      .toEqual({ provider: "openai", credential: { type: "api_key", key: "k" }, modelOverrides: { baseUrl: "https://proxy.example/v1", headers: { "OpenAI-Organization": "org-1" } } });
    expect(piAuthFor({ kind: "openai-compatible", baseUrl: "http://localhost:8080/v1" }))
      .toEqual({ provider: "uniqlaw-compat", compat: { baseUrl: "http://localhost:8080/v1", apiKey: undefined } });
    expect(piAuthFor({ kind: "provider-login", provider: "anthropic", home: "/h" })).toEqual({ provider: "anthropic", authPath: "/h/auth.json" });
    expect(azureDeploymentMap("gpt-5", "my-dep")).toEqual({ AZURE_OPENAI_DEPLOYMENT_NAME_MAP: "gpt-5=my-dep" });
    expect(azureDeploymentMap("gpt-5")).toEqual({});
  });
});
