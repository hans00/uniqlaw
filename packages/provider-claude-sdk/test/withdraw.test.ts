// canUseTool aborted by the SDK (the request went away): the pending decision is dropped and core is told, so it
// cancels the chat prompt instead of leaving it waiting.
import { expect, test } from "bun:test";
import { DEFAULT_PERMISSIONS, silentLogger, type AgentEvent, type SessionSpec } from "@uniqlaw/core";
import { ClaudeSdkSession } from "../src/session.ts";

test("an aborted canUseTool emits permission_withdrawn and resolves deny", async () => {
  const spec = { sessionId: "s", cwd: "/tmp", instanceId: "t", env: {}, systemPrompt: { fragments: [] },
    profile: { name: "p", provider: "claude-sdk", permissions: DEFAULT_PERMISSIONS, options: {} } } as SessionSpec;
  const s = new ClaudeSdkSession(spec, {} as never, silentLogger);
  const ac = new AbortController();
  const p = (s as unknown as { onCanUseTool: (t: string, i: unknown, o: unknown) => Promise<{ behavior: string }> })
    .onCanUseTool("Bash", { command: "ls" }, { signal: ac.signal, toolUseID: "tu1", suggestions: [] });
  ac.abort();
  expect((await p).behavior).toBe("deny");
  const seen: AgentEvent[] = [];
  const it = s.events[Symbol.asyncIterator]();
  for (let i = 0; i < 2; i++) seen.push((await it.next()).value as AgentEvent);
  expect(seen.map((e) => e.type)).toEqual(["permission_request", "permission_withdrawn"]);
  expect(seen[1]).toEqual({ type: "permission_withdrawn", id: "tu1" });
});
