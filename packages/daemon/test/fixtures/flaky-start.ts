// Test plugin that misbehaves once, on purpose, when a marker file exists in the project (the marker is removed,
// so the old process's in-process fallback start succeeds):
//  .fail-next-start  → the start throws (the new process exits 1)
//  .hang-next-start  → the start never finishes (scheduler start hangs before runtime.json is written)
//  .slow-next-start  → the start takes <file content> ms
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { definePlugin } from "@uniqlaw/core";

const take = (dir: string, name: string) => {
  const f = join(dir, name);
  if (!existsSync(f)) return undefined;
  const v = readFileSync(f, "utf8");
  rmSync(f);
  return v;
};

export default definePlugin({
  kind: "scheduler", name: "flaky-start", configSchema: z.object({}),
  create: (ctx) => {
    if (take(ctx.projectDir, ".fail-next-start") !== undefined) throw new Error("flaky-start: failing this start on purpose");
    const hang = take(ctx.projectDir, ".hang-next-start") !== undefined;
    const slow = Number(take(ctx.projectDir, ".slow-next-start") ?? 0);
    return {
      async start() {
        if (hang) await new Promise(() => {});
        if (slow) await Bun.sleep(slow);
      },
      stop() {},
    };
  },
});
