import { makeUnavailableUsageLimits } from "@t3tools/provider-core/server/usageLimits";
import {
  DIM_USAGE_PROVIDER_ID,
  dimDaemonEndpoint,
  dimUsageLimits,
} from "@t3tools/provider-dim/server";
import * as NodeNet from "node:net";
import * as Path from "effect/Path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const decodeReply = Schema.decodeUnknownSync(
  Schema.Struct({
    id: Schema.optional(Schema.Number),
    result: Schema.optional(Schema.Unknown),
    error: Schema.optional(
      Schema.Struct({
        data: Schema.optional(Schema.Struct({ appError: Schema.optional(Schema.String) })),
      }),
    ),
  }),
);
const decodeHello = Schema.decodeUnknownSync(
  Schema.Struct({
    protocolVersion: Schema.Literal(3),
    daemonProfile: Schema.Struct({ kind: Schema.String }),
    features: Schema.Array(Schema.String),
  }),
);

async function queryUsage(endpoint: string, checkedAt: string, signal: AbortSignal) {
  const socket = NodeNet.createConnection({ path: endpoint, signal });
  const send = (id: number, method: string, params: Record<string, unknown>) =>
    socket.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  try {
    send(1, "hello", { protocolVersion: 3, clientKind: "other", clientName: "T3 Code" });
    let id = 1;
    let pending = "";
    socket.setEncoding("utf8");
    for await (const chunk of socket) {
      pending += chunk;
      if (pending.length > 1024 * 1024) throw new Error("Dim usage reply exceeds size limit");
      let end: number;
      while ((end = pending.indexOf("\n")) >= 0) {
        const reply = decodeReply(JSON.parse(pending.slice(0, end)));
        pending = pending.slice(end + 1);
        if (reply.id !== id) continue;
        if (reply.error) {
          const code = reply.error.data?.appError;
          if (code === "account_required" || code === "account_provider_unavailable")
            return undefined;
          throw new Error("Dim account query failed");
        }
        if (id === 2) return dimUsageLimits(reply.result, checkedAt);
        const hello = decodeHello(reply.result);
        if (hello.daemonProfile.kind !== "product" || !hello.features.includes("account.usage"))
          return undefined;
        id = 2;
        send(id, "account.usage", { providerId: DIM_USAGE_PROVIDER_ID });
      }
    }
    throw new Error("Dim daemon disconnected");
  } finally {
    socket.destroy();
  }
}

export const readDimUsageLimits = Effect.fn("DimCode.readUsageLimits")(function* (
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  cwd: string,
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const flag = args.lastIndexOf("--home");
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const userHome = platform === "win32" ? environment.USERPROFILE : environment.HOME;
  const home =
    flag >= 0
      ? args[flag + 1]
      : (environment.DIMCODE_HOME ?? (userHome && path.join(userHome, ".dimcode-alpha")));
  if (!home || args.includes("--model-config")) return undefined;
  const nativeHome = path.resolve(cwd, home, "rust");
  const endpoint = dimDaemonEndpoint({ nativeHome, platform });
  const probe = Effect.tryPromise({
    try: (signal) => queryUsage(endpoint, checkedAt, signal),
    catch: () => "Dim account limits unavailable" as const,
  });
  return yield* probe.pipe(
    Effect.timeout("8 seconds"),
    Effect.orElseSucceed(() =>
      makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: "Could not read Dim account limits. Check that DimCode is running and refresh.",
      }),
    ),
  );
});
