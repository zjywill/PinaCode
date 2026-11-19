import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { DimRpcError } from "./transport.ts";
import { dimUsageLimitsForProfile, readDimAccountUsage } from "./usageLimits.ts";

const checkedAt = "2026-01-01T00:00:00.000Z";

const accountError = (appError?: string) =>
  new DimRpcError({
    method: "account.usage",
    code: -32000,
    detail: "account failed",
    ...(appError === undefined ? {} : { appError }),
  });

describe("Dim usage limits", () => {
  it.effect("maps account.usage windows and credits", () =>
    Effect.gen(function* () {
      const limits = yield* readDimAccountUsage(
        () =>
          Effect.succeed({
            subscriptionId: 7,
            plan: { name: "Dim Pro", priceInterval: "month" },
            credits: {
              totalUnits: 100,
              remainingUnits: 40,
              resetsAt: "2026-02-01T00:00:00.000Z",
            },
            windows: [{ durationHours: 5, tokenCap: 100, tokenUsed: 25 }],
          }),
        checkedAt,
      );
      assert.deepEqual(
        limits?.windows.map((window) => window.id),
        ["dim-5h", "dim-credits"],
      );
      assert.strictEqual(limits?.windows[0]?.usedPercent, 25);
      assert.strictEqual(limits?.summary, "Dim Pro · 40 / 100 credits left");
      assert.strictEqual(limits?.credentialFingerprint, "dim-subscription-7");
    }),
  );

  it("reports other profiles as unsupported", () => {
    assert.strictEqual(dimUsageLimitsForProfile("product", checkedAt), undefined);
    assert.strictEqual(
      dimUsageLimitsForProfile("configured", checkedAt)?.unavailable?.reason,
      "unsupported",
    );
  });

  it.effect("omits limits when no account can report them", () =>
    Effect.gen(function* () {
      const limits = yield* readDimAccountUsage(
        () => Effect.fail(accountError("account_required")),
        checkedAt,
      );
      assert.strictEqual(limits, undefined);
    }),
  );

  it.effect("reports a probe failure when account.usage fails", () =>
    Effect.gen(function* () {
      const limits = yield* readDimAccountUsage(() => Effect.fail(accountError()), checkedAt);
      assert.strictEqual(limits?.unavailable?.reason, "probeFailed");
    }),
  );

  it.effect("reports a probe failure when account.usage is unreadable", () =>
    Effect.gen(function* () {
      const limits = yield* readDimAccountUsage(
        () => Effect.succeed({ windows: "nope" }),
        checkedAt,
      );
      assert.strictEqual(limits?.unavailable?.reason, "probeFailed");
    }),
  );
});
