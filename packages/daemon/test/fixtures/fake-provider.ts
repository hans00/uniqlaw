import { z } from "zod";
import { definePlugin } from "@uniqlaw/core";
import { FakeProvider } from "../../../core/test/fakes.ts";

export const lastSpecs: unknown[] = [];
export default definePlugin({
  kind: "provider", name: "fake", configSchema: z.object({}).passthrough(),
  create: () => {
    const p = new FakeProvider((input, s) => {
      s.emit({ type: "text", segmentId: "a", final: `echo: ${input.text.split("\n").at(-1)}` }, { type: "turn_end", turnId: s.turnId(), reason: "done" });
    });
    const open = p.open.bind(p);
    p.open = async (spec) => { lastSpecs.push(spec); return open(spec); };
    return p;
  },
});
