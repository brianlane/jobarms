import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeFrom, type Result } from "./helpers/supabase";

const holder = vi.hoisted(() => ({
  from: null as unknown,
  getUserById: null as unknown,
  storage: null as unknown
}));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceClient: vi.fn(() => ({
    from: holder.from,
    auth: { admin: { getUserById: holder.getUserById } },
    storage: holder.storage
  }))
}));

import { loadAuthEntry, loadDeletionImpact, loadUserDetail } from "@/lib/admin/user-detail";

const NOW = new Date("2026-07-15T12:00:00Z");

function tables(map: Record<string, Result[]>) {
  holder.from = fakeFrom(map);
}

beforeEach(() => {
  holder.from = fakeFrom({});
  holder.getUserById = vi.fn(async () => ({
    data: { user: { last_sign_in_at: "2026-07-14T00:00:00Z", email_confirmed_at: "2026-01-01T00:00:00Z" } },
    error: null
  }));
  holder.storage = { from: vi.fn() };
});

describe("loadAuthEntry", () => {
  it("returns the auth facts", async () => {
    expect(await loadAuthEntry("u1")).toEqual({
      lastSignInAt: "2026-07-14T00:00:00Z",
      emailConfirmedAt: "2026-01-01T00:00:00Z"
    });
  });

  it("is null on an API error or a missing user", async () => {
    holder.getUserById = vi.fn(async () => ({ data: null, error: { message: "nope" } }));
    expect(await loadAuthEntry("u1")).toBeNull();
    holder.getUserById = vi.fn(async () => ({ data: { user: null }, error: null }));
    expect(await loadAuthEntry("u1")).toBeNull();
  });

  it("is null when the call throws", async () => {
    holder.getUserById = vi.fn(async () => {
      throw new Error("network");
    });
    expect(await loadAuthEntry("u1")).toBeNull();
  });

  it("nulls absent optional fields", async () => {
    holder.getUserById = vi.fn(async () => ({ data: { user: {} }, error: null }));
    expect(await loadAuthEntry("u1")).toEqual({ lastSignInAt: null, emailConfirmedAt: null });
  });
});

describe("loadUserDetail", () => {
  it("returns null when the profile does not exist", async () => {
    tables({ profiles: [{ data: null }] });
    expect(await loadUserDetail("missing", NOW)).toBeNull();
  });

  it("assembles the whole per-user picture", async () => {
    tables({
      profiles: [{ data: { id: "u1", email: "u1@x.com", full_name: "One User", eeo: { gender: "x" } } }],
      subscriptions: [
        { data: { user_id: "u1", plan: "premium", status: "active", cancel_at_period_end: false } }
      ],
      applications: [{ data: [{ id: "a1", status: "applied", jobs: { company: "Acme" } }] }],
      application_runs: [{ data: [{ id: "r1", status: "submitted", user_id: "u1" }] }],
      resumes: [{ data: [{ id: "res1", kind: "base" }] }],
      inbound_emails: [{ data: [{ id: "m1", subject: "Verify" }] }],
      site_accounts: [
        { data: [{ tenant_host: "acme.wd1.myworkdayjobs.com", status: "verified" }] }
      ],
      user_answer_memory: [
        {
          data: [
            { question_key: "why", label: "Why us", source: "user_edited", times_used: 5 },
            { question_key: "auth", label: "", source: "approved", times_used: 9 }
          ]
        }
      ],
      ai_usage: [
        {
          data: [
            { user_id: "u1", month_key: "2026-07", kind: "resume_parse", used: 3 },
            { user_id: "u1", month_key: "2026-06", kind: "cover_letter", used: 8 }
          ]
        }
      ],
      arm_run_usage: [{ data: { runs_used: 12 } }]
    });

    const detail = await loadUserDetail("u1", NOW);
    expect(detail).not.toBeNull();
    expect(detail!.plan).toBe("premium");
    expect(detail!.applications).toHaveLength(1);
    expect(detail!.runs).toHaveLength(1);
    expect(detail!.resumes).toHaveLength(1);
    expect(detail!.emails).toHaveLength(1);
    expect(detail!.siteAccounts).toHaveLength(1);
    expect(detail!.armQuota).toEqual({ used: 12, limit: 200, window: "month", pct: 6 });

    // Memory: the edited/approved split, and a blank label falls back to the key.
    expect(detail!.memory.total).toBe(2);
    expect(detail!.memory.userEdited).toBe(1);
    expect(detail!.memory.approved).toBe(1);
    expect(detail!.memory.topQuestions[0]).toEqual({
      label: "auth",
      timesUsed: 9,
      source: "approved"
    });

    // Only the CURRENT month key counts; last month's cover letters do not.
    const parse = detail!.aiQuotas.find((q) => q.kind === "resume_parse")!;
    expect(parse).toEqual({ kind: "resume_parse", used: 3, limit: 100, window: "month" });
    expect(detail!.aiQuotas.find((q) => q.kind === "cover_letter")!.used).toBe(0);
  });

  it("degrades to empty lists and a free plan with no related rows", async () => {
    tables({ profiles: [{ data: { id: "u1", email: "u1@x.com" } }] });
    const detail = await loadUserDetail("u1", NOW);
    expect(detail!.plan).toBe("free");
    expect(detail!.subscription).toBeNull();
    expect(detail!.applications).toEqual([]);
    expect(detail!.runs).toEqual([]);
    expect(detail!.resumes).toEqual([]);
    expect(detail!.emails).toEqual([]);
    expect(detail!.siteAccounts).toEqual([]);
    expect(detail!.memory.total).toBe(0);
    expect(detail!.armQuota).toEqual({ used: 0, limit: 3, window: "month", pct: 0 });
    // Free parses are a lifetime allowance, so the meter key is not a month.
    expect(detail!.aiQuotas[0]).toEqual({
      kind: "resume_parse",
      used: 0,
      limit: 2,
      window: "lifetime"
    });
  });

  it("reads the DAY meter for a max account", async () => {
    const from = fakeFrom({
      profiles: [{ data: { id: "u1", email: "u1@x.com" } }],
      subscriptions: [{ data: { user_id: "u1", plan: "max", status: "active" } }],
      arm_run_usage: [{ data: { runs_used: 50 } }]
    });
    holder.from = from;
    const detail = await loadUserDetail("u1", NOW);
    expect(detail!.armQuota).toEqual({ used: 50, limit: 100, window: "day", pct: 50 });
    const usageBuilder = from.mock.results.at(-1)!.value as Record<string, ReturnType<typeof vi.fn>>;
    expect(usageBuilder.eq).toHaveBeenCalledWith("month_key", "2026-07-15");
  });

  it("defaults to the current instant", async () => {
    tables({ profiles: [{ data: { id: "u1", email: "u1@x.com" } }] });
    expect(await loadUserDetail("u1")).not.toBeNull();
  });
});

describe("loadDeletionImpact", () => {
  it("counts every cascade and flags a live subscription", async () => {
    tables({
      applications: [{ count: 4 }],
      application_runs: [{ count: 9 }],
      resumes: [{ count: 2 }],
      inbound_emails: [{ count: 5 }],
      user_answer_memory: [{ count: 30 }],
      site_accounts: [{ count: 2 }],
      subscriptions: [
        { data: { stripe_subscription_id: "sub_123", plan: "premium", status: "active" } }
      ]
    });
    expect(await loadDeletionImpact("u1")).toEqual({
      applications: 4,
      runs: 9,
      resumes: 2,
      emails: 5,
      memory: 30,
      siteAccounts: 2,
      activeSubscriptionId: "sub_123"
    });
  });

  it("reports no live subscription for a free or lapsed account", async () => {
    tables({
      subscriptions: [
        { data: { stripe_subscription_id: "sub_dead", plan: "premium", status: "canceled" } }
      ]
    });
    expect((await loadDeletionImpact("u1")).activeSubscriptionId).toBeNull();
  });

  it("treats missing counts and a missing subscription row as zero and none", async () => {
    tables({});
    expect(await loadDeletionImpact("u1")).toEqual({
      applications: 0,
      runs: 0,
      resumes: 0,
      emails: 0,
      memory: 0,
      siteAccounts: 0,
      activeSubscriptionId: null
    });
  });
});
