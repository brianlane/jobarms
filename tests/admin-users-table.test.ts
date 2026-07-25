import { describe, expect, it } from "vitest";
import {
  buildUserRows,
  classifyEngagement,
  filterUserRows,
  isUserSort,
  sortUserRows,
  type AdminUserRow
} from "@/lib/admin/users-table";
import type { AdminProfileRow, AdminSubscriptionRow } from "@/lib/admin/overview";
import type { AdminRunRow } from "@/lib/admin/run-stats";

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

function run(over: Partial<AdminRunRow> = {}): AdminRunRow {
  return {
    id: "r1",
    user_id: "u1",
    application_id: "a1",
    status: "submitted",
    autonomy: "review_gate",
    error: null,
    created_at: "2026-07-14T00:00:00Z",
    updated_at: "2026-07-14T00:05:00Z",
    ...over
  };
}

describe("classifyEngagement", () => {
  it("uses sign-in recency when there is a sign-in", () => {
    expect(
      classifyEngagement({ createdAt: "2026-01-01T00:00:00Z", lastSignInAt: "2026-07-14T00:00:00Z" }, NOW)
    ).toBe("active");
    expect(
      classifyEngagement({ createdAt: "2026-01-01T00:00:00Z", lastSignInAt: "2026-06-20T00:00:00Z" }, NOW)
    ).toBe("cooling");
    expect(
      classifyEngagement({ createdAt: "2026-01-01T00:00:00Z", lastSignInAt: "2026-03-01T00:00:00Z" }, NOW)
    ).toBe("quiet");
  });

  it("calls a fresh signup new and an old one quiet when they never signed in", () => {
    expect(classifyEngagement({ createdAt: "2026-07-14T00:00:00Z", lastSignInAt: null }, NOW)).toBe(
      "new"
    );
    expect(classifyEngagement({ createdAt: "2026-01-01T00:00:00Z", lastSignInAt: null }, NOW)).toBe(
      "quiet"
    );
  });

  it("treats an unreadable sign-in like no sign-in, and an unreadable signup as quiet", () => {
    expect(classifyEngagement({ createdAt: "2026-07-14T00:00:00Z", lastSignInAt: "nope" }, NOW)).toBe(
      "new"
    );
    expect(classifyEngagement({ createdAt: "nope", lastSignInAt: null }, NOW)).toBe("quiet");
  });

  it("defaults to the current instant", () => {
    expect(
      classifyEngagement({ createdAt: new Date().toISOString(), lastSignInAt: null })
    ).toBe("new");
  });
});

describe("buildUserRows", () => {
  const profiles = [
    profile({ id: "u1", email: "one@x.com" }),
    profile({ id: "u2", email: "two@x.com", onboarding_complete: false, arm_autonomy: "full_auto" }),
    profile({ id: "u3", email: "three@x.com" })
  ];
  const subscriptions: AdminSubscriptionRow[] = [
    {
      user_id: "u1",
      plan: "premium",
      status: "active",
      current_period_end: null,
      cancel_at_period_end: true
    },
    {
      user_id: "u2",
      plan: "max",
      status: "active",
      current_period_end: null,
      cancel_at_period_end: false
    }
  ];

  it("joins every per-user count and derives rates", () => {
    const rows = buildUserRows(
      {
        profiles,
        subscriptions,
        applications: [
          { id: "a1", user_id: "u1", status: "applied", source: "arm", created_at: "x", applied_at: "y" },
          { id: "a2", user_id: "u1", status: "saved", source: "arm", created_at: "x", applied_at: null }
        ],
        runs: [
          run({ id: "r1", user_id: "u1", status: "submitted" }),
          run({ id: "r2", user_id: "u1", status: "failed" }),
          run({ id: "r3", user_id: "u1", status: "needs_review" }),
          run({ id: "r4", user_id: "u2", status: "canceled" })
        ],
        aiUsage: [
          { user_id: "u1", month_key: "2026-07", kind: "resume_parse", used: 2 },
          { user_id: "u1", month_key: "2026-07", kind: "cover_letter", used: 1 }
        ],
        quotaUsage: new Map([["u1", 10]]),
        authDirectory: new Map([["u1", { lastSignInAt: "2026-07-14T00:00:00Z", emailConfirmedAt: null }]])
      },
      NOW
    );

    const one = rows.find((row) => row.id === "u1")!;
    expect(one).toMatchObject({
      plan: "premium",
      subscriptionStatus: "active",
      cancelAtPeriodEnd: true,
      applications: 2,
      applied: 1,
      runs: 3,
      runsSubmitted: 1,
      runsFailed: 1,
      aiCalls: 3,
      quotaUsed: 10,
      quotaLimit: 200,
      quotaWindow: "month",
      segment: "active"
    });
    // One submitted of two finished runs: the parked review does not count.
    expect(one.successRatePct).toBe(50);
    expect(one.quotaPct).toBe(5);

    const two = rows.find((row) => row.id === "u2")!;
    expect(two).toMatchObject({ plan: "max", quotaWindow: "day", autonomy: "full_auto" });
    expect(two.successRatePct).toBe(0);

    const three = rows.find((row) => row.id === "u3")!;
    expect(three).toMatchObject({
      plan: "free",
      subscriptionStatus: "none",
      runs: 0,
      applications: 0,
      aiCalls: 0,
      quotaUsed: 0,
      successRatePct: null,
      lastSignInAt: null
    });
  });

  it("works without an auth directory at all", () => {
    const rows = buildUserRows(
      {
        profiles: [profile()],
        subscriptions: [],
        applications: [],
        runs: [],
        aiUsage: [],
        quotaUsage: new Map()
      },
      NOW
    );
    expect(rows[0].lastSignInAt).toBeNull();
    expect(rows[0].segment).toBe("new");
  });

  it("defaults to the current instant", () => {
    const rows = buildUserRows({
      profiles: [profile()],
      subscriptions: [],
      applications: [],
      runs: [],
      aiUsage: [],
      quotaUsage: new Map()
    });
    expect(rows).toHaveLength(1);
  });

  it("reports zero quota percent when the plan grants nothing", () => {
    const rows = buildUserRows(
      {
        profiles: [profile()],
        subscriptions: [],
        applications: [],
        runs: [],
        aiUsage: [],
        quotaUsage: new Map([["u1", 0]])
      },
      NOW
    );
    expect(rows[0].quotaPct).toBe(0);
  });
});

describe("sorting and filtering", () => {
  const rows: AdminUserRow[] = [
    {
      id: "aa1",
      email: "zed@x.com",
      createdAt: "2026-07-01T00:00:00Z",
      plan: "free",
      subscriptionStatus: "none",
      cancelAtPeriodEnd: false,
      onboardingComplete: true,
      autonomy: "review_gate",
      lastSignInAt: null,
      segment: "quiet",
      applications: 1,
      applied: 1,
      runs: 5,
      runsSubmitted: 1,
      runsFailed: 1,
      successRatePct: 50,
      aiCalls: 0,
      quotaUsed: 3,
      quotaLimit: 3,
      quotaWindow: "month",
      quotaPct: 100
    },
    {
      id: "bb2",
      email: "abe@x.com",
      createdAt: "2026-07-10T00:00:00Z",
      plan: "max",
      subscriptionStatus: "active",
      cancelAtPeriodEnd: false,
      onboardingComplete: true,
      autonomy: "review_gate",
      lastSignInAt: null,
      segment: "active",
      applications: 4,
      applied: 3,
      runs: 2,
      runsSubmitted: 2,
      runsFailed: 0,
      successRatePct: 100,
      aiCalls: 9,
      quotaUsed: 1,
      quotaLimit: 100,
      quotaWindow: "day",
      quotaPct: 1
    },
    {
      id: "cc3",
      email: "mid@x.com",
      createdAt: "2026-07-05T00:00:00Z",
      plan: "premium",
      subscriptionStatus: "active",
      cancelAtPeriodEnd: false,
      onboardingComplete: true,
      autonomy: "review_gate",
      lastSignInAt: null,
      segment: "cooling",
      applications: 2,
      applied: 2,
      runs: 3,
      runsSubmitted: 3,
      runsFailed: 0,
      successRatePct: 100,
      aiCalls: 4,
      quotaUsed: 20,
      quotaLimit: 200,
      quotaWindow: "month",
      quotaPct: 10
    }
  ];

  it("sorts by every supported key", () => {
    expect(sortUserRows(rows, "newest").map((r) => r.id)).toEqual(["bb2", "cc3", "aa1"]);
    expect(sortUserRows(rows, "email").map((r) => r.id)).toEqual(["bb2", "cc3", "aa1"]);
    expect(sortUserRows(rows, "plan").map((r) => r.id)).toEqual(["bb2", "cc3", "aa1"]);
    expect(sortUserRows(rows, "runs").map((r) => r.id)).toEqual(["aa1", "cc3", "bb2"]);
    expect(sortUserRows(rows, "applied").map((r) => r.id)).toEqual(["bb2", "cc3", "aa1"]);
    expect(sortUserRows(rows, "quota").map((r) => r.id)).toEqual(["aa1", "cc3", "bb2"]);
  });

  it("breaks a plan tie on email", () => {
    const tied = sortUserRows(
      [
        { ...rows[0], plan: "premium", email: "b@x.com" },
        { ...rows[1], plan: "premium", email: "a@x.com" }
      ],
      "plan"
    );
    expect(tied.map((r) => r.email)).toEqual(["a@x.com", "b@x.com"]);
  });

  it("validates the sort param", () => {
    expect(isUserSort("quota")).toBe(true);
    expect(isUserSort("sideways")).toBe(false);
    expect(isUserSort(undefined)).toBe(false);
  });

  it("filters on email, id, plan, and segment", () => {
    expect(filterUserRows(rows, "  ").length).toBe(3);
    expect(filterUserRows(rows, "abe").map((r) => r.id)).toEqual(["bb2"]);
    expect(filterUserRows(rows, "cc3").map((r) => r.id)).toEqual(["cc3"]);
    expect(filterUserRows(rows, "MAX").map((r) => r.id)).toEqual(["bb2"]);
    expect(filterUserRows(rows, "quiet").map((r) => r.id)).toEqual(["aa1"]);
    expect(filterUserRows(rows, "nothing")).toEqual([]);
  });
});
