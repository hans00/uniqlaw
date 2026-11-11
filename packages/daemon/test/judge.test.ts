// Approval judge providers the daemon can build (permissions.approval.judge.provider).
import { expect, test } from "bun:test";
import { parseSettings } from "@uniqlaw/core";
import { JUDGE_PROVIDERS } from "../src/index.ts";

const cfg = (judge: Record<string, unknown>) =>
  parseSettings({ profiles: { main: { provider: "x", permissions: { approval: { judge: { provider: "typesafe-jev", mode: "shadow", ...judge } } } } } })
    .profiles.main!.permissions.approval.judge!;

test("typesafe-jev needs a credential; the key is resolved on first use, not at startup", async () => {
  await expect(JUDGE_PROVIDERS["typesafe-jev"]!(cfg({}))).rejects.toThrow(/judge.credential/);
  // An unset env ref must not stop the daemon from starting: it fails (and escalates) per request.
  const j = await JUDGE_PROVIDERS["typesafe-jev"]!(cfg({ credential: { env: "UQ_TEST_UNSET_TYPESAFE_KEY" } }));
  expect(j.name).toBe("Jev");
  await expect(j.judge({} as never, new AbortController().signal)).rejects.toThrow(/UQ_TEST_UNSET_TYPESAFE_KEY is not set/);
});
