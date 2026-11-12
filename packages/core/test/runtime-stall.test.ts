// Stall watchdog: a quiet turn is abandoned only when there is no liveness signal at all (no tool call in flight, the
// provider not busy and no recent activity), or once the hard ceiling (turn.stallMaxSec) passes without an event.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const core = await import("../src/index.ts");
const { FakePlatform, FakeProvider } = await import("./fakes.ts");
type Script = import("./fakes.ts").Script;
type FakeSession = import("./fakes.ts").FakeSession;

let dir: string;
let store: InstanceType<typeof core.StateStore>;
let managers: InstanceType<typeof core.ChannelManager>[] = [];
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "uq-stall-")); store = new core.StateStore(join(dir, "state.db")); });
afterEach(async () => { for (const m of managers) await m.stop(); managers = []; store.close(); rmSync(dir, { recursive: true, force: true }); });

type Line = { level: string; msg: string; extra?: Record<string, unknown> };
function captureLogger(lines: Line[]): import("../src/index.ts").Logger {
  const l = (level: string) => (msg: string, extra?: Record<string, unknown>) => { lines.push({ level, msg, extra }); };
  const log = { debug: l("debug"), info: l("info"), warn: l("warn"), error: l("error"), child: () => log };
  return log;
}

function setup(script: Script, turn: Record<string, number>) {
  const s = core.parseSettings({ profiles: { main: { provider: "fake" } }, output: { toolStatus: false }, queue: { debounceMs: 0 }, turn });
  const provider = new FakeProvider(script);
  const platform = new FakePlatform();
  const logs: Line[] = [];
  const mgr = new core.ChannelManager({ log: captureLogger(logs), settings: s, store, projectDir: dir, instanceId: "t",
    providers: new Map([["fake", provider]]), platforms: new Map([["tg", platform]]),
    profiles: new Map([["main", { name: "main", provider: "fake", permissions: s.profiles.main!.permissions, options: {} }]]),
    gatewayFor: () => undefined, systemPrompt: async () => ({ fragments: [] }), providerEnv: async () => ({}) });
  managers.push(mgr);
  return { mgr, provider, platform, logs };
}
const inbound = (text: string) => ({ platform: "tg", channelKey: "global", replyTarget: { platform: "tg", chatId: "100" },
  ref: { platform: "tg", chatId: "100", messageId: "m" }, sender: { id: "7", name: "Hans" }, trusted: true, multiparty: false, text, attachments: [], receivedAt: Date.now() });
const until = async (c: () => boolean, ms = 3000) => { const e = Date.now() + ms; while (!c()) { if (Date.now() > e) throw new Error("timeout"); await Bun.sleep(5); } };
const stalled = (p: InstanceType<typeof FakePlatform>) => p.sent.some((m) => m.text.includes("stopped responding"));
const stallLine = (logs: Line[]) => logs.find((l) => l.level === "warn" && l.msg.startsWith("turn stalled"));

test("a long single tool call (tool_start, no tool_end) is not a stall; silence after it ends is", async () => {
  let s!: FakeSession;
  const { mgr, platform, logs } = setup((_i, sess) => { s = sess; sess.emit({ type: "tool_start", id: "b1", name: "Bash", input: "bun test" }); },
    { stallTimeoutSec: 1, stallMaxSec: 0 });
  await mgr.handleInbound(inbound("run the suite"));
  await until(() => !!s);
  await Bun.sleep(2600); // > 2 stall windows with no events, tool still running
  expect(stalled(platform)).toBe(false);
  expect(logs.some((l) => l.msg.startsWith("turn quiet but alive") && (l.extra?.toolsInFlight as string[])?.includes("Bash"))).toBe(true);

  s.emit({ type: "tool_end", id: "b1", ok: true });
  await until(() => stalled(platform), 4000);
  expect(stallLine(logs)!.msg).toContain("no liveness signal");
  expect(stallLine(logs)!.extra).toMatchObject({ toolsInFlight: [], liveness: "not reported by this provider" });
}, 10_000);

test("provider liveness: busy / recent activity keeps the turn; no activity past the threshold stalls it, logging the signals", async () => {
  let s!: FakeSession;
  let live: import("../src/index.ts").Liveness = { busy: true, lastActivityAt: Date.now(), signals: { paneBusy: true, jsonlQuietMs: 0 } };
  const { mgr, platform, logs } = setup((_i, sess) => { s = sess; (sess as FakeSession & { liveness: () => Promise<typeof live> }).liveness = async () => live; },
    { stallTimeoutSec: 1, stallMaxSec: 0 });
  await mgr.handleInbound(inbound("wait for CI"));
  await until(() => !!s);
  await Bun.sleep(1500);
  // not busy any more, but output still moved recently (pane/transcript activity)
  live = { busy: false, lastActivityAt: Date.now(), signals: { paneBusy: false } };
  await Bun.sleep(1200);
  expect(stalled(platform)).toBe(false);

  // no signal at all: not busy, last activity long ago
  live = { busy: false, lastActivityAt: Date.now() - 60_000, signals: { paneBusy: false, jsonlQuietMs: 60_000, paneQuietMs: 60_000 } };
  await until(() => stalled(platform), 4000);
  expect(s.interrupted).toBe(1);
  const line = stallLine(logs)!;
  expect(line.msg).toContain("no liveness signal");
  expect(line.extra!.liveness).toMatchObject({ busy: false, paneBusy: false, jsonlQuietMs: 60_000, paneQuietMs: 60_000 });
}, 10_000);

test("hard ceiling: a turn that looks busy forever (hung tool, spinner ticking) is still abandoned after stallMaxSec", async () => {
  const { mgr, platform, logs } = setup((_i, sess) => {
    (sess as FakeSession & { liveness: () => Promise<unknown> }).liveness = async () => ({ busy: true, lastActivityAt: Date.now(), signals: { paneBusy: true } });
    sess.emit({ type: "tool_start", id: "w", name: "Bash", input: "gh run watch" });
  }, { stallTimeoutSec: 1, stallMaxSec: 2 });
  const t0 = Date.now();
  await mgr.handleInbound(inbound("watch CI"));
  await until(() => stalled(platform), 5000);
  expect(Date.now() - t0).toBeGreaterThanOrEqual(1900);
  expect(stallLine(logs)!.msg).toContain("hard ceiling");
  expect(stallLine(logs)!.extra).toMatchObject({ stallMaxSec: 2, toolsInFlight: ["Bash"] });
}, 10_000);
