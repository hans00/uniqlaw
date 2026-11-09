// Inbound voice/audio transcription: only when the provider can't take audio (or "always"),
// transcript appended to the message, failures fall back to the file alone, long clips skipped.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChannelManager, StateStore, parseSettings, silentLogger, type Attachment, type Profile, type ProviderCapabilities, type Transcriber } from "../src/index.ts";
import { CAPS, FakePlatform, FakeProvider, type Script } from "./fakes.ts";

let dir: string;
let store: StateStore;
let managers: ChannelManager[] = [];
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "uq-stt-")); store = new StateStore(join(dir, "state.db")); });
afterEach(async () => { for (const m of managers) await m.stop(); managers = []; store.close(); rmSync(dir, { recursive: true, force: true }); });

const reply: Script = (_i, s) => { s.emit({ type: "text", segmentId: "a", final: "ok" }, { type: "turn_end", turnId: s.turnId(), reason: "done" }); };
const until = async (cond: () => boolean, ms = 2000) => { const end = Date.now() + ms; while (!cond()) { if (Date.now() > end) throw new Error("timeout"); await Bun.sleep(5); } };

function setup(transcriber: Transcriber, caps: ProviderCapabilities = CAPS, transcription: Record<string, unknown> = {}) {
  const s = parseSettings({ profiles: { main: { provider: "fake" } }, output: { toolStatus: false }, queue: { debounceMs: 0 }, transcription: { engine: "fake", ...transcription } });
  const provider = new FakeProvider(reply, caps);
  const prof: Profile = { name: "main", provider: "fake", permissions: s.profiles.main!.permissions, options: {} };
  const mgr = new ChannelManager({
    log: silentLogger, settings: s, store, projectDir: dir, instanceId: "test", transcriber,
    providers: new Map([["fake", provider]]), platforms: new Map([["tg", new FakePlatform()]]), profiles: new Map([["main", prof]]),
    gatewayFor: () => undefined, providerEnv: async () => ({}), systemPrompt: async () => ({ fragments: [] }),
  });
  managers.push(mgr);
  const send = (text: string, attachments: Attachment[]) => mgr.handleInbound({ platform: "tg", channelKey: "tg:9", replyTarget: { platform: "tg", chatId: "9" },
    ref: { platform: "tg", chatId: "9", messageId: "m" }, sender: { id: "9", name: "u" }, trusted: true, multiparty: false, text, attachments, receivedAt: Date.now() });
  const turns = () => provider.sessions.get("tg:9")?.sent ?? [];
  return { send, turns };
}

const voice: Attachment = { kind: "voice", path: "/tmp/v.oga", mime: "audio/ogg", durationSec: 4 };

test("voice note is transcribed for a provider without audio input; the file is still attached", async () => {
  const calls: unknown[] = [];
  const { send, turns } = setup({ transcribe: async (i) => { calls.push(i); return " 明天早上提醒我 "; } }, { ...CAPS, attachments: ["image", "file"] }, { language: "zh" });
  await send("", [voice, { kind: "image", path: "/tmp/p.png" }]);
  await until(() => turns().length === 1);
  expect(turns()[0]!.text).toContain("[Voice message transcript: 明天早上提醒我]");
  expect(turns()[0]!.attachments.map((a) => a.kind)).toEqual(["voice", "image"]);
  expect(calls).toEqual([{ path: "/tmp/v.oga", mime: "audio/ogg", language: "zh" }]);
});

test("skipped when the provider takes audio itself, unless when=always", async () => {
  let n = 0;
  const t: Transcriber = { transcribe: async () => { n++; return "hi"; } };
  const a = setup(t, { ...CAPS, attachments: ["image", "audio"] });
  await a.send("listen", [voice]);
  await until(() => a.turns().length === 1);
  expect(n).toBe(0);
  expect(a.turns()[0]!.text).not.toContain("transcript");
  for (const m of managers.splice(0)) await m.stop();
  const b = setup(t, { ...CAPS, attachments: ["image", "audio"] }, { when: "always" });
  await b.send("listen", [voice]);
  await until(() => b.turns().length === 1);
  expect(n).toBe(1);
  expect(b.turns()[0]!.text).toContain("listen");
  expect(b.turns()[0]!.text).toContain("[Voice message transcript: hi]");
});

test("failures fall back to the file alone; clips over maxSeconds are not sent to the engine", async () => {
  let n = 0;
  const { send, turns } = setup({ transcribe: async () => { n++; throw new Error("boom"); } }, { ...CAPS, attachments: [] }, { maxSeconds: 60 });
  await send("", [voice, { kind: "audio", path: "/tmp/long.mp3", durationSec: 3600 }]);
  await until(() => turns().length === 1);
  expect(n).toBe(1);
  expect(turns()[0]!.text).not.toContain("Voice message transcript");
  expect(turns()[0]!.text).toContain("audio not transcribed: 3600s is over transcription.maxSeconds");
});
