// A platform whose start() hangs until aborted and whose stop() never returns (an unresponsive chat API).
import { z } from "zod";
import { definePlugin, type InboundSink } from "@uniqlaw/core";
import { FakePlatform } from "../../../core/test/fakes.ts";

export const hanging: { starts: number; stops: number } = { starts: 0, stops: 0 };
export default definePlugin({
  kind: "platform", name: "hang", configSchema: z.object({ token: z.string() }),
  create: () => {
    const p = new FakePlatform();
    p.name = "hang";
    p.start = (_sink?: InboundSink, signal?: AbortSignal) => {
      hanging.starts++;
      return new Promise<void>((_, rej) => signal?.addEventListener("abort", () => rej(new Error("aborted")), { once: true }));
    };
    p.stop = () => { hanging.stops++; return new Promise<void>(() => {}); };
    return p;
  },
});
