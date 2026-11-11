// Test plugin: fails the daemon start once when `<project>/.fail-next-start` exists (and removes it), so a
// restarted process can be made to fail while the old one's in-process fallback succeeds.
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { definePlugin } from "@uniqlaw/core";

export default definePlugin({
  kind: "scheduler", name: "flaky-start", configSchema: z.object({}),
  create: (ctx) => {
    const marker = join(ctx.projectDir, ".fail-next-start");
    if (existsSync(marker)) { rmSync(marker); throw new Error("flaky-start: failing this start on purpose"); }
    return { start() {}, stop() {} };
  },
});
