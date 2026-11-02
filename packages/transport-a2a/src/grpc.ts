// A2A v1.0 gRPC binding. One grpc-js server for all exposed profiles; the profile is
// selected by the A2A `tenant` field (each profile's card advertises its GRPC interface
// with tenant = profile name, and the SDK client applies it automatically).
// @grpc/grpc-js runs under Bun (verified: unary + server streaming).
import type { DefaultRequestHandler } from "@a2a-js/sdk/server";
import type { A2ARequestHandler } from "@a2a-js/sdk/server";

export interface GrpcAuth {
  /** Returns the caller name for a valid bearer token, undefined if invalid; tokens empty = open. */
  check(authorization: string | undefined): { ok: boolean; name?: string };
}

type Handlers = Map<string, { handler: DefaultRequestHandler; card: unknown }>;

/** Routes every A2A call to the profile named by `params.tenant`. */
function routingHandler(profiles: Handlers): A2ARequestHandler {
  const pick = (tenant: string | undefined) => {
    const name = tenant || (profiles.size === 1 ? [...profiles.keys()][0] : undefined);
    const p = name ? profiles.get(name) : undefined;
    if (!p) throw new Error(`unknown A2A tenant "${tenant ?? ""}" (expected one of: ${[...profiles.keys()].join(", ")})`);
    return p.handler;
  };
  const first = () => [...profiles.values()][0]!;
  // Every request message carries `tenant`; route on it.
  const route = <K extends keyof A2ARequestHandler>(k: K) =>
    ((params: { tenant?: string }, ctx: unknown) => (pick(params?.tenant)[k] as (...a: unknown[]) => unknown)(params, ctx)) as unknown as A2ARequestHandler[K];
  return {
    getAgentCard: () => first().handler.getAgentCard(),
    getAuthenticatedExtendedAgentCard: route("getAuthenticatedExtendedAgentCard"),
    sendMessage: route("sendMessage"),
    sendMessageStream: route("sendMessageStream"),
    getTask: route("getTask"),
    cancelTask: route("cancelTask"),
    createTaskPushNotificationConfig: route("createTaskPushNotificationConfig"),
    getTaskPushNotificationConfig: route("getTaskPushNotificationConfig"),
    listTaskPushNotificationConfigs: route("listTaskPushNotificationConfigs"),
    deleteTaskPushNotificationConfig: route("deleteTaskPushNotificationConfig"),
    resubscribe: route("resubscribe"),
    listTasks: route("listTasks"),
  };
}

export async function startGrpcServer(o: { host: string; port: number; profiles: Handlers; auth: GrpcAuth }): Promise<{ port: number; stop: () => void }> {
  const grpc = await import("@grpc/grpc-js");
  const { grpcService, A2AService } = await import("@a2a-js/sdk/server/grpc");
  const server = new grpc.Server();
  server.addService(A2AService, grpcService({
    requestHandler: routingHandler(o.profiles),
    userBuilder: async (call) => {
      const raw = call.metadata.get("authorization")[0];
      const r = o.auth.check(raw === undefined ? undefined : String(raw));
      if (!r.ok) {
        const err = new Error("unauthorized") as Error & { code: number };
        err.code = grpc.status.UNAUTHENTICATED;
        throw err;
      }
      return r.name
        ? { isAuthenticated: true, userName: r.name }
        : { isAuthenticated: false, userName: "" };
    },
  }) as never);
  const port = await new Promise<number>((res, rej) =>
    server.bindAsync(`${o.host.includes(":") ? `[${o.host}]` : o.host}:${o.port}`, grpc.ServerCredentials.createInsecure(), (e, p) => (e ? rej(e) : res(p))));
  return { port, stop: () => server.forceShutdown() };
}
