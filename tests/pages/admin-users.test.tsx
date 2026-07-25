// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { FleetSnapshot } from "@/lib/admin/reads";
import type { AdminUserDetail } from "@/lib/admin/user-detail";

const holder = vi.hoisted(() => ({
  snapshot: null as unknown,
  directory: { byId: new Map(), clipped: false } as unknown,
  detail: null as unknown,
  impact: {
    applications: 1,
    runs: 1,
    resumes: 1,
    emails: 1,
    memory: 1,
    siteAccounts: 1,
    activeSubscriptionId: null as string | null
  }
}));

vi.mock("@/lib/admin/reads", async () => {
  const actual = await vi.importActual<typeof import("@/lib/admin/reads")>("@/lib/admin/reads");
  return {
    ...actual,
    loadFleetSnapshot: vi.fn(async () => holder.snapshot),
    loadAuthDirectory: vi.fn(async () => holder.directory)
  };
});
vi.mock("@/lib/admin/user-detail", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/admin/user-detail")>("@/lib/admin/user-detail");
  return {
    ...actual,
    loadUserDetail: vi.fn(async () => holder.detail),
    loadDeletionImpact: vi.fn(async () => holder.impact)
  };
});
vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("NOT_FOUND");
  }),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() })
}));

import AdminUsersPage from "@/app/admin/(protected)/users/page";
import AdminUserDetailPage from "@/app/admin/(protected)/users/[id]/page";

function snapshot(): FleetSnapshot {
  const old = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
  return {
    profiles: [
      {
        id: "u1",
        email: "one@x.com",
        created_at: new Date().toISOString(),
        onboarding_complete: false,
        arm_autonomy: "full_auto"
      },
      {
        id: "u2",
        email: "two@x.com",
        created_at: old,
        onboarding_complete: true,
        arm_autonomy: "review_gate"
      },
      // No email on the profile row, and a max plan close to its DAILY cap:
      // covers the id fallback and the quota-pressure highlight.
      {
        id: "u3",
        email: "",
        created_at: old,
        onboarding_complete: true,
        arm_autonomy: "review_gate"
      }
    ],
    subscriptions: [
      {
        user_id: "u1",
        plan: "premium",
        status: "active",
        current_period_end: null,
        cancel_at_period_end: true
      },
      {
        user_id: "u3",
        plan: "max",
        status: "active",
        current_period_end: null,
        cancel_at_period_end: false
      }
    ],
    runs: [
      {
        id: "r1",
        user_id: "u1",
        application_id: "a1",
        status: "submitted",
        autonomy: "full_auto",
        error: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }
    ],
    applications: [
      {
        id: "a1",
        user_id: "u1",
        status: "applied",
        source: "arm",
        created_at: old,
        applied_at: old
      }
    ],
    aiUsage: [{ user_id: "u1", month_key: "2026-07", kind: "resume_parse", used: 2 }],
    quotaUsage: new Map([
      ["u1", 3],
      ["u3", 95]
    ]),
    catalog: { jobs: 0, jobsAdded24h: 0, companies: 0, byAts: {}, newestJobAt: null }
  };
}

function emptySnapshot(): FleetSnapshot {
  return {
    profiles: [],
    subscriptions: [],
    runs: [],
    applications: [],
    aiUsage: [],
    quotaUsage: new Map(),
    catalog: { jobs: 0, jobsAdded24h: 0, companies: 0, byAts: {}, newestJobAt: null }
  };
}

function detail(over: Partial<AdminUserDetail> = {}): AdminUserDetail {
  return {
    profile: {
      id: "u1",
      email: "one@x.com",
      full_name: "One User",
      phone: "555",
      location: "Austin, TX",
      headline: "Engineer",
      summary: "",
      links: { github: "x" },
      work_history: [{}, {}],
      education: [{}],
      skills: ["ts", "sql"],
      eeo: { gender: "declined" },
      preferences: {},
      arm_autonomy: "review_gate",
      onboarding_complete: true,
      welcome_sent: true,
      applicant_alias: "a-abc@jobarms.com",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    },
    subscription: {
      user_id: "u1",
      plan: "premium",
      status: "active",
      current_period_end: "2026-08-01T00:00:00Z",
      cancel_at_period_end: false,
      stripe_subscription_id: "sub_1"
    },
    plan: "premium",
    auth: { lastSignInAt: new Date().toISOString(), emailConfirmedAt: "2026-01-01T00:00:00Z" },
    applications: [
      {
        id: "a1",
        status: "applied",
        source: "arm",
        created_at: new Date().toISOString(),
        applied_at: new Date().toISOString(),
        jobs: { company: "Acme", title: "Engineer", ats: "lever", url: "https://x" }
      },
      {
        id: "a2",
        status: "saved",
        source: "manual",
        created_at: new Date().toISOString(),
        applied_at: null,
        jobs: null
      }
    ],
    runs: [
      {
        id: "r1",
        user_id: "u1",
        application_id: "a1",
        status: "submitted",
        autonomy: "review_gate",
        error: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        slot_refunded: false
      },
      {
        id: "r2",
        user_id: "u1",
        application_id: "a1",
        status: "failed",
        autonomy: "review_gate",
        error: "form_not_found: nothing there",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        slot_refunded: true
      },
      {
        id: "r3",
        user_id: "u1",
        application_id: "a1",
        status: "needs_review",
        autonomy: "review_gate",
        error: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        slot_refunded: false
      },
      {
        id: "r4",
        user_id: "u1",
        application_id: "a1",
        status: "canceled",
        autonomy: "full_auto",
        error: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        slot_refunded: false
      }
    ],
    resumes: [
      { id: "res1", kind: "base", file_name: "cv.pdf", application_id: null, created_at: new Date().toISOString() },
      { id: "res2", kind: "tailored", file_name: "", application_id: "a1", created_at: new Date().toISOString() }
    ],
    emails: [
      {
        id: "m1",
        alias: "a-abc@jobarms.com",
        from_address: "noreply@myworkday.com",
        subject: "Verify your account",
        verification_link: "https://verify",
        verification_code: null,
        forwarded: true,
        created_at: new Date().toISOString()
      },
      {
        id: "m2",
        alias: "a-abc@jobarms.com",
        from_address: "recruiter@acme.com",
        subject: "Following up",
        verification_link: null,
        verification_code: "123456",
        forwarded: false,
        created_at: new Date().toISOString()
      },
      {
        id: "m3",
        alias: "a-abc@jobarms.com",
        from_address: "newsletter@x.com",
        subject: "News",
        verification_link: null,
        verification_code: null,
        forwarded: true,
        created_at: new Date().toISOString()
      }
    ],
    siteAccounts: [
      {
        tenant_host: "acme.wd1.myworkdayjobs.com",
        alias_email: "a-abc@jobarms.com",
        status: "verified",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      },
      {
        tenant_host: "beta.wd5.myworkdayjobs.com",
        alias_email: "a-abc@jobarms.com",
        status: "pending_verification",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      },
      {
        tenant_host: "locked.wd3.myworkdayjobs.com",
        alias_email: "a-abc@jobarms.com",
        status: "locked",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }
    ],
    memory: {
      total: 2,
      userEdited: 1,
      approved: 1,
      topQuestions: [
        { label: "Why this company", timesUsed: 4, source: "user_edited" },
        { label: "Work authorization", timesUsed: 9, source: "approved" }
      ]
    },
    armQuota: { used: 180, limit: 200, window: "month", pct: 90 },
    aiQuotas: [
      { kind: "resume_parse", used: 1, limit: 100, window: "month" },
      { kind: "tailor_resume", used: 0, limit: 100, window: "month" },
      { kind: "cover_letter", used: 0, limit: 100, window: "month" }
    ],
    ...over
  };
}

beforeEach(() => {
  holder.snapshot = snapshot();
  holder.directory = {
    byId: new Map([["u1", { lastSignInAt: new Date().toISOString(), emailConfirmedAt: null }]]),
    clipped: false
  };
  holder.detail = detail();
  holder.impact = {
    applications: 1,
    runs: 1,
    resumes: 1,
    emails: 1,
    memory: 1,
    siteAccounts: 1,
    activeSubscriptionId: null
  };
});

describe("AdminUsersPage", () => {
  it("renders the roster with plan, engagement, and quota columns", async () => {
    render(await AdminUsersPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByText("Users")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "one@x.com" })).toHaveAttribute(
      "href",
      "/admin/users/u1"
    );
    expect(screen.getByText("onboarding incomplete")).toBeInTheDocument();
    expect(screen.getByText("full-auto")).toBeInTheDocument();
    expect(screen.getByText("canceling")).toBeInTheDocument();
    expect(screen.getByText("3/200")).toBeInTheDocument();
    expect(screen.getByText("100%")).toBeInTheDocument();
    // Accounts with no finished runs show no rate at all.
    expect(screen.getAllByText("-").length).toBe(2);
    // The max account with no profile email falls back to its id, and its
    // near-cap daily quota is highlighted.
    expect(screen.getByRole("link", { name: "u3" })).toBeInTheDocument();
    expect(screen.getByText("max")).toBeInTheDocument();
    expect(screen.getByText("95/100")).toBeInTheDocument();
  });

  it("honors the sort param and the filter, and offers a clear link", async () => {
    render(
      await AdminUsersPage({ searchParams: Promise.resolve({ sort: "quota", q: "two@x.com" }) })
    );
    expect(screen.getByRole("link", { name: "two@x.com" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "one@x.com" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Clear" })).toHaveAttribute(
      "href",
      "/admin/users?sort=quota"
    );
  });

  it("falls back to the default sort on a bogus param", async () => {
    render(await AdminUsersPage({ searchParams: Promise.resolve({ sort: "sideways" }) }));
    expect(screen.getByRole("link", { name: "Newest" })).toBeInTheDocument();
  });

  it("says so when a filter matches nothing", async () => {
    render(await AdminUsersPage({ searchParams: Promise.resolve({ q: "nobody" }) }));
    expect(screen.getByText("No accounts match that filter.")).toBeInTheDocument();
  });

  it("renders the empty roster", async () => {
    holder.snapshot = emptySnapshot();
    render(await AdminUsersPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByText("No accounts yet.")).toBeInTheDocument();
  });

  it("warns when the auth directory scan was truncated", async () => {
    holder.directory = { byId: new Map(), clipped: true };
    render(await AdminUsersPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByText(/auth directory scan was truncated/)).toBeInTheDocument();
  });
});

describe("AdminUserDetailPage", () => {
  it("404s on an unknown user", async () => {
    holder.detail = null;
    await expect(
      AdminUserDetailPage({ params: Promise.resolve({ id: "nope" }) })
    ).rejects.toThrow("NOT_FOUND");
  });

  it("renders every panel for a fully populated account", async () => {
    render(await AdminUserDetailPage({ params: Promise.resolve({ id: "u1" }) }));

    expect(screen.getByText("one@x.com")).toBeInTheDocument();
    expect(screen.getByText("One User")).toBeInTheDocument();
    expect(screen.getByText("onboarded")).toBeInTheDocument();
    expect(screen.getByText("email confirmed")).toBeInTheDocument();
    // The managed alias shows on the account card and again per ATS account.
    expect(screen.getAllByText("a-abc@jobarms.com").length).toBeGreaterThan(1);
    expect(screen.getByText("Austin, TX")).toBeInTheDocument();

    // Billing.
    expect(screen.getByText("sub_1")).toBeInTheDocument();

    // Quotas: 90% of the arm cap reads as pressure.
    expect(screen.getByText("180")).toBeInTheDocument();

    // Profile counts, never self-id values.
    expect(screen.getByText("populated")).toBeInTheDocument();
    expect(screen.queryByText("declined")).not.toBeInTheDocument();

    // Runs, applications, resumes, memory, alias mail.
    expect(screen.getByText(/form_not_found/)).toBeInTheDocument();
    expect(screen.getByText("refunded")).toBeInTheDocument();
    expect(screen.getByText("Untitled role")).toBeInTheDocument();
    expect(screen.getByText("cv.pdf")).toBeInTheDocument();
    expect(screen.getByText("unnamed")).toBeInTheDocument();
    expect(screen.getByText("Why this company")).toBeInTheDocument();
    expect(screen.getByText("link")).toBeInTheDocument();
    expect(screen.getByText("code")).toBeInTheDocument();

    // Vaulted ATS accounts, every status, and never a credential.
    expect(screen.getByText("acme.wd1.myworkdayjobs.com")).toBeInTheDocument();
    expect(screen.getByText("verified")).toBeInTheDocument();
    expect(screen.getByText("pending verification")).toBeInTheDocument();
    expect(screen.getByText("locked")).toBeInTheDocument();

    // Operator actions.
    expect(screen.getByRole("button", { name: "Delete account" })).toBeInTheDocument();
  });

  it("renders the sparse account: no subscription, no history, unconfirmed email", async () => {
    holder.detail = detail({
      profile: {
        ...detail().profile,
        full_name: "",
        location: "",
        applicant_alias: null,
        onboarding_complete: false,
        welcome_sent: false,
        links: null,
        work_history: null,
        education: null,
        skills: null,
        eeo: null
      },
      subscription: null,
      plan: "free",
      auth: null,
      applications: [],
      runs: [],
      resumes: [],
      emails: [],
      siteAccounts: [],
      memory: { total: 0, userEdited: 0, approved: 0, topQuestions: [] },
      armQuota: { used: 0, limit: 3, window: "month", pct: 0 }
    });
    render(await AdminUserDetailPage({ params: Promise.resolve({ id: "u1" }) }));

    expect(screen.getByText("No name on the profile")).toBeInTheDocument();
    expect(screen.getByText("onboarding incomplete")).toBeInTheDocument();
    expect(screen.getByText("email unconfirmed")).toBeInTheDocument();
    expect(screen.getByText("no managed alias yet")).toBeInTheDocument();
    expect(screen.getByText("No subscription row.")).toBeInTheDocument();
    expect(screen.getByText("This user has never sent an arm.")).toBeInTheDocument();
    expect(screen.getByText("No applications tracked.")).toBeInTheDocument();
    expect(screen.getByText("No resume uploaded.")).toBeInTheDocument();
    expect(screen.getByText(/Nothing learned yet/)).toBeInTheDocument();
    expect(screen.getByText(/No mail has arrived/)).toBeInTheDocument();
    expect(screen.getByText("No candidate accounts created yet.")).toBeInTheDocument();
    expect(screen.getByText("empty")).toBeInTheDocument();
    expect(screen.getByText("not sent")).toBeInTheDocument();
  });

  it("falls back to the id for a nameless account and shows an unmapped status raw", async () => {
    const base = detail();
    holder.detail = detail({
      profile: { ...base.profile, email: "" },
      applications: [
        {
          id: "a9",
          status: "archived_by_hand",
          source: "manual",
          created_at: new Date().toISOString(),
          applied_at: null,
          jobs: null
        }
      ]
    });
    render(await AdminUserDetailPage({ params: Promise.resolve({ id: "u1" }) }));
    expect(screen.getByRole("heading", { name: "u1" })).toBeInTheDocument();
    expect(screen.getByText("archived_by_hand")).toBeInTheDocument();
  });

  it("flags a recorded plan that grants something else, and a missing renewal date", async () => {
    holder.detail = detail({
      plan: "free",
      subscription: {
        user_id: "u1",
        plan: "premium",
        status: "past_due",
        current_period_end: null,
        cancel_at_period_end: true,
        stripe_subscription_id: null
      }
    });
    render(await AdminUserDetailPage({ params: Promise.resolve({ id: "u1" }) }));
    expect(screen.getByText("(grants free)")).toBeInTheDocument();
    expect(screen.getByText("no subscription")).toBeInTheDocument();
    expect(screen.getByText("past due")).toBeInTheDocument();
    expect(screen.getByText("Cancel at period end").parentElement).toHaveTextContent("yes");
  });
});
