import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeClient, fakeFrom, type Result } from "./helpers/supabase";

const holder = vi.hoisted(() => ({ service: null as unknown, listUsers: null as unknown }));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceClient: vi.fn(() => {
    if (holder.service === "throw") throw new Error("no service key");
    return holder.service;
  })
}));

import {
  AUTH_PER_PAGE,
  loadAiUsage,
  loadApplications,
  loadAuthDirectory,
  loadFieldStats,
  loadInboundEmails,
  loadPlaybooks,
  loadApplicationSources,
  loadCompanies,
  loadRecentJobs,
  loadResumeOwners,
  loadRunsWithJobs,
  loadSpendEvents,
  loadSubmittedOwners,
  loadCatalogSummary,
  loadFleetSnapshot,
  loadProfiles,
  loadQuotaUsage,
  loadRecentRuns,
  loadSubscriptions,
  windowStartIso
} from "@/lib/admin/reads";

const NOW = new Date("2026-07-15T12:00:00Z");

function client(tables: Record<string, Result[]>) {
  return fakeClient({ from: fakeFrom(tables) });
}

beforeEach(() => {
  holder.service = null;
});

describe("windowStartIso", () => {
  it("walks back whole days", () => {
    expect(windowStartIso(1, NOW)).toBe("2026-07-14T12:00:00.000Z");
  });
});

describe("row reads", () => {
  it("returns profile rows", async () => {
    holder.service = client({ profiles: [{ data: [{ id: "u1" }] }] });
    expect(await loadProfiles()).toEqual([{ id: "u1" }]);
  });

  it("returns subscription rows", async () => {
    holder.service = client({ subscriptions: [{ data: [{ user_id: "u1" }] }] });
    expect(await loadSubscriptions()).toEqual([{ user_id: "u1" }]);
  });

  it("windows the run read and passes the cutoff", async () => {
    const from = fakeFrom({ application_runs: [{ data: [{ id: "r1" }] }] });
    holder.service = fakeClient({ from });
    expect(await loadRecentRuns(30, NOW)).toEqual([{ id: "r1" }]);
    const builder = from.mock.results[0].value as Record<string, ReturnType<typeof vi.fn>>;
    expect(builder.gte).toHaveBeenCalledWith("created_at", windowStartIso(30, NOW));
  });

  it("returns application rows", async () => {
    holder.service = client({ applications: [{ data: [{ id: "a1" }] }] });
    expect(await loadApplications()).toEqual([{ id: "a1" }]);
  });

  it("scopes AI usage to one month key", async () => {
    const from = fakeFrom({ ai_usage: [{ data: [{ user_id: "u1" }] }] });
    holder.service = fakeClient({ from });
    expect(await loadAiUsage("2026-07")).toEqual([{ user_id: "u1" }]);
    const builder = from.mock.results[0].value as Record<string, ReturnType<typeof vi.fn>>;
    expect(builder.eq).toHaveBeenCalledWith("month_key", "2026-07");
  });

  it("treats every null payload as empty", async () => {
    holder.service = client({});
    expect(await loadProfiles()).toEqual([]);
    expect(await loadSubscriptions()).toEqual([]);
    expect(await loadRecentRuns(30, NOW)).toEqual([]);
    expect(await loadApplications()).toEqual([]);
    expect(await loadAiUsage("2026-07")).toEqual([]);
  });

  it("defaults the AI usage month to the current key", async () => {
    const from = fakeFrom({ ai_usage: [{ data: [] }] });
    holder.service = fakeClient({ from });
    await loadAiUsage();
    const builder = from.mock.results[0].value as Record<string, ReturnType<typeof vi.fn>>;
    expect(builder.eq).toHaveBeenCalledWith("month_key", expect.stringMatching(/^\d{4}-\d{2}$/));
  });

  it("defaults the run window", async () => {
    holder.service = client({ application_runs: [{ data: [] }] });
    expect(await loadRecentRuns()).toEqual([]);
  });
});

describe("loadQuotaUsage", () => {
  const profiles = [
    { id: "monthly", email: "m@x.com", created_at: "x", onboarding_complete: true, arm_autonomy: "review_gate" },
    { id: "daily", email: "d@x.com", created_at: "x", onboarding_complete: true, arm_autonomy: "review_gate" },
    { id: "nothing", email: "n@x.com", created_at: "x", onboarding_complete: true, arm_autonomy: "review_gate" }
  ];
  const subscriptions = [
    {
      user_id: "daily",
      plan: "max",
      status: "active",
      current_period_end: null,
      cancel_at_period_end: false
    }
  ];

  it("reads each user against their own quota window", async () => {
    holder.service = client({
      arm_run_usage: [
        { data: [{ user_id: "monthly", runs_used: 2 }] },
        { data: [{ user_id: "daily", runs_used: 40 }] }
      ]
    });
    const usage = await loadQuotaUsage(profiles, subscriptions, NOW);
    expect(usage.get("monthly")).toBe(2);
    expect(usage.get("daily")).toBe(40);
    expect(usage.get("nothing")).toBe(0);
  });

  it("treats missing meter rows as zero", async () => {
    holder.service = client({ arm_run_usage: [{ data: null }, { data: null }] });
    const usage = await loadQuotaUsage(profiles, subscriptions, NOW);
    expect([...usage.values()]).toEqual([0, 0, 0]);
  });
});

describe("loadRunsWithJobs", () => {
  it("windows the read and carries the nested job", async () => {
    const from = fakeFrom({
      application_runs: [
        { data: [{ id: "r1", applications: { jobs: { ats: "lever" } } }] }
      ]
    });
    holder.service = fakeClient({ from });
    const runs = await loadRunsWithJobs(30, NOW);
    expect(runs).toHaveLength(1);
    const builder = from.mock.results[0].value as Record<string, ReturnType<typeof vi.fn>>;
    expect(builder.gte).toHaveBeenCalledWith("created_at", windowStartIso(30, NOW));
    expect(builder.select).toHaveBeenCalledWith(expect.stringContaining("applications(id, status"));
  });

  it("defaults the window and treats a null payload as empty", async () => {
    holder.service = client({});
    expect(await loadRunsWithJobs()).toEqual([]);
  });
});

describe("catalog and engagement reads", () => {
  it("windows the recent-jobs read", async () => {
    const from = fakeFrom({ jobs: [{ data: [{ ats: "lever" }] }] });
    holder.service = fakeClient({ from });
    expect(await loadRecentJobs(14, NOW)).toEqual([{ ats: "lever" }]);
    const builder = from.mock.results[0].value as Record<string, ReturnType<typeof vi.fn>>;
    expect(builder.gte).toHaveBeenCalledWith("created_at", windowStartIso(14, NOW));
  });

  it("returns companies and application sources", async () => {
    holder.service = client({
      companies: [{ data: [{ id: "c1", name: "Acme" }] }],
      applications: [{ data: [{ id: "a1", jobs: { source: "manual" } }] }]
    });
    expect(await loadCompanies()).toEqual([{ id: "c1", name: "Acme" }]);
    expect(await loadApplicationSources()).toEqual([{ id: "a1", jobs: { source: "manual" } }]);
  });

  it("collapses owner reads into distinct id sets", async () => {
    holder.service = client({
      resumes: [{ data: [{ user_id: "u1" }, { user_id: "u1" }, { user_id: "u2" }] }],
      application_runs: [{ data: [{ user_id: "u3" }] }]
    });
    expect([...(await loadResumeOwners())].sort()).toEqual(["u1", "u2"]);
    expect([...(await loadSubmittedOwners())]).toEqual(["u3"]);
  });

  it("scopes the submitted-owner read to submitted runs", async () => {
    const from = fakeFrom({ application_runs: [{ data: [] }] });
    holder.service = fakeClient({ from });
    await loadSubmittedOwners();
    const builder = from.mock.results[0].value as Record<string, ReturnType<typeof vi.fn>>;
    expect(builder.eq).toHaveBeenCalledWith("status", "submitted");
  });

  it("defaults the window and treats null payloads as empty", async () => {
    holder.service = client({});
    expect(await loadRecentJobs()).toEqual([]);
    expect(await loadCompanies()).toEqual([]);
    expect(await loadApplicationSources()).toEqual([]);
    expect(await loadResumeOwners()).toEqual(new Set());
    expect(await loadSubmittedOwners()).toEqual(new Set());
  });
});

describe("loadSpendEvents", () => {
  it("windows the ledger on the day column", async () => {
    const from = fakeFrom({ ai_spend_events: [{ data: [{ kind: "arm_answers" }] }] });
    holder.service = fakeClient({ from });
    expect(await loadSpendEvents(30, NOW)).toEqual([{ kind: "arm_answers" }]);
    const builder = from.mock.results[0].value as Record<string, ReturnType<typeof vi.fn>>;
    expect(builder.gte).toHaveBeenCalledWith("day", "2026-06-15");
  });

  it("defaults the window and treats a null payload as empty", async () => {
    holder.service = client({});
    expect(await loadSpendEvents()).toEqual([]);
  });
});

describe("loadInboundEmails", () => {
  it("returns alias-mail rows for the window", async () => {
    holder.service = client({
      inbound_emails: [{ data: [{ created_at: "x", from_domain: "acme.com", forwarded: true }] }]
    });
    expect(await loadInboundEmails(7, NOW)).toEqual([
      { created_at: "x", from_domain: "acme.com", forwarded: true }
    ]);
  });

  it("degrades to empty rather than erroring the page", async () => {
    holder.service = client({ inbound_emails: [{ data: null }] });
    expect(await loadInboundEmails(7, NOW)).toEqual([]);
  });
});

describe("loadPlaybooks and loadFieldStats", () => {
  it("returns playbook rows newest first", async () => {
    holder.service = client({ arm_playbooks: [{ data: [{ domain: "acme.com" }] }] });
    expect(await loadPlaybooks()).toEqual([{ domain: "acme.com" }]);
  });

  it("returns field-stat rows most-seen first", async () => {
    holder.service = client({ platform_field_stats: [{ data: [{ question_key: "auth" }] }] });
    expect(await loadFieldStats()).toEqual([{ question_key: "auth" }]);
  });

  it("treats null payloads as empty", async () => {
    holder.service = client({});
    expect(await loadPlaybooks()).toEqual([]);
    expect(await loadFieldStats()).toEqual([]);
  });
});

describe("loadAuthDirectory", () => {
  function authClient(pages: { users?: unknown[]; error?: unknown }[]) {
    const listUsers = vi.fn(async () => {
      const page = pages.shift() ?? { users: [] };
      return { data: page.users ? { users: page.users } : null, error: page.error ?? null };
    });
    holder.listUsers = listUsers;
    holder.service = { auth: { admin: { listUsers } } };
    return listUsers;
  }

  it("collects sign-in recency keyed by user id", async () => {
    authClient([
      {
        users: [
          { id: "u1", last_sign_in_at: "2026-07-14T00:00:00Z", email_confirmed_at: "2026-01-01T00:00:00Z" },
          { id: "u2" }
        ]
      }
    ]);
    const directory = await loadAuthDirectory();
    expect(directory.clipped).toBe(false);
    expect(directory.byId.get("u1")).toEqual({
      lastSignInAt: "2026-07-14T00:00:00Z",
      emailConfirmedAt: "2026-01-01T00:00:00Z"
    });
    expect(directory.byId.get("u2")).toEqual({ lastSignInAt: null, emailConfirmedAt: null });
  });

  it("pages until a short page and marks the scan complete", async () => {
    const full = Array.from({ length: AUTH_PER_PAGE }, (_, i) => ({ id: `u${i}` }));
    const listUsers = authClient([{ users: full }, { users: [{ id: "last" }] }]);
    const directory = await loadAuthDirectory();
    expect(listUsers).toHaveBeenCalledTimes(2);
    expect(directory.clipped).toBe(false);
    expect(directory.byId.size).toBe(AUTH_PER_PAGE + 1);
  });

  it("reports a clipped scan when every page is full", async () => {
    const full = Array.from({ length: AUTH_PER_PAGE }, (_, i) => ({ id: `u${i}` }));
    const listUsers = authClient(Array.from({ length: 10 }, () => ({ users: full })));
    const directory = await loadAuthDirectory();
    expect(listUsers).toHaveBeenCalledTimes(10);
    expect(directory.clipped).toBe(true);
  });

  it("degrades to a clipped empty directory on an API error", async () => {
    authClient([{ users: [], error: { message: "denied" } }]);
    expect(await loadAuthDirectory()).toEqual({ byId: new Map(), clipped: true });
  });

  it("degrades when the client cannot be built", async () => {
    holder.service = "throw";
    expect(await loadAuthDirectory()).toEqual({ byId: new Map(), clipped: true });
  });

  it("treats a null payload as an empty page", async () => {
    holder.service = {
      auth: { admin: { listUsers: vi.fn(async () => ({ data: null, error: null })) } }
    };
    expect((await loadAuthDirectory()).clipped).toBe(false);
  });
});

describe("loadCatalogSummary", () => {
  it("counts with head requests and reports the newest job", async () => {
    holder.service = client({
      jobs: [{ count: 4200 }, { count: 130 }, { data: [{ created_at: "2026-07-15T11:00:00Z" }] }],
      companies: [{ count: 10 }]
    });
    const catalog = await loadCatalogSummary(NOW);
    expect(catalog).toEqual({
      jobs: 4200,
      jobsAdded24h: 130,
      companies: 10,
      byAts: {},
      newestJobAt: "2026-07-15T11:00:00Z"
    });
  });

  it("degrades to zeros on an empty catalog", async () => {
    holder.service = client({ jobs: [{ count: null }, {}, { data: null }], companies: [{}] });
    const catalog = await loadCatalogSummary(NOW);
    expect(catalog.jobs).toBe(0);
    expect(catalog.jobsAdded24h).toBe(0);
    expect(catalog.companies).toBe(0);
    expect(catalog.newestJobAt).toBeNull();
  });
});

describe("loadFleetSnapshot", () => {
  it("composes every read into one snapshot", async () => {
    holder.service = client({
      profiles: [{ data: [{ id: "u1", email: "u1@x.com" }] }],
      subscriptions: [{ data: [{ user_id: "u1", plan: "premium", status: "active" }] }],
      application_runs: [{ data: [{ id: "r1" }] }],
      applications: [{ data: [{ id: "a1" }] }],
      ai_usage: [{ data: [{ user_id: "u1", kind: "resume_parse", used: 1 }] }],
      jobs: [{ count: 1 }, { count: 1 }, { data: [] }],
      companies: [{ count: 1 }],
      arm_run_usage: [{ data: [{ user_id: "u1", runs_used: 5 }] }, { data: [] }]
    });

    const snapshot = await loadFleetSnapshot(NOW);
    expect(snapshot.profiles).toHaveLength(1);
    expect(snapshot.subscriptions).toHaveLength(1);
    expect(snapshot.runs).toHaveLength(1);
    expect(snapshot.applications).toHaveLength(1);
    expect(snapshot.aiUsage).toHaveLength(1);
    expect(snapshot.catalog.jobs).toBe(1);
    expect(snapshot.quotaUsage.get("u1")).toBe(5);
  });

  it("defaults to the current instant", async () => {
    holder.service = client({ jobs: [{ count: 0 }, { count: 0 }, { data: [] }], companies: [{ count: 0 }] });
    const snapshot = await loadFleetSnapshot();
    expect(snapshot.profiles).toEqual([]);
  });
});
