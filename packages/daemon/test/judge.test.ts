// Approval judge providers the daemon can build (permissions.approval.judge.provider).
import { expect, test } from "bun:test";
import { parseSettings } from "@uniqlaw/core";
import { JUDGE_PROVIDERS, judgeOptions } from "../src/index.ts";

const cfg = (judge: Record<string, unknown>) =>
  parseSettings({ profiles: { main: { provider: "x", permissions: { approval: { judge: { provider: "typesafe-jev", mode: "shadow", ...judge } } } } } })
    .profiles.main!.permissions.approval.judge!;

test("typesafe-jev needs a credential; the key is resolved on first use, not at startup", async () => {
  await expect(JUDGE_PROVIDERS["typesafe-jev"]!(cfg({}))).rejects.toThrow(/credential/);
  // An unset env ref must not stop the daemon from starting: it fails (and escalates) per request.
  const j = await JUDGE_PROVIDERS["typesafe-jev"]!(cfg({ credential: { env: "UQ_TEST_UNSET_TYPESAFE_KEY" } }));
  expect(j.name).toBe("Jev");
  await expect(j.judge({} as never, new AbortController().signal)).rejects.toThrow(/UQ_TEST_UNSET_TYPESAFE_KEY is not set/);
});

test("judge.provider selects the backend; backend settings live in judge.options (credential/model shorthands still work)", async () => {
  const fromOptions = cfg({ provider: "typesafe-compatible", options: { baseUrl: "http://ts.local", model: "m1" } });
  const j1 = await JUDGE_PROVIDERS["typesafe-compatible"]!(fromOptions);
  expect((j1 as unknown as { o: { baseUrl: string; model: string } }).o).toMatchObject({ baseUrl: "http://ts.local", model: "m1" });
  expect(judgeOptions(cfg({ credential: { env: "A" }, model: "short", options: { model: "long" } }))).toEqual({ credential: { env: "A" }, model: "long" });
  const j2 = await JUDGE_PROVIDERS["openai-decision"]!(cfg({ provider: "openai-decision", options: { credential: { env: "UQ_TEST_UNSET_OPENAI_KEY" } } }));
  expect(j2.name).toBe("Luna");
  await expect(j2.judge({} as never, new AbortController().signal)).rejects.toThrow(/UQ_TEST_UNSET_OPENAI_KEY is not set/);
  await expect(JUDGE_PROVIDERS["typesafe-compatible"]!(cfg({ provider: "typesafe-compatible" }))).rejects.toThrow(/baseUrl/);
});
