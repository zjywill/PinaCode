import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import {
  clampPercent,
  makeUnavailableUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { DimRpcError, type DimConnectionError } from "./transport.ts";

/** The provider whose subscription `account.usage` reports. */
export const DIM_USAGE_PROVIDER_ID = "dimcode-api-oauth";

const isDimRpcError = Schema.is(DimRpcError);

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

/** Profiles that cannot report an account say so; only the product daemon has subscriptions. */
export const dimUsageLimitsForProfile = (profile: string, checkedAt: string) =>
  profile === "product"
    ? undefined
    : makeUnavailableUsageLimits({
        checkedAt,
        reason: "unsupported",
        message: "Dim subscription usage is only available from the Dim product daemon.",
      });

const unavailable = (checkedAt: string, message: string) =>
  makeUnavailableUsageLimits({ checkedAt, reason: "probeFailed", message });

/** `account.usage` over an attached daemon; undefined when the account cannot report. */
export const readDimAccountUsage = Effect.fn("DimUsage.readAccountUsage")(function* (
  request: (
    method: string,
    params?: Record<string, unknown>,
  ) => Effect.Effect<unknown, DimConnectionError>,
  checkedAt: string,
) {
  const result = yield* request("account.usage", { providerId: DIM_USAGE_PROVIDER_ID }).pipe(
    Effect.result,
  );
  if (result._tag === "Failure") {
    const appError = isDimRpcError(result.failure) ? result.failure.appError : undefined;
    if (appError === "account_required" || appError === "account_provider_unavailable") {
      return undefined;
    }
    return unavailable(
      checkedAt,
      "Could not read Dim account limits. Check that DimCode is running and refresh.",
    );
  }
  return yield* Effect.try({
    try: () => dimUsageLimits(result.success, checkedAt),
    catch: () => "unreadable" as const,
  }).pipe(
    Effect.orElseSucceed(() => unavailable(checkedAt, "Dim returned unreadable account limits.")),
  );
});
