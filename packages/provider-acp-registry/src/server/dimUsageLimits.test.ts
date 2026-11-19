import { describe, expect, it } from "vite-plus/test";
import { dimUsageLimits } from "@t3tools/provider-dim/server";

const checkedAt = "2026-11-14T00:00:00.000Z";

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
      checkedAt,
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
      dimUsageLimits({ credits: { unlimited: true, totalUnits: 0 }, windows: [] }, checkedAt),
    ).toEqual({ checkedAt, summary: "Unlimited credits", windows: [] });
    expect(dimUsageLimits({ credits: { totalUnits: 500 }, windows: [] }, checkedAt)).toEqual({
      checkedAt,
      windows: [],
    });
  });
});
