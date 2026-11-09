// DM pairing: one code per stranger, capped open requests, operator approval from chat,
// paired users handed to the adapter (not operators), expiry, deny and revoke.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChannelManager, StateStore, parseSettings, silentLogger, type Profile, type UnknownSender } from "../src/index.ts";
import { CAPS, FakePlatform, FakeProvider } from "./fakes.ts";

let dir: string;
let store: StateStore;
let mgr: ChannelManager;
let platform: FakePlatform;
function setup(pairing: Record<string, unknown> = {}) {
  const s = parseSettings({ profiles: { main: { provider: "fake" } }, pairing });
  platform = new FakePlatform();
  const prof: Profile = { name: "main", provider: "fake", permissions: s.profiles.main!.permissions, options: {} };
  mgr = new ChannelManager({
    log: silentLogger, settings: s, store, projectDir: dir, instanceId: "test",
    providers: new Map([["fake", new FakeProvider(() => {}, CAPS)]]), platforms: new Map([["tg", platform]]), profiles: new Map([["main", prof]]),
    gatewayFor: () => undefined, providerEnv: async () => ({}), systemPrompt: async () => ({ fragments: [] }),
  });
}
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "uq-pair-")); store = new StateStore(join(dir, "state.db")); });
afterEach(async () => { await mgr.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); });

const stranger = (id: string): UnknownSender => ({ platform: "tg", userId: id, name: `S${id}`, username: `s${id}`, replyTarget: { platform: "tg", chatId: id } });
const operatorCmd = (text: string) => mgr.handleInbound({ platform: "tg", channelKey: "tg:1", replyTarget: { platform: "tg", chatId: "1" },
  ref: { platform: "tg", chatId: "1", messageId: "m" }, sender: { id: "1", name: "Op" }, trusted: true, multiparty: false, text, attachments: [], receivedAt: Date.now() });

test("stranger gets one code; operator is notified and approves from chat; adapter gets the paired set", async () => {
  setup();
  await mgr.pairing.onUnknownSender(stranger("50"));
  await mgr.pairing.onUnknownSender(stranger("50")); // repeat while pending: no new code, no reply
  const [req] = mgr.pairing.pending();
  expect(mgr.pairing.pending()).toHaveLength(1);
  expect(req!.code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
  const toStranger = platform.sent.filter((s) => s.target.chatId === "50");
  expect(toStranger).toHaveLength(1);
  expect(toStranger[0]!.text).toContain(`${req!.code.slice(0, 4)}-${req!.code.slice(4)}`);
  expect(platform.sent.find((s) => s.target.chatId === "1")!.text).toContain("Pairing request from S50 (@s50)");

  await operatorCmd(`/pair approve ${req!.code.toLowerCase().slice(0, 4)}-${req!.code.slice(4).toLowerCase()}`);
  expect(platform.sent.at(-1)!.text).toContain("Paired S50");
  expect(platform.sent.some((s) => s.target.chatId === "50" && s.text.includes("You're paired"))).toBe(true);
  expect(platform.paired).toEqual(["50"]);
  expect(mgr.pairing.pending()).toHaveLength(0);
  // a paired user isn't asked again; restart-style sync restores the set
  platform.paired = [];
  mgr.pairing.sync();
  expect(platform.paired).toEqual(["50"]);
  expect(mgr.pairing.revoke("tg", "50")).toBe(true);
  expect(platform.paired).toEqual([]);
});

test("open requests are capped; deny, unknown and expired codes; disabled pairing ignores strangers", async () => {
  setup({ maxPending: 2 });
  for (const id of ["61", "62", "63"]) await mgr.pairing.onUnknownSender(stranger(id));
  expect(mgr.pairing.pending().map((r) => r.userId).sort()).toEqual(["61", "62"]);
  const code = mgr.pairing.pending().find((r) => r.userId === "61")!.code;
  await operatorCmd(`/pair deny ${code}`);
  expect(platform.sent.at(-1)!.text).toContain("Denied S61");
  await operatorCmd("/pair approve ZZZZ-ZZZZ");
  expect(platform.sent.at(-1)!.text).toContain("no open pairing request");
  // expiry
  const k = `pairing:pending:${mgr.pairing.pending()[0]!.code}`;
  store.set(k, JSON.stringify({ ...JSON.parse(store.get(k)!), expiresAt: Date.now() - 1 }));
  expect(mgr.pairing.pending()).toHaveLength(0);
  await mgr.stop();
  setup({ enabled: false });
  await mgr.pairing.onUnknownSender(stranger("70"));
  expect(mgr.pairing.pending()).toHaveLength(0);
  expect(platform.sent).toHaveLength(0);
});
