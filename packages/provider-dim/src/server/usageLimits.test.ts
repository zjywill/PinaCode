import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { DimRpcError } from "./transport.ts";
import { dimUsageLimits, dimUsageLimitsForProfile, readDimAccountUsage } from "./usageLimits.ts";

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

const summaryCheckedAt = "2026-11-14T00:00:00.000Z";

describe("Dim account usage", () => {
  it("preserves the credit balance alongside token windows and reset times", () => {
    const limits = dimUsageLimits(
      {
        subscriptionId: 42,
        plan: { name: "Pro", priceInterval: "month" },
        credits: { totalUnits: 10000, usedUnits: 1, resetsAt: "2026-12-01T08:00:00+08:00" },
        windows: [
          { durationHours: 168, tokenUsed: 20, tokenCap: 50 },
          { durationHours: 5, tokenUsed: 3, tokenCap: 0 },
        ],
      },
      summaryCheckedAt,
    );
    expect(limits).toMatchObject({
      credentialFingerprint: "dim-subscription-42",
      summary: "Pro · 9,999 / 10,000 credits left",
      windows: [
        { kind: "weekly", windowDurationMins: 10080, usedPercent: 40 },
        { kind: "monthly", resetsAt: "2026-12-01T00:00:00.000Z" },
      ],
    });
    expect(limits.windows[1]?.usedPercent).toBeCloseTo(0.01);
  });

  it("keeps unlimited and unreported balances distinct", () => {
    expect(
      dimUsageLimits(
        { credits: { unlimited: true, totalUnits: 0 }, windows: [] },
        summaryCheckedAt,
      ),
    ).toEqual({ checkedAt: summaryCheckedAt, summary: "Unlimited credits", windows: [] });
    expect(dimUsageLimits({ credits: { totalUnits: 500 }, windows: [] }, summaryCheckedAt)).toEqual(
      {
        checkedAt: summaryCheckedAt,
        windows: [],
      },
    );
  });
});
