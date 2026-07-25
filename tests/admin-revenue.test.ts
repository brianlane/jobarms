import { describe, expect, it } from "vitest";
import {
  conversionStats,
  mrrTrend,
  paymentProblems,
  revenueBreakdown
} from "@/lib/admin/revenue";
import { PLAN_PRICE_CENTS, type AdminProfileRow, type AdminSubscriptionRow } from "@/lib/admin/overview";

const NOW = new Date("2026-07-15T12:00:00Z");

function profile(over: Partial<AdminProfileRow> = {}): AdminProfileRow {
  return {
    id: "u1",
    email: "u1@example.com",
    created_at: "2026-07-01T00:00:00Z",
    onboarding_complete: true,
    arm_autonomy: "review_gate",
    ...over
  };
}

function sub(over: Partial<AdminSubscriptionRow> = {}): AdminSubscriptionRow {
  return {
    user_id: "u1",
    plan: "premium",
    status: "active",
    current_period_end: null,
    cancel_at_period_end: false,
    created_at: "2026-07-05T00:00:00Z",
    ...over
  };
}

describe("revenueBreakdown", () => {
  it("splits revenue by plan and separates revenue on its way out", () => {
    const revenue = revenueBreakdown(
      [
        profile({ id: "a" }),
        profile({ id: "b" }),
        profile({ id: "c" }),
        profile({ id: "d" })
      ],
      [
        sub({ user_id: "a" }),
        sub({ user_id: "b", plan: "max", cancel_at_period_end: true }),
        // past_due grants free, so it contributes nothing.
        sub({ user_id: "c", status: "past_due" })
      ]
    );

    expect(revenue.byPlan.premium).toEqual({ users: 1, cents: PLAN_PRICE_CENTS.premium });
    expect(revenue.byPlan.max).toEqual({ users: 1, cents: PLAN_PRICE_CENTS.max });
    expect(revenue.byPlan.free.users).toBe(2);
    expect(revenue.totalCents).toBe(PLAN_PRICE_CENTS.premium + PLAN_PRICE_CENTS.max);
    expect(revenue.payingUsers).toBe(2);
    expect(revenue.arpuCents).toBe(Math.round(revenue.totalCents / 2));
    expect(revenue.pendingChurnCents).toBe(PLAN_PRICE_CENTS.max);
    expect(revenue.pendingChurnUsers).toBe(1);
  });

  it("is zero with nobody paying", () => {
    const revenue = revenueBreakdown([profile()], []);
    expect(revenue.totalCents).toBe(0);
    expect(revenue.arpuCents).toBe(0);
  });

  it("ignores a cancel flag on a free row", () => {
    const revenue = revenueBreakdown(
      [profile()],
      [sub({ plan: "free", status: "none", cancel_at_period_end: true })]
    );
    expect(revenue.pendingChurnUsers).toBe(0);
  });
});

describe("conversionStats", () => {
  it("reports the rate and the median time to convert", () => {
    const stats = conversionStats(
      [
        profile({ id: "fast", created_at: "2026-07-01T00:00:00Z" }),
        profile({ id: "slow", created_at: "2026-06-01T00:00:00Z" }),
        profile({ id: "never" }),
        profile({ id: "free-row" })
      ],
      [
        sub({ user_id: "fast", created_at: "2026-07-03T00:00:00Z" }),
        sub({ user_id: "slow", created_at: "2026-06-21T00:00:00Z" }),
        sub({ user_id: "free-row", plan: "free", status: "none" })
      ]
    );

    expect(stats.signups).toBe(4);
    expect(stats.converted).toBe(2);
    expect(stats.conversionRatePct).toBe(50);
    // Gaps of 2 and 20 days; the median of an even sample takes the upper middle.
    expect(stats.medianDaysToConvert).toBe(20);
  });

  it("ignores unreadable or backwards dates rather than reporting a negative", () => {
    const stats = conversionStats(
      [
        profile({ id: "backwards", created_at: "2026-07-10T00:00:00Z" }),
        profile({ id: "unreadable", created_at: "nonsense" })
      ],
      [
        sub({ user_id: "backwards", created_at: "2026-07-01T00:00:00Z" }),
        sub({ user_id: "unreadable", created_at: "2026-07-02T00:00:00Z" })
      ]
    );
    expect(stats.converted).toBe(2);
    expect(stats.medianDaysToConvert).toBeNull();
  });

  it("handles a subscription row with no creation date", () => {
    const stats = conversionStats([profile()], [sub({ created_at: null })]);
    expect(stats.converted).toBe(1);
    expect(stats.medianDaysToConvert).toBeNull();
  });

  it("is zero on an empty platform", () => {
    expect(conversionStats([], []).conversionRatePct).toBe(0);
  });
});

describe("mrrTrend", () => {
  it("counts a subscription from the month it was created", () => {
    const trend = mrrTrend(
      [profile({ id: "old" }), profile({ id: "new" })],
      [
        sub({ user_id: "old", created_at: "2026-05-10T00:00:00Z" }),
        sub({ user_id: "new", created_at: "2026-07-10T00:00:00Z" })
      ],
      3,
      NOW
    );

    expect(trend.map((point) => point.label)).toEqual(["May", "Jun", "Jul"]);
    expect(trend[0]).toMatchObject({ cents: PLAN_PRICE_CENTS.premium, payingUsers: 1 });
    expect(trend[1]).toMatchObject({ payingUsers: 1 });
    expect(trend[2]).toMatchObject({ cents: PLAN_PRICE_CENTS.premium * 2, payingUsers: 2 });
  });

  it("assumes a row with no creation date was always there", () => {
    const trend = mrrTrend([profile()], [sub({ created_at: null })], 2, NOW);
    expect(trend.every((point) => point.payingUsers === 1)).toBe(true);
  });

  it("excludes free users entirely and defaults to six months", () => {
    const trend = mrrTrend([profile()], [sub({ plan: "free", status: "none" })]);
    expect(trend).toHaveLength(6);
    expect(trend.every((point) => point.cents === 0)).toBe(true);
  });
});

describe("paymentProblems", () => {
  it("lists broken billing newest first, with what the user actually gets", () => {
    const problems = paymentProblems(
      [profile({ id: "a", email: "a@x.com" }), profile({ id: "b", email: "b@x.com" })],
      [
        sub({ user_id: "a", status: "past_due", updated_at: "2026-07-10T00:00:00Z" }),
        sub({ user_id: "b", status: "unpaid", updated_at: "2026-07-14T00:00:00Z" }),
        sub({ user_id: "c", status: "active", updated_at: "2026-07-15T00:00:00Z" })
      ]
    );

    expect(problems.map((problem) => problem.userId)).toEqual(["b", "a"]);
    expect(problems[1]).toMatchObject({
      email: "a@x.com",
      status: "past_due",
      recordedPlan: "premium",
      grantedPlan: "free"
    });
  });

  it("sorts around rows with no timestamp and no known email", () => {
    const problems = paymentProblems(
      [],
      [
        sub({ user_id: "undated", status: "incomplete", updated_at: null }),
        sub({ user_id: "dated", status: "past_due", updated_at: "2026-07-14T00:00:00Z" }),
        sub({ user_id: "also-undated", status: "unpaid", updated_at: null })
      ]
    );
    // A dated row outranks undated ones, which stay behind it in input order.
    expect(problems.map((problem) => problem.userId)).toEqual([
      "dated",
      "undated",
      "also-undated"
    ]);
    expect(problems[1]).toMatchObject({ email: "", updatedAt: null });
  });

  it("is empty when billing is healthy", () => {
    expect(paymentProblems([profile()], [sub()])).toEqual([]);
  });
});
