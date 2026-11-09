// Daemon-restart path: detach() leaves tmux running; open() with the same providerSessionId reattaches.
import { expect, test, describe } from "bun:test";
import { mkdirSync } from "node:fs";
import { DEFAULT_PERMISSIONS, createLogger, type SessionSpec } from "@uniqlaw/core";
import { EventCollector } from "@uniqlaw/testkit";
import { ClaudeTmuxProvider, ClaudeTmuxSession, configSchema } from "../src/index.ts";

const d = process.env.UNIQLAW_E2E === "1" ? describe : describe.skip;
const work = `${import.meta.dir}/../../testkit/.work/claude-tmux`;
const stateDir = `${import.meta.dir}/../../testkit/.work/claude-tmux-state`;

d("claude-tmux reattach", () => {
  test("detach + reopen reattaches to the live tmux session", async () => {
    mkdirSync(work, { recursive: true });
    const log = createLogger({ file: `${stateDir}/reattach.log`, level: "debug" });
    const provider = new ClaudeTmuxProvider(configSchema.parse({}), { log, stateDir });
    const spec: SessionSpec = {
      sessionId: `reattach-${Date.now().toString(36)}`, cwd: work, instanceId: "contract", env: {},
      systemPrompt: { fragments: [] },
      profile: { name: "t", provider: "claude-tmux", model: "haiku", permissions: DEFAULT_PERMISSIONS, options: {} },
    };
    const a = (await provider.open(spec)) as ClaudeTmuxSession;
    const ea = new EventCollector(a);
    await a.send({ text: "Remember the word KIWI. Reply with exactly: OK", attachments: [] });
    await ea.turnEnd(120_000);
    a.detach();
    const name = provider.sessionName("contract", spec.sessionId);
    expect(await provider.tmuxFor("contract").hasSession(name)).toBe(true);

    const b = await provider.open({ ...spec, providerSessionId: a.providerSessionId });
    const eb = new EventCollector(b);
    const m = eb.mark();
    await b.send({ text: "What word did I ask you to remember? Answer with just the word.", attachments: [] });
    await eb.turnEnd(120_000, m);
    expect(eb.texts(m)).toContain("KIWI");
    await b.close();
    expect(await provider.tmuxFor("contract").hasSession(name)).toBe(false);
  }, 300_000);

  test("reattach with changed profile flags respawns claude with --resume and keeps the conversation", async () => {
    mkdirSync(work, { recursive: true });
    const log = createLogger({ file: `${stateDir}/reattach.log`, level: "debug" });
    const provider = new ClaudeTmuxProvider(configSchema.parse({}), { log, stateDir });
    const spec: SessionSpec = {
      sessionId: `restale-${Date.now().toString(36)}`, cwd: work, instanceId: "contract", env: {},
      systemPrompt: { fragments: [] },
      profile: { name: "t", provider: "claude-tmux", model: "haiku", permissions: DEFAULT_PERMISSIONS, options: { permissionMode: "default" } },
    };
    const tmux = provider.tmuxFor("contract");
    const name = provider.sessionName("contract", spec.sessionId);
    const a = (await provider.open(spec)) as ClaudeTmuxSession;
    const ea = new EventCollector(a);
    await a.send({ text: "Remember the word PLUM. Reply with exactly: OK", attachments: [] });
    await ea.turnEnd(120_000);
    a.detach();
    const pid = async () => (await Bun.$`tmux -L ${tmux.socket} display -p -t ${name} '#{pane_pid}'`.text()).trim();
    const before = await pid();

    // Profile changed while the daemon was down (here: permission mode).
    const b = await provider.open({ ...spec, providerSessionId: a.providerSessionId,
      profile: { ...spec.profile, options: { permissionMode: "acceptEdits" } } });
    const eb = new EventCollector(b);
    const m = eb.mark();
    await b.send({ text: "What word did I ask you to remember? Answer with just the word.", attachments: [] });
    await eb.turnEnd(120_000, m);
    expect(eb.texts(m)).toContain("PLUM");
    expect(await pid()).not.toBe(before);
    expect(await Bun.$`tmux -L ${tmux.socket} capture-pane -p -t ${name}`.text()).toContain("accept edits");
    await b.close();
  }, 300_000);
});
