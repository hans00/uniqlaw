// Real claude (UNIQLAW_E2E=1): a daemon restart (gateway down, new gateway on the same port with the same tokens)
// leaves the reattached claude without its MCP link; reconnectMcp drives /mcp → Reconnect and the new gateway sees
// the session initialize. Runs on the "contract" tmux socket, never the live instance's.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChannelManager, DEFAULT_PERMISSIONS, McpGateway, StateStore, createLogger, mcpLinkState, parseSettings, silentLogger, type SessionSpec } from "@uniqlaw/core";
import { ClaudeTmuxProvider, ClaudeTmuxSession, configSchema } from "../src/index.ts";
import { inputBoxText } from "../src/mcp.ts";

const d = process.env.UNIQLAW_E2E === "1" ? describe : describe.skip;
const work = `${import.meta.dir}/../../testkit/.work/claude-tmux`;
const stateDir = `${import.meta.dir}/../../testkit/.work/claude-tmux-state`;

d("claude-tmux MCP recovery", () => {
  test("gateway restart → reattached claude reconnects via /mcp, verified by the new gateway", async () => {
    mkdirSync(work, { recursive: true });
    const tmp = mkdtempSync(join(tmpdir(), "uq-mcp-e2e-"));
    const store = new StateStore(join(tmp, "state.db"));
    const settings = parseSettings({ profiles: { main: { provider: "claude-tmux" } } });
    let mgr!: ChannelManager;
    const mk = () => new McpGateway(() => mgr, silentLogger, join(tmp, "gateway.json"));
    let gw = mk();
    gw.start("127.0.0.1", 0);
    mgr = new ChannelManager({ log: silentLogger, settings, store, projectDir: tmp, instanceId: "contract", providers: new Map(), platforms: new Map(), profiles: new Map(),
      gatewayFor: (k) => gw.endpointFor(k), systemPrompt: async () => ({ fragments: [] }), providerEnv: async () => ({}) });
    const log = createLogger({ file: `${stateDir}/mcp-recovery.log`, level: "debug" });
    const provider = new ClaudeTmuxProvider(configSchema.parse({}), { log, stateDir });
    const key = `mcprec-${Date.now().toString(36)}`;
    const spec: SessionSpec = {
      sessionId: key, cwd: work, instanceId: "contract", env: {}, systemPrompt: { fragments: [] }, mcp: gw.endpointFor(key)!,
      profile: { name: "t", provider: "claude-tmux", model: "haiku", permissions: DEFAULT_PERMISSIONS, options: {} },
    };
    const tmux = provider.tmuxFor("contract");
    const name = provider.sessionName("contract", key);
    try {
      const a = (await provider.open(spec)) as ClaudeTmuxSession;
      for (let i = 0; i < 100 && !gw.link(key)?.lastInitializeAt; i++) await Bun.sleep(100);
      expect(gw.link(key)?.lastInitializeAt).toBeGreaterThan(0);

      // Daemon restart: detach, gateway down for a while, a new gateway on the same port with the same tokens.
      a.detach();
      gw.stop();
      await Bun.sleep(8000);
      gw = mk();
      gw.start("127.0.0.1", 0);
      await Bun.sleep(3000);
      expect(mcpLinkState(gw.link(key))).toBe("unknown"); // claude did not come back by itself

      const b = (await provider.open({ ...spec, providerSessionId: a.providerSessionId })) as ClaudeTmuxSession;
      expect(b.reattached).toBe(true);
      for (let i = 0; i < 50 && !(await b.inspect()).idle; i++) await Bun.sleep(200);
      const r = await b.reconnectMcp((since) => (gw.link(key)?.lastInitializeAt ?? 0) >= since);
      expect(r).toMatchObject({ ok: true, outcome: "reconnected" });
      expect(gw.link(key)!.lastInitializeAt).toBeGreaterThan(0);
      const after = await b.inspect();
      expect(after.process).toBe("alive");
      expect(after.blocker).toBeUndefined();
      expect(inputBoxText(await tmux.captureAnsi(name))).toBe("");
      await b.close();
    } finally {
      await tmux.killSession(name).catch(() => {});
      gw.stop();
      store.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 240_000);
});
