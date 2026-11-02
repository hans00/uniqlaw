import { z } from "zod";
import { definePlugin, type InboundSink } from "@uniqlaw/core";
import { FakePlatform } from "../../../core/test/fakes.ts";

export const instances: (FakePlatform & { sink?: InboundSink })[] = [];
export default definePlugin({
  kind: "platform", name: "tg", configSchema: z.object({ token: z.string() }),
  create: () => {
    const p = new FakePlatform() as FakePlatform & { sink?: InboundSink };
    p.start = async (sink: InboundSink) => { p.sink = sink; };
    instances.push(p);
    return p;
  },
});
