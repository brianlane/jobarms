// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { FleetSnapshot } from "@/lib/admin/reads";
import type { AdminRunRow } from "@/lib/admin/run-stats";
import { ENV_GROUPS } from "@/lib/admin/system";

const holder = vi.hoisted(() => ({
  admin: { id: "admin-1", email: "ops@jobarms.com" } as { id: string; email: string } | null,
  authUser: null as { id: string; email: string } | null,
  snapshot: null as unknown,
  subscriptions: [] as unknown[],
  subscriptionsThrows: false,
  audit: [] as unknown[],
  auditThrows: false,
  inboundEmails: [] as unknown[],
  inboundEmailsThrows: false
}));

vi.mock("@/lib/admin/guard", async () => {
  const actual = await vi.importActual<typeof import("@/lib/admin/guard")>("@/lib/admin/guard");
  return { ...actual, getAdminUser: vi.fn(async () => holder.admin) };
});
vi.mock("@/lib/supabase/auth", () => ({ getAuthUser: vi.fn(async () => holder.authUser) }));
vi.mock("@/lib/admin/reads", async () => {
  const actual = await vi.importActual<typeof import("@/lib/admin/reads")>("@/lib/admin/reads");
  return {
    ...actual,
    loadFleetSnapshot: vi.fn(async () => holder.snapshot),
    loadSubscriptions: vi.fn(async () => {
      if (holder.subscriptionsThrows) throw new Error("read failed");
      return holder.subscriptions;
    }),
    loadInboundEmails: vi.fn(async () => {
      if (holder.inboundEmailsThrows) throw new Error("read failed");
      return holder.inboundEmails;
    })
  };
});
vi.mock("@/lib/admin/audit", async () => {
  const actual = await vi.importActual<typeof import("@/lib/admin/audit")>("@/lib/admin/audit");
  return {
    ...actual,
    listAdminAuditLog: vi.fn(async () => {
      if (holder.auditThrows) throw new Error("read failed");
      return holder.audit;
    })
  };
});
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
  usePathname: () => "/admin/dashboard",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams()
}));

import AdminLayout from "@/app/admin/(protected)/layout";
import AdminIndexPage from "@/app/admin/(protected)/page";
import AdminDashboardPage from "@/app/admin/(protected)/dashboard/page";
import AdminSystemPage from "@/app/admin/(protected)/system/page";
import AdminLoginPage from "@/app/admin/login/page";

function run(over: Partial<AdminRunRow> = {}): AdminRunRow {
  return {
    id: "r1",
    user_id: "u1",
    application_id: "app1",
    status: "submitted",
    autonomy: "review_gate",
    error: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...over
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

function busySnapshot(): FleetSnapshot {
  const old = new Date(Date.now() - 9 * 24 * 60 * 60 * 1000).toISOString();
  return {
    profiles: [
      { id: "u1", email: "one@x.com", created_at: new Date().toISOString(), onboarding_complete: true, arm_autonomy: "review_gate" },
      { id: "u2", email: "two@x.com", created_at: old, onboarding_complete: false, arm_autonomy: "full_auto" },
      { id: "u3", email: "three@x.com", created_at: old, onboarding_complete: true, arm_autonomy: "review_gate" },
      { id: "u4", email: "four@x.com", created_at: old, onboarding_complete: true, arm_autonomy: "review_gate" },
      { id: "u5", email: "five@x.com", created_at: old, onboarding_complete: true, arm_autonomy: "review_gate" }
    ],
    // u5 deliberately has no subscription row, so the status mix covers active,
    // trialing, past_due (which reads as free), and none.
    subscriptions: [
      { user_id: "u1", plan: "premium", status: "active", current_period_end: null, cancel_at_period_end: true },
      { user_id: "u2", plan: "max", status: "active", current_period_end: null, cancel_at_period_end: false },
      { user_id: "u3", plan: "premium", status: "past_due", current_period_end: null, cancel_at_period_end: false },
      { user_id: "u4", plan: "premium", status: "trialing", current_period_end: null, cancel_at_period_end: false }
    ],
    runs: [
      run({ id: "r1", status: "failed", error: "form_not_found: nothing there", user_id: "u1" }),
      run({ id: "r2", status: "failed", error: "captcha_blocked: blocked", user_id: "ghost" }),
      run({ id: "r3", status: "submitted", user_id: "u2", autonomy: "full_auto" }),
      run({ id: "r4", status: "needs_review", created_at: old, user_id: "u1" }),
      // A stuck run whose user is not in the profile list: the attention
      // worklist has to render it without an email.
      run({ id: "r5", status: "running", created_at: old, user_id: "ghost" }),
      run({ id: "r6", status: "canceled", canceled_by: "user", user_id: "u3" })
    ],
    applications: [
      { id: "a1", user_id: "u1", status: "applied", source: "arm", created_at: old, applied_at: old },
      { id: "a2", user_id: "u2", status: "saved", source: "manual", created_at: old, applied_at: null }
    ],
    aiUsage: [{ user_id: "u1", month_key: "2026-07", kind: "resume_parse", used: 4 }],
    // u3 is a free user at their cap and u2 a max user near the daily cap, so
    // quota pressure renders both the free and the paid badge.
    quotaUsage: new Map([
      ["u1", 3],
      ["u2", 95],
      ["u3", 3],
      ["u4", 0],
      ["u5", 0]
    ]),
    catalog: {
      jobs: 4200,
      jobsAdded24h: 88,
      companies: 10,
      byAts: {},
      newestJobAt: new Date().toISOString()
    }
  };
}

beforeEach(() => {
  holder.admin = { id: "admin-1", email: "ops@jobarms.com" };
  holder.authUser = null;
  holder.snapshot = emptySnapshot();
  holder.subscriptions = [];
  holder.subscriptionsThrows = false;
  holder.audit = [];
  holder.auditThrows = false;
  holder.inboundEmails = [];
  holder.inboundEmailsThrows = false;
  // The sidecar probe reads /health as JSON; the arm probe only reads a status.
  vi.stubGlobal("fetch", vi.fn(async () => ({ status: 401, json: async () => ({}) })));
  process.env.ADMIN_EMAIL = "ops@jobarms.com";
  process.env.NEXT_PUBLIC_APP_URL = "https://jobarms.com";
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://mock.supabase.co";
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ADMIN_EMAIL;
  delete process.env.NEXT_PUBLIC_APP_URL;
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.ARM_WORKER_URL;
});

describe("AdminLayout", () => {
  it("renders the operator shell for an allowlisted admin", async () => {
    render(await AdminLayout({ children: "child-content" }));
    expect(screen.getByText("child-content")).toBeInTheDocument();
    expect(screen.getByText("ops@jobarms.com")).toBeInTheDocument();
    expect(screen.getAllByText("Sign out").length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: "My dashboard" })).toHaveAttribute("href", "/dashboard");
  });

  it("redirects anyone who is not an admin to the admin sign in", async () => {
    holder.admin = null;
    await expect(AdminLayout({ children: "x" })).rejects.toThrow(
      "REDIRECT:/admin/login?next=/admin/dashboard"
    );
  });
});

describe("AdminIndexPage", () => {
  it("sends /admin to the overview", () => {
    expect(() => AdminIndexPage()).toThrow("REDIRECT:/admin/dashboard");
  });
});

describe("AdminDashboardPage", () => {
  it("renders the zero state of a brand new platform", async () => {
    render(await AdminDashboardPage());
    expect(screen.getByText("Platform overview")).toBeInTheDocument();
    expect(screen.getByText("No failures recorded in the window.")).toBeInTheDocument();
    expect(screen.getByText("No applications yet.")).toBeInTheDocument();
    expect(screen.getByText("Nothing stuck or aging.")).toBeInTheDocument();
    expect(screen.getByText("Nobody is near their arm-run cap.")).toBeInTheDocument();
    expect(screen.getByText("No runs in the window.")).toBeInTheDocument();
    expect(screen.getByText("sweep stale")).toBeInTheDocument();
  });

  it("renders every populated card", async () => {
    holder.snapshot = busySnapshot();
    render(await AdminDashboardPage());

    // Plan mix and money.
    expect(screen.getByText("Est. MRR")).toBeInTheDocument();
    expect(screen.getByText("$19 canceling at period end")).toBeInTheDocument();
    expect(screen.getByText("fresh")).toBeInTheDocument();

    // Failure taxonomy.
    expect(screen.getByText("form_not_found")).toBeInTheDocument();
    expect(screen.getByText("captcha_blocked")).toBeInTheDocument();

    // Application pipeline and activation.
    expect(screen.getByText("Applied")).toBeInTheDocument();
    expect(screen.getByText(/2 of 5 users activated/)).toBeInTheDocument();

    // Subscription status mix covers every badge tone.
    expect(screen.getByText("trialing")).toBeInTheDocument();
    expect(screen.getByText("none")).toBeInTheDocument();
    expect(screen.getByText("1 canceling at period end")).toBeInTheDocument();

    // Worklists: an aging review and a stuck run, plus quota pressure on both a
    // free user at their cap and a paid user near theirs.
    expect(screen.getAllByText("needs review").length).toBeGreaterThan(0);
    expect(screen.getByText(/3 \/ 3/)).toBeInTheDocument();
    expect(screen.getByText(/95 \/ 100/)).toBeInTheDocument();

    // Status badges across the recent-run table.
    expect(screen.getAllByText("submitted").length).toBeGreaterThan(0);
    expect(screen.getAllByText("failed").length).toBeGreaterThan(0);
    expect(screen.getAllByText("canceled").length).toBeGreaterThan(0);

    // Runs whose user is not in the profile list still render.
    expect(screen.getAllByText("ghost").length).toBeGreaterThan(0);
  });

  it("shows a past_due subscription badge and no pending-churn hint when nothing is canceling", async () => {
    const snapshot = busySnapshot();
    snapshot.subscriptions = snapshot.subscriptions.map((sub) => ({
      ...sub,
      cancel_at_period_end: false
    }));
    holder.snapshot = snapshot;
    render(await AdminDashboardPage());
    expect(screen.getByText("past due")).toBeInTheDocument();
    expect(screen.getByText(/per paying user/)).toBeInTheDocument();
  });
});

describe("AdminSystemPage", () => {
  it("calls the alias-mail relay healthy when nothing failed to forward", async () => {
    holder.inboundEmails = [
      { created_at: new Date().toISOString(), from_domain: "myworkday.com", forwarded: true }
    ];
    render(await AdminSystemPage());

    expect(screen.getByText("healthy")).toBeInTheDocument();
    expect(screen.getByText(/was relayed to its owner/)).toBeInTheDocument();
  });

  it("lists forwards that were stored but never relayed, by domain only", async () => {
    // The panel that did not exist when a run of silent discards went unnoticed.
    holder.inboundEmails = [
      {
        created_at: new Date().toISOString(),
        from_domain: "myworkday.com",
        forwarded: false,
        forward_error: "validation_error: The from address is not valid"
      },
      { created_at: new Date().toISOString(), from_domain: "greenhouse.io", forwarded: true }
    ];
    render(await AdminSystemPage());

    expect(screen.getByText("50% failing")).toBeInTheDocument();
    expect(screen.getByText("failed")).toBeInTheDocument();
    expect(screen.getByText("myworkday.com")).toBeInTheDocument();
    // The reason is the point: an alarm you cannot answer just sends you to the logs.
    expect(
      screen.getByText("validation_error: The from address is not valid")
    ).toBeInTheDocument();
    expect(screen.getByText(/never a subject or body/)).toBeInTheDocument();
  });

  it("still renders the config matrix when the mail read fails", async () => {
    // Every read here is best effort: the matrix is what you reach for when
    // something else is already broken, so one failed query cannot blank it.
    holder.inboundEmailsThrows = true;
    render(await AdminSystemPage());

    expect(screen.getByText("System")).toBeInTheDocument();
    expect(screen.getByText("healthy")).toBeInTheDocument();
  });

  it("renders configuration, probes, and an empty audit log", async () => {
    render(await AdminSystemPage());
    expect(screen.getByText("System")).toBeInTheDocument();
    expect(screen.getByText("No admin actions recorded yet.")).toBeInTheDocument();
    expect(screen.getByText("never")).toBeInTheDocument();
    // No dependency urls are configured here, so every probe reports down.
    expect(screen.getAllByText("down").length).toBe(2);
    expect(screen.getByText("configured")).toBeInTheDocument();
    expect(screen.getAllByText("missing").length).toBeGreaterThan(0);
    expect(screen.getAllByText("partial").length).toBeGreaterThan(0);
  });

  it("renders a reachable probe, webhook age, and audit rows", async () => {
    process.env.ARM_WORKER_URL = "https://arm.jobarms.com";
    holder.subscriptions = [
      {
        user_id: "u1",
        plan: "premium",
        status: "active",
        current_period_end: null,
        cancel_at_period_end: false,
        updated_at: new Date().toISOString()
      }
    ];
    holder.audit = [
      {
        id: "l1",
        admin_email: "ops@jobarms.com",
        action: "comp_plan",
        target_user_id: "u1",
        target_run_id: null,
        detail: {},
        created_at: new Date().toISOString()
      },
      {
        id: "l2",
        admin_email: "ops@jobarms.com",
        action: "refund_run",
        target_user_id: null,
        target_run_id: "r1",
        detail: {},
        created_at: new Date().toISOString()
      },
      {
        id: "l3",
        admin_email: "ops@jobarms.com",
        action: "sweep",
        target_user_id: null,
        target_run_id: null,
        detail: {},
        created_at: new Date().toISOString()
      }
    ];

    render(await AdminSystemPage());
    expect(screen.getByText("up")).toBeInTheDocument();
    expect(screen.getByText("comp plan")).toBeInTheDocument();
    expect(screen.getByText("refund run")).toBeInTheDocument();
    expect(screen.getByText("u1")).toBeInTheDocument();
    expect(screen.getByText("-")).toBeInTheDocument();
  });

  it("reports a complete configuration when every key is set", async () => {
    const keys = ENV_GROUPS.flatMap((group) => group.vars.map((spec) => spec.key));
    for (const key of keys) process.env[key] = "set";
    try {
      render(await AdminSystemPage());
      expect(screen.getAllByText("configured")).toHaveLength(ENV_GROUPS.length);
      expect(screen.queryByText("missing")).not.toBeInTheDocument();
    } finally {
      for (const key of keys) delete process.env[key];
    }
  });

  it("still renders the configuration matrix when both reads fail", async () => {
    holder.subscriptionsThrows = true;
    holder.auditThrows = true;
    render(await AdminSystemPage());
    expect(screen.getByText("Operator audit log")).toBeInTheDocument();
    expect(screen.getByText("No admin actions recorded yet.")).toBeInTheDocument();
  });
});

describe("AdminLoginPage", () => {
  it("renders the form for a signed-out visitor", async () => {
    holder.admin = null;
    render(await AdminLoginPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByText("Admin sign in")).toBeInTheDocument();
  });

  it("redirects an already-signed-in admin to the requested page", async () => {
    await expect(
      AdminLoginPage({ searchParams: Promise.resolve({ next: "/admin/system" }) })
    ).rejects.toThrow("REDIRECT:/admin/system");
  });

  it("rejects an off-site next param", async () => {
    await expect(
      AdminLoginPage({ searchParams: Promise.resolve({ next: "//evil.example" }) })
    ).rejects.toThrow("REDIRECT:/admin/dashboard");
  });

  it("tells the form to clear a signed-in non-admin session", async () => {
    holder.admin = null;
    holder.authUser = { id: "u9", email: "user@example.com" };
    render(await AdminLoginPage({ searchParams: Promise.resolve({}) }));
    expect(await screen.findByText(/not authorized for admin access/)).toBeInTheDocument();
  });
});
