import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSettings } from "@uniqlaw/core";
import { answersFromFlags, buildSettings, parseSecretRef, writeSettings } from "../src/init.ts";
import { runDoctor } from "../src/doctor.ts";

const MAIN = join(import.meta.dir, "..", "src", "main.ts");
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "uq-init-")); dirs.push(d); return d; };
const read = (d: string) => JSON.parse(readFileSync(join(d, ".uniqlaw", "settings.json"), "utf8"));

describe("secret references", () => {
  test("env/file/cmd forms; bare upper-case = env var; raw secrets refused", () => {
    expect(parseSecretRef("TELEGRAM_BOT_TOKEN")).toEqual({ env: "TELEGRAM_BOT_TOKEN" });
    expect(parseSecretRef("env:X_Y")).toEqual({ env: "X_Y" });
    expect(parseSecretRef("file:~/.tg")).toEqual({ file: "~/.tg" });
    expect(parseSecretRef("cmd:pass show tg")).toEqual({ command: "pass show tg" });
    expect(() => parseSecretRef("123456:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw")).toThrow(/Raw secrets are never stored/);
  });
});

describe("--yes mode", () => {
  test("claude-tmux + telegram with env token; settings are schema-valid and contain no raw secrets", () => {
    const a = answersFromFlags({ yes: true, provider: "claude-tmux", model: "haiku", "telegram-users": "111, 222" }, ["claude-tmux", "pi"]);
    const s = buildSettings(a);
    expect(s).toMatchObject({ profiles: { main: { provider: "claude-tmux", model: "haiku" } },
      plugins: { telegram: { enabled: true, token: { env: "TELEGRAM_BOT_TOKEN" }, allowedUserIds: ["111", "222"] } } });
    expect(parseSettings(s).profiles.main!.provider).toBe("claude-tmux");
  });
  test("cloud credentials", () => {
    const gcp = buildSettings(answersFromFlags({ provider: "pi", model: "google-vertex/gemini-3-pro", credential: "gcp", "gcp-project": "p1", location: "europe-west4" }, ["pi"]));
    expect(gcp).toMatchObject({ credentials: { main: { kind: "gcp", project: "p1", location: "europe-west4" } }, profiles: { main: { credential: "main" } } });
    const az = buildSettings(answersFromFlags({ provider: "codex", credential: "azure", endpoint: "https://x.openai.azure.com", key: "entra" }, ["codex"]));
    expect(az).toMatchObject({ credentials: { main: { kind: "azure", auth: { type: "entra" } } } });
    const aws = buildSettings(answersFromFlags({ provider: "claude-sdk", credential: "aws", region: "eu-west-1", "aws-profile": "work" }, ["claude-sdk"]));
    expect(aws).toMatchObject({ credentials: { main: { kind: "aws", region: "eu-west-1", profile: "work" } } });
  });
  test("refuses an empty allowlist unless --allow-empty; rejects unsupported credential", () => {
    expect(() => answersFromFlags({ provider: "pi", telegram: true }, ["pi"])).toThrow(/ignore everyone/);
    expect(answersFromFlags({ provider: "pi", telegram: true, "allow-empty": true }, ["pi"]).platforms.telegram!.allowedUserIds).toEqual([]);
    expect(() => answersFromFlags({ provider: "agy", credential: "aws" }, ["agy"])).toThrow(/not supported/);
  });
  test("writeSettings scaffolds prompts and refuses to overwrite without force", () => {
    const d = tmp();
    const a = answersFromFlags({ provider: "pi", credential: "openai-api-key" }, ["pi"]);
    const r = writeSettings(d, a);
    expect(r.created.sort()).toEqual(["prompts/IDENTITY.md", "prompts/SOUL.md", "prompts/USER.md"]);
    expect(read(d).credentials.main).toEqual({ kind: "openai-api-key", key: { env: "OPENAI_API_KEY" } });
    expect(() => writeSettings(d, a)).toThrow(/already exists/);
    writeFileSync(join(d, "prompts", "IDENTITY.md"), "mine");
    writeSettings(d, a, { force: true });
    expect(readFileSync(join(d, "prompts", "IDENTITY.md"), "utf8")).toBe("mine"); // prompts never overwritten
  });
});

test("interactive wizard via scripted stdin (CLI end-to-end)", async () => {
  const d = tmp();
  // provider: pi (find its index), model, credential openai-api-key, key ref, base url blank,
  // telegram yes + token ref + users, discord/slack/line no, web yes, heartbeat yes
  const providers = ["claude-tmux", "claude-sdk", "codex", "opencode", "agy", "pi"].filter((p) => p === "pi" || Bun.which(p.startsWith("claude") ? "claude" : p));
  const piIdx = providers.indexOf("pi") + 1;
  const script = [String(piIdx), "openai/gpt-6-luna", "1", "MY_OPENAI_KEY", "", "y", "env:TG_TOKEN", "42", "n", "n", "n", "y", "y"].join("\n") + "\n";
  const p = Bun.spawn([process.execPath, MAIN, "init", "--project", d], { stdin: new Blob([script]), stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = [await new Response(p.stdout).text(), await new Response(p.stderr).text(), await p.exited];
  expect(err).toBe("");
  expect(code).toBe(0);
  expect(out).toContain("wrote");
  const s = read(d);
  expect(s.profiles.main).toEqual({ provider: "pi", model: "openai/gpt-6-luna", credential: "main" });
  expect(s.credentials.main).toEqual({ kind: "openai-api-key", key: { env: "MY_OPENAI_KEY" } });
  expect(s.plugins.telegram).toEqual({ enabled: true, token: { env: "TG_TOKEN" }, allowedUserIds: ["42"] });
  expect(s.plugins.heartbeat).toMatchObject({ enabled: true });
  expect(existsSync(join(d, "prompts", "SOUL.md"))).toBe(true);
}, 30_000);

test("wizard rejects a pasted raw token and re-asks", async () => {
  const d = tmp();
  const piIdx = ["claude-tmux", "claude-sdk", "codex", "opencode", "agy", "pi"].filter((p) => p === "pi" || Bun.which(p.startsWith("claude") ? "claude" : p)).indexOf("pi") + 1;
  const script = [String(piIdx), "", "1", "sk-live-abc123secret", "OPENAI_API_KEY", "", "n", "n", "n", "n", "n", "n"].join("\n") + "\n";
  const p = Bun.spawn([process.execPath, MAIN, "init", "--project", d], { stdin: new Blob([script]), stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  expect(await p.exited).toBe(0);
  expect(out).toContain("Raw secrets are never stored");
  expect(out).not.toContain("sk-live-abc123secret");
  expect(readFileSync(join(d, ".uniqlaw", "settings.json"), "utf8")).not.toContain("sk-live");
}, 30_000);

describe("doctor", () => {
  test("reports missing binaries, unresolvable secrets, empty allowlists, busy ports — without printing secrets", async () => {
    const d = tmp();
    mkdirSync(join(d, ".uniqlaw"), { recursive: true });
    writeFileSync(join(d, ".uniqlaw", "settings.json"), JSON.stringify({
      profiles: { main: { provider: "claude-tmux", credential: "k" } },
      credentials: { k: { kind: "anthropic-api-key", key: { env: "UQ_DOCTOR_MISSING_KEY" } } },
      web: { port: 4632 },
      plugins: { telegram: { token: "123:inline-secret-value", allowedUserIds: [] } },
    }));
    const checks = await runDoctor(d, { which: (b) => (b === "tmux" ? null : `/usr/bin/${b}`), portFree: () => false });
    const text = checks.map((c) => `${c.level} ${c.message}`).join("\n");
    expect(text).toMatch(/fail claude-tmux needs tmux — not found/);
    expect(text).toMatch(/fail "k" \(anthropic-api-key\): .*UQ_DOCTOR_MISSING_KEY/);
    expect(text).toMatch(/warn telegram\.token is stored inline/);
    expect(text).toMatch(/warn telegram\.allowedUserIds is empty/);
    expect(text).toMatch(/fail web 127\.0\.0\.1:4632 is in use \(ClaudeClaw v2's default port\)/);
    expect(text).not.toContain("inline-secret-value");
  });
  test("invalid settings fail early", async () => {
    const d = tmp();
    mkdirSync(join(d, ".uniqlaw"), { recursive: true });
    writeFileSync(join(d, ".uniqlaw", "settings.json"), JSON.stringify({ queue: { mode: "native" } }));
    const checks = await runDoctor(d, { which: () => null, portFree: () => true });
    expect(checks.at(-1)).toMatchObject({ level: "fail", area: "settings" });
  });
});
