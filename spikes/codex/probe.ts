import { AppServer } from "./rpc.ts";
const s = new AppServer();
s.onNotification = (m) => console.log("notif", m);
console.log("init", JSON.stringify(await s.init()).slice(0, 300));
const ml: any = await s.request("model/list", {});
console.log(JSON.stringify(ml.data?.map((m: any) => ({ id: m.id ?? m.model, d: m.displayName, def: m.isDefault, efforts: m.supportedReasoningEfforts?.map((e: any) => e.reasoningEffort ?? e) })) ?? ml, null, 0).slice(0, 2500));
await s.close();
