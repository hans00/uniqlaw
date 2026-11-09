// send_file: default target = the caller's chat, explicit targets, kind from extension,
// allowed directories, size limit and the "sent on your behalf" echo.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChannelManager, StateStore, kindFromName, parseSettings, silentLogger, type Profile } from "../src/index.ts";
import { CAPS, FakePlatform, FakeProvider } from "./fakes.ts";

let dir: string;
let outside: string;
let store: StateStore;
let mgr: ChannelManager;
let platform: FakePlatform;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "uq-sf-"));
  // a directory that is neither the project, the temp dir nor a configured root
  outside = mkdtempSync(join(process.env.HOME ?? "/", ".uq-sf-outside-"));
  store = new StateStore(join(dir, "state.db"));
  const s = parseSettings({ profiles: { main: { provider: "fake" } }, files: { maxMB: 0.001 } });
  platform = new FakePlatform();
  const prof: Profile = { name: "main", provider: "fake", permissions: s.profiles.main!.permissions, options: {} };
  mgr = new ChannelManager({
    log: silentLogger, settings: s, store, projectDir: join(dir, "proj"), instanceId: "test",
    providers: new Map([["fake", new FakeProvider(() => {}, CAPS)]]), platforms: new Map([["tg", platform]]), profiles: new Map([["main", prof]]),
    gatewayFor: () => undefined, providerEnv: async () => ({}), systemPrompt: async () => ({ fragments: [] }),
  });
  mkdirSync(join(dir, "proj"));
  writeFileSync(join(dir, "proj", "chart.png"), "png");
});
afterEach(async () => {
  await mgr.stop();
  store.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

test("defaults to the caller's own chat; relative paths resolve against its cwd; kind from extension", async () => {
  const r = await mgr.sendFile("tg:100", { path: "chart.png", caption: "hi" });
  expect(r).toEqual({ target: "tg:100", file: "chart.png" });
  expect(platform.files[0]).toMatchObject({ target: { platform: "tg", chatId: "100" }, file: { name: "chart.png", kind: "image", caption: "hi" } });
  expect(store.countPending("tg:100")).toBe(0); // own chat: no echo
});

test("another chat gets it with an echo for its session; internal sessions must pass a target", async () => {
  await mgr.sendFile("heartbeat", { path: join(dir, "proj", "chart.png"), target: "tg:200", kind: "file", name: "report.png" });
  expect(platform.files[0]!.file).toMatchObject({ name: "report.png", kind: "file" });
  expect(JSON.parse(store.drainPending("tg:200")[0]!.payload).text).toBe("[file: report.png]");
  await expect(mgr.sendFile("heartbeat", { path: "chart.png" })).rejects.toThrow("pass target");
});

test("files outside the allowed directories, missing files and oversized files are refused", async () => {
  writeFileSync(join(outside, "secret.txt"), "x");
  await expect(mgr.sendFile("tg:100", { path: join(outside, "secret.txt") })).rejects.toThrow("outside the directories");
  await expect(mgr.sendFile("tg:100", { path: "nope.png" })).rejects.toThrow("file not found");
  writeFileSync(join(dir, "proj", "big.bin"), "x".repeat(5000));
  await expect(mgr.sendFile("tg:100", { path: "big.bin" })).rejects.toThrow("files.maxMB");
  const tmp = join(tmpdir(), `uq-sf-${process.pid}.ogg`);
  writeFileSync(tmp, "ogg");
  await mgr.sendFile("tg:100", { path: tmp });
  expect(platform.files[0]!.file.kind).toBe("voice");
  rmSync(tmp);
  expect(platform.files).toHaveLength(1);
});

test("kindFromName", () => {
  expect(["a.JPG", "b.opus", "c.mp3", "d.mov", "e.pdf"].map(kindFromName)).toEqual(["image", "voice", "audio", "video", "file"]);
});
