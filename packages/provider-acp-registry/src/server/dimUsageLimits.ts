import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import {
  clampPercent,
  makeUnavailableUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import * as NodeNet from "node:net";
import * as Digest from "effect/crypto/Digest";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const units = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const decodeUsage = Schema.decodeUnknownSync(
  Schema.Struct({
    subscriptionId: Schema.optional(units),
    plan: Schema.optional(
      Schema.Struct({
        name: Schema.optional(Schema.String),
        priceInterval: Schema.optional(Schema.String),
      }),
    ),
    credits: Schema.optional(
      Schema.Struct({
        usedUnits: Schema.optional(units),
        totalUnits: Schema.optional(units),
        remainingUnits: Schema.optional(units),
        unlimited: Schema.optional(Schema.Boolean),
        resetsAt: Schema.optional(Schema.String),
      }),
    ),
    windows: Schema.Array(
      Schema.Struct({
        durationHours: units,
        tokenCap: units,
        tokenUsed: units,
        expiresAt: Schema.optional(Schema.String),
      }),
    ),
  }),
);

function resetTime(value?: string) {
  const date = value ? DateTime.make(value) : Option.none();
  return Option.isSome(date) ? { resetsAt: DateTime.formatIso(date.value) } : {};
}

export function dimUsageLimits(raw: unknown, checkedAt: string): ServerProviderUsageLimits {
  const { windows, credits, plan, subscriptionId } = decodeUsage(raw);
  const limits: ServerProviderUsageWindow[] = windows
    .filter((w) => w.durationHours > 0 && w.tokenCap > 0)
    .map((w) => ({
      id: `dim-${w.durationHours}h`,
      kind: w.durationHours === 168 ? "weekly" : w.durationHours === 5 ? "session" : "other",
      label: `Dim · ${w.durationHours}h`,
      usedPercent: clampPercent((w.tokenUsed / w.tokenCap) * 100),
      windowDurationMins: w.durationHours * 60,
      ...resetTime(w.expiresAt),
    }));
  const total = credits?.totalUnits;
  const remaining =
    credits?.remainingUnits ??
    (total !== undefined && credits?.usedUnits !== undefined
      ? Math.max(0, total - credits.usedUnits)
      : undefined);
  if (!credits?.unlimited && total && remaining !== undefined) {
    limits.push({
      id: "dim-credits",
      kind: plan?.priceInterval === "month" ? "monthly" : "other",
      label: "Dim · Subscription credits",
      usedPercent: clampPercent((1 - remaining / total) * 100),
      ...resetTime(credits?.resetsAt),
    });
  }
  const balance = credits?.unlimited
    ? "Unlimited credits"
    : remaining !== undefined
      ? `${remaining.toLocaleString("en-US")}${total === undefined ? "" : ` / ${total.toLocaleString("en-US")}`} credits left`
      : undefined;
  const summary = [plan?.name, balance].filter(Boolean).join(" · ");
  return {
    checkedAt,
    windows: limits,
    ...(summary ? { summary } : {}),
    ...(subscriptionId ? { credentialFingerprint: `dim-subscription-${subscriptionId}` } : {}),
  };
}

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
        send(id, "account.usage", { providerId: "dimcode-api-oauth" });
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
  const windows = (yield* HostProcess.Platform) === "win32";
  const userHome = windows ? environment.USERPROFILE : environment.HOME;
  const home =
    flag >= 0
      ? args[flag + 1]
      : (environment.DIMCODE_HOME ?? (userHome && path.join(userHome, ".dimcode-alpha")));
  if (!home || args.includes("--model-config")) return undefined;
  const nativeHome = path.resolve(cwd, home, "rust");
  const probe = Effect.gen(function* () {
    let endpoint = path.join(nativeHome, "daemon.sock");
    if (windows) {
      const fs = yield* FileSystem.FileSystem;
      const digest = yield* Digest.Digest;
      // Dim hashes Rust's canonical (extended-length) directory name for Windows pipes.
      const canonical = path.toNamespacedPath(yield* fs.realPath(nativeHome));
      const key = yield* digest.digestHex(
        Digest.sha256,
        new TextEncoder().encode("dimcode:" + canonical),
      );
      endpoint = String.raw`\\.\pipe\dim-rust-` + key.slice(0, 32);
    }
    return yield* Effect.tryPromise({
      try: (signal) => queryUsage(endpoint, checkedAt, signal),
      catch: () => "Dim account limits unavailable" as const,
    });
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
