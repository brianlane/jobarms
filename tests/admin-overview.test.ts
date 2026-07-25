import { describe, expect, it } from "vitest";
import {
  formatCents,
  ingestStale,
  monthLabel,
  monthsBetween,
  pct,
  planOf,
  PLAN_PRICE_CENTS,
  quotaPressure,
  ratePct,
  summarizeAiUsage,
  summarizeApplications,
  summarizeMrr,
  summarizePlans,
  summarizeUsers,
  subscriptionsByUser,
  type AdminApplicationRow,
  type AdminProfileRow,
  type AdminSubscriptionRow
} from "@/lib/admin/overview";

const NOW = new Date("2026-07-15T12:00:00Z");

function profile(over: Partial<AdminProfileRow> = {}): AdminProfileRow {
  return {
    id: "u1",
    email: "u1@example.com",
    created_at: "2026-07-14T00:00:00Z",
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
    ...over
  };
}

describe("formatting helpers", () => {
  it("formats dollars, thousands, and negatives", () => {
    expect(formatCents(0)).toBe("$0");
    expect(formatCents(1900)).toBe("$19");
    expect(formatCents(1_990_000)).toBe("$19.9k");
    expect(formatCents(-1900)).toBe("-$19");
  });

  it("guards percentages against a zero denominator", () => {
    expect(pct(3, 0)).toBe(0);
    expect(pct(1, 3)).toBe(33);
    expect(ratePct(1, 0)).toBe(0);
    expect(ratePct(1, 3)).toBe(33.3);
  });

  it("labels months counting back in UTC", () => {
    expect(monthLabel(0, NOW)).toBe("Jul");
    expect(monthLabel(6, NOW)).toBe("Jan");
  });

  it("counts calendar months between instants", () => {
    expect(monthsBetween(new Date("2026-01-31T00:00:00Z"), NOW)).toBe(6);
    expect(monthsBetween(new Date("2025-07-01T00:00:00Z"), NOW)).toBe(12);
  });
});

describe("summarizeUsers", () => {
  it("counts recency, onboarding, autonomy, and the month sparkline", () => {
    const users = summarizeUsers(
      [
        profile({ id: "a", created_at: "2026-07-14T00:00:00Z" }),
        profile({ id: "b", created_at: "2026-07-02T00:00:00Z", onboarding_complete: false }),
        profile({ id: "c", created_at: "2026-05-02T00:00:00Z", arm_autonomy: "full_auto" }),
        profile({ id: "d", created_at: "2024-01-01T00:00:00Z" }),
        profile({ id: "e", created_at: "not-a-date" }),
        profile({ id: "f", created_at: "2026-09-01T00:00:00Z" })
      ],
      NOW
    );

    expect(users.total).toBe(6);
    expect(users.new7d).toBe(1);
    expect(users.new30d).toBe(2);
    expect(users.onboarded).toBe(5);
    expect(users.onboardedPct).toBe(83);
    expect(users.fullAuto).toBe(1);
    expect(users.signupsByMonth.map((m) => m.label)).toEqual([
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul"
    ]);
    expect(users.signupsByMonth.at(-1)!.count).toBe(2);
    expect(users.signupsByMonth.find((m) => m.label === "May")!.count).toBe(1);
  });

  it("handles an empty platform", () => {
    const users = summarizeUsers([], NOW);
    expect(users.total).toBe(0);
    expect(users.onboardedPct).toBe(0);
  });
});

describe("plan breakdown", () => {
  it("reads the effective plan, so a past_due row counts as free", () => {
    expect(planOf(null)).toBe("free");
    expect(planOf(sub({ status: "past_due" }))).toBe("free");
    expect(planOf(sub({ plan: "max" }))).toBe("max");
  });

  it("indexes subscriptions by user", () => {
    expect(subscriptionsByUser([sub({ user_id: "z" })]).get("z")?.plan).toBe("premium");
  });

  it("counts plans, statuses, and pending cancellations", () => {
    const plans = summarizePlans(
      [profile({ id: "a" }), profile({ id: "b" }), profile({ id: "c" }), profile({ id: "d" })],
      [
        sub({ user_id: "a" }),
        sub({ user_id: "b", plan: "max", cancel_at_period_end: true }),
        // A free row flagged to cancel must not count as pending churn.
        sub({ user_id: "c", plan: "free", status: "none", cancel_at_period_end: true })
      ]
    );

    expect(plans.counts).toEqual({ free: 2, premium: 1, max: 1 });
    expect(plans.paying).toBe(2);
    expect(plans.pendingCancellations).toBe(1);
    // c carries status "none" explicitly; d has no subscription row at all.
    expect(plans.statusCounts).toEqual({ active: 2, none: 2 });
  });
});

describe("summarizeMrr", () => {
  it("prices each paid plan and splits out pending churn", () => {
    const mrr = summarizeMrr(
      [profile({ id: "a" }), profile({ id: "b" }), profile({ id: "c" })],
      [
        sub({ user_id: "a" }),
        sub({ user_id: "b", plan: "max", cancel_at_period_end: true }),
        sub({ user_id: "c", plan: "premium", status: "canceled" })
      ]
    );

    expect(mrr.premiumCents).toBe(PLAN_PRICE_CENTS.premium);
    expect(mrr.maxCents).toBe(PLAN_PRICE_CENTS.max);
    expect(mrr.totalCents).toBe(PLAN_PRICE_CENTS.premium + PLAN_PRICE_CENTS.max);
    expect(mrr.arpuCents).toBe(Math.round(mrr.totalCents / 2));
    expect(mrr.pendingChurnCents).toBe(PLAN_PRICE_CENTS.max);
  });

  it("is zero with nobody paying", () => {
    const mrr = summarizeMrr([profile()], []);
    expect(mrr.totalCents).toBe(0);
    expect(mrr.arpuCents).toBe(0);
  });
});

describe("summarizeApplications", () => {
  it("counts statuses, sources, applied, and activated users", () => {
    const rows: AdminApplicationRow[] = [
      { id: "a1", user_id: "u1", status: "applied", source: "arm", created_at: "x", applied_at: "y" },
      { id: "a2", user_id: "u1", status: "saved", source: "manual", created_at: "x", applied_at: null },
      { id: "a3", user_id: "u2", status: "saved", source: "arm", created_at: "x", applied_at: null }
    ];
    const apps = summarizeApplications(rows);
    expect(apps.total).toBe(3);
    expect(apps.byStatus).toEqual({ applied: 1, saved: 2 });
    expect(apps.applied).toBe(1);
    expect(apps.fromArm).toBe(2);
    expect(apps.fromManual).toBe(1);
    expect(apps.activatedUsers).toBe(2);
  });
});

describe("summarizeAiUsage", () => {
  it("sums per kind and counts users with real usage", () => {
    const ai = summarizeAiUsage([
      { user_id: "u1", month_key: "2026-07", kind: "resume_parse", used: 2 },
      { user_id: "u1", month_key: "2026-07", kind: "cover_letter", used: 1 },
      { user_id: "u2", month_key: "2026-07", kind: "resume_parse", used: 0 },
      { user_id: "u3", month_key: "2026-07", kind: "future_kind", used: 4 }
    ]);
    expect(ai.byKind.resume_parse).toBe(2);
    expect(ai.byKind.tailor_resume).toBe(0);
    expect(ai.byKind.future_kind).toBe(4);
    expect(ai.total).toBe(7);
    expect(ai.users).toBe(2);
  });
});

describe("quotaPressure", () => {
  const profiles = [
    profile({ id: "heavy", email: "heavy@x.com" }),
    profile({ id: "light", email: "light@x.com" }),
    profile({ id: "maxed", email: "maxed@x.com" })
  ];
  const subscriptions = [sub({ user_id: "maxed", plan: "max" })];

  it("lists only users at or above the threshold, worst first", () => {
    const rows = quotaPressure({
      profiles,
      subscriptions,
      usageByUser: new Map([
        ["heavy", 3],
        ["light", 1],
        ["maxed", 95]
      ])
    });

    expect(rows.map((r) => r.userId)).toEqual(["heavy", "maxed"]);
    expect(rows[0]).toMatchObject({ plan: "free", used: 3, limit: 3, usedPct: 100, window: "month" });
    expect(rows[1]).toMatchObject({ plan: "max", window: "day" });
  });

  it("treats a missing usage row as zero and honors a custom threshold", () => {
    const rows = quotaPressure({
      profiles,
      subscriptions,
      usageByUser: new Map([["light", 1]]),
      thresholdPct: 30
    });
    expect(rows.map((r) => r.userId)).toEqual(["light"]);
  });

  it("breaks ties on absolute usage", () => {
    const rows = quotaPressure({
      profiles: [profile({ id: "a" }), profile({ id: "b" })],
      subscriptions: [],
      usageByUser: new Map([
        ["a", 3],
        ["b", 3]
      ])
    });
    expect(rows).toHaveLength(2);
  });
});

describe("ingestStale", () => {
  it("is stale with no jobs, an unparseable date, or an old sweep", () => {
    expect(ingestStale(null, NOW)).toBe(true);
    expect(ingestStale("nonsense", NOW)).toBe(true);
    expect(ingestStale("2026-07-15T02:00:00Z", NOW)).toBe(true);
  });

  it("is fresh right after a sweep", () => {
    expect(ingestStale("2026-07-15T11:30:00Z", NOW)).toBe(false);
  });
});
