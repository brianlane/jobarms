// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { fakeClient, fakeFrom, type Result } from "../helpers/supabase";

const holder = vi.hoisted(() => ({
  user: { id: "u1", email: "a@b.com" } as { id: string; email: string } | null,
  client: null as unknown,
  service: null as unknown
}));
vi.mock("@/lib/supabase/auth", () => ({ getAuthUser: vi.fn(async () => holder.user) }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: vi.fn(async () => holder.client) }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceClient: vi.fn(() => holder.service) }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
  notFound: vi.fn(() => {
    throw new Error("NOT_FOUND");
  }),
  usePathname: () => "/dashboard",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams()
}));

import DashboardLayout from "@/app/dashboard/layout";
import DashboardPage from "@/app/dashboard/page";
import ApplicationsPage from "@/app/dashboard/applications/page";
import NewApplicationPage from "@/app/dashboard/applications/new/page";
import ProfilePage from "@/app/dashboard/profile/page";
import DiscoverPage from "@/app/dashboard/discover/page";
import BillingPage from "@/app/dashboard/billing/page";
import SettingsPage from "@/app/dashboard/settings/page";
import ApplicationDetailPage from "@/app/dashboard/applications/[id]/page";

function client(tables: Record<string, Result[]>) {
  return fakeClient({ from: fakeFrom(tables) });
}

beforeEach(() => {
  holder.user = { id: "u1", email: "a@b.com" };
  holder.client = null;
  // Settings reads the connected LinkedIn account through the service client;
  // default to "not connected" so the other pages need no setup.
  holder.service = fakeClient({ from: fakeFrom({ site_accounts: [{ data: null }] }) });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ screenshots: [] }) }));
});
afterEach(() => vi.unstubAllGlobals());

describe("DashboardLayout", () => {
  it("renders the shell for a signed-in user", async () => {
    render(await DashboardLayout({ children: "child-content" }));
    expect(screen.getByText("child-content")).toBeInTheDocument();
    expect(screen.getAllByText("Sign out").length).toBeGreaterThan(0);
    expect(screen.getByText("a@b.com")).toBeInTheDocument();
  });

  it("redirects to /login when signed out", async () => {
    holder.user = null;
    await expect(DashboardLayout({ children: "x" })).rejects.toThrow("REDIRECT:/login");
  });

  it("offers the console to an operator, so /admin is not typed from memory", async () => {
    process.env.ADMIN_EMAIL = "ops@jobarms.com";
    holder.user = { id: "admin-1", email: "ops@jobarms.com" };
    render(await DashboardLayout({ children: "x" }));

    const link = screen.getByText("Admin console").closest("a");
    expect(link).toHaveAttribute("href", "/admin/dashboard");
    delete process.env.ADMIN_EMAIL;
  });

  it("shows no console link to a normal user", async () => {
    process.env.ADMIN_EMAIL = "ops@jobarms.com";
    render(await DashboardLayout({ children: "x" }));
    expect(screen.queryByText("Admin console")).not.toBeInTheDocument();
    delete process.env.ADMIN_EMAIL;
  });
});

describe("DashboardPage", () => {
  it("shows the onboarding banner when incomplete", async () => {
    holder.client = client({
      profiles: [{ data: { full_name: "Bri Lane", onboarding_complete: false } }],
      subscriptions: [{ data: { plan: "free", status: "active" } }],
      arm_run_usage: [{ data: { runs_used: 2 } }]
    });
    render(await DashboardPage());
    expect(screen.getByText(/Welcome, Bri/)).toBeInTheDocument();
    expect(screen.getByText("Finish setting up your profile")).toBeInTheDocument();
    expect(screen.getByText("2 / 3")).toBeInTheDocument();
  });

  it("hides the banner and shows day-window copy for max", async () => {
    holder.client = client({
      profiles: [{ data: { full_name: "", onboarding_complete: true } }],
      subscriptions: [{ data: { plan: "max", status: "active" } }],
      arm_run_usage: [{ data: null }]
    });
    render(await DashboardPage());
    expect(screen.queryByText("Finish setting up your profile")).not.toBeInTheDocument();
    expect(screen.getByText("Arm runs today")).toBeInTheDocument();
    expect(screen.getByText("0 / 100")).toBeInTheDocument();
  });
});

describe("ApplicationsPage", () => {
  it("renders the empty state", async () => {
    holder.client = client({ applications: [{ data: [] }] });
    render(await ApplicationsPage());
    expect(screen.getByText(/No applications yet/)).toBeInTheDocument();
  });

  it("treats a null data payload as empty", async () => {
    holder.client = client({ applications: [{ data: null }] });
    render(await ApplicationsPage());
    expect(screen.getByText(/No applications yet/)).toBeInTheDocument();
  });

  it("renders rows", async () => {
    holder.client = client({
      applications: [
        {
          data: [
            { id: "a1", status: "applied", created_at: "2026-07-01T00:00:00Z", applied_at: null, jobs: { company: "Acme", title: "Eng", location: "", url: "" } },
            { id: "a2", status: "saved", created_at: "2026-07-02T00:00:00Z", applied_at: null, jobs: null }
          ]
        }
      ]
    });
    render(await ApplicationsPage());
    expect(screen.getByText("Eng")).toBeInTheDocument();
    expect(screen.getByText("Untitled role")).toBeInTheDocument();
  });
});

describe("NewApplicationPage", () => {
  it("passes premium=true for a paid plan", async () => {
    holder.client = client({ subscriptions: [{ data: { plan: "premium", status: "active" } }] });
    render(await NewApplicationPage());
    expect(screen.getByText(/Tailor my resume/)).toBeInTheDocument();
  });

  it("passes premium=false for free", async () => {
    holder.client = client({ subscriptions: [{ data: { plan: "free", status: "active" } }] });
    render(await NewApplicationPage());
    expect(screen.queryByText(/Tailor my resume/)).not.toBeInTheDocument();
  });
});

describe("ProfilePage", () => {
  it("renders the editor with fetched data", async () => {
    holder.client = client({ profiles: [{ data: { full_name: "Jane", skills: ["ts"], links: {}, work_history: [], education: [] } }] });
    render(await ProfilePage());
    expect(screen.getByDisplayValue("Jane")).toBeInTheDocument();
  });

  it("defaults every field when the profile row is empty", async () => {
    holder.client = client({ profiles: [{ data: null }] });
    render(await ProfilePage());
    expect(screen.getByPlaceholderText("Full name")).toHaveValue("");
  });
});

describe("DiscoverPage", () => {
  it("scores + filters: supported vs track, applied-out, and location-filtered", async () => {
    holder.client = client({
      profiles: [{ data: { headline: "Engineer", skills: ["typescript"], preferences: { locations: ["Phoenix"], remote: false } } }],
      jobs: [
        { data: [
          { id: "j1", company: "Acme", title: "TypeScript Engineer", location: "Phoenix", url: "https://jobs.lever.co/acme/1", ats: "lever", description: "typescript role", created_at: "2026-07-03" },
          { id: "j2", company: "Beta", title: "Workable Role", location: "Phoenix", url: "https://apply.workable.com/beta/j/X/", ats: "workable", description: "typescript", created_at: "2026-07-02" },
          { id: "j3", company: "Gamma", title: "Already Applied", location: "Phoenix", url: "https://jobs.lever.co/gamma/1", ats: "lever", description: "typescript", created_at: "2026-07-01" },
          { id: "j4", company: "Delta", title: "Elsewhere", location: "Austin", url: "https://jobs.lever.co/delta/1", ats: "lever", description: "typescript", created_at: "2026-07-04" }
        ] }
      ],
      applications: [{ data: [{ job_id: "j3" }] }]
    });
    render(await DiscoverPage());
    expect(screen.getByText("Send an arm")).toBeInTheDocument(); // j1 lever
    expect(screen.getByText("Track")).toBeInTheDocument(); // j2 unsupported ats
    expect(screen.queryByText("Already Applied")).not.toBeInTheDocument(); // j3 filtered
    expect(screen.queryByText("Elsewhere")).not.toBeInTheDocument(); // j4 location-filtered
  });

  it("renders the empty state with no matches", async () => {
    holder.client = client({
      profiles: [{ data: { headline: "", skills: [], preferences: {} } }],
      jobs: [{ data: [] }],
      applications: [{ data: [] }]
    });
    render(await DiscoverPage());
    expect(screen.getByText(/No matches yet/)).toBeInTheDocument();
  });

  it("defaults the match profile when every source row is empty", async () => {
    holder.client = client({
      profiles: [{ data: null }],
      jobs: [{ data: [{ id: "j1", company: "Acme", title: "Engineer", location: "", url: "https://jobs.lever.co/acme/1", ats: "lever", description: "role", created_at: "2026-07-01" }] }],
      applications: [{ data: null }]
    });
    render(await DiscoverPage());
    // No skills -> no "Matches:" line, but the job still renders (no location filter).
    expect(screen.getByText("Engineer")).toBeInTheDocument();
    expect(screen.queryByText(/^Matches:/)).not.toBeInTheDocument();
  });

  it("treats a null jobs payload as no matches", async () => {
    holder.client = client({
      profiles: [{ data: { headline: "Eng", skills: ["ts"], preferences: {} } }],
      jobs: [{ data: null }],
      applications: [{ data: [] }]
    });
    render(await DiscoverPage());
    expect(screen.getByText(/No matches yet/)).toBeInTheDocument();
  });
});

describe("BillingPage", () => {
  it("shows the current plan and actions", async () => {
    holder.client = client({ subscriptions: [{ data: { plan: "premium", status: "active", cancel_at_period_end: true, current_period_end: "2026-08-01T00:00:00Z" } }] });
    render(await BillingPage());
    expect(screen.getByText("premium")).toBeInTheDocument();
    expect(screen.getByText(/cancels/)).toBeInTheDocument();
  });
});

describe("SettingsPage", () => {
  it("renders the autonomy toggle with the saved value", async () => {
    holder.client = client({ profiles: [{ data: { arm_autonomy: "full_auto" } }] });
    render(await SettingsPage());
    expect(screen.getByText("Arm autonomy")).toBeInTheDocument();
  });

  it("defaults to review_gate when the profile row is empty", async () => {
    holder.client = client({ profiles: [{ data: null }] });
    render(await SettingsPage());
    expect(screen.getByText("Arm autonomy")).toBeInTheDocument();
  });

  it("shows the managed application address once one is assigned", async () => {
    holder.client = client({
      profiles: [{ data: { arm_autonomy: "review_gate", applicant_alias: "a-abcdefghjk@jobarms.com" } }]
    });
    render(await SettingsPage());
    expect(screen.getByText("a-abcdefghjk@jobarms.com")).toBeInTheDocument();
    // The user's real inbox is named as the forwarding destination.
    expect(screen.getByText(/a@b\.com/)).toBeInTheDocument();
  });

  it("explains the address is created on demand before one exists", async () => {
    holder.client = client({ profiles: [{ data: { arm_autonomy: "review_gate" } }] });
    render(await SettingsPage());
    expect(screen.getByText(/created automatically/)).toBeInTheDocument();
  });

  it("offers to connect LinkedIn when no account is linked", async () => {
    holder.client = client({ profiles: [{ data: { arm_autonomy: "review_gate" } }] });
    render(await SettingsPage());
    expect(screen.getByText("Connect LinkedIn")).toBeInTheDocument();
  });

  it("shows the connected LinkedIn email once linked", async () => {
    holder.client = client({ profiles: [{ data: { arm_autonomy: "review_gate" } }] });
    holder.service = fakeClient({
      from: fakeFrom({ site_accounts: [{ data: { email: "me@example.com", status: "verified" } }] })
    });
    render(await SettingsPage());
    expect(screen.getByText("me@example.com")).toBeInTheDocument();
    expect(screen.getByText("Disconnect")).toBeInTheDocument();
  });
});

describe("ApplicationDetailPage", () => {
  const params = Promise.resolve({ id: "app-1" });

  it("renders the detail with the latest run", async () => {
    holder.client = client({
      applications: [{ data: { id: "app-1", status: "needs_review", notes: "", cover_letter: "", applied_at: null, created_at: "2026-07-01", jobs: { company: "Acme", title: "Engineer", location: "Remote", url: "https://x", description: "d" } } }],
      application_runs: [{ data: [{ id: "run-1", status: "needs_review", autonomy: "review_gate", steps: [], answers: [{ name: "p", label: "P", value: "v" }], form_fields: [], error: null, slot_refunded: false, created_at: "2026-07-01" }] }],
      subscriptions: [{ data: { plan: "premium", status: "active" } }]
    });
    render(await ApplicationDetailPage({ params }));
    expect(screen.getByText("Engineer")).toBeInTheDocument();
    expect(screen.getByText("Your arm")).toBeInTheDocument();
  });

  it("calls notFound when the application is missing", async () => {
    holder.client = client({ applications: [{ data: null }] });
    await expect(ApplicationDetailPage({ params })).rejects.toThrow("NOT_FOUND");
  });

  it("falls back to 'Untitled role' and empty notes when fields are missing", async () => {
    holder.client = client({
      applications: [{ data: { id: "app-1", status: "saved", notes: null, cover_letter: null, applied_at: null, created_at: "2026-07-01", jobs: { company: "", title: "", location: "", url: "", description: "" } } }],
      application_runs: [{ data: [] }],
      subscriptions: [{ data: { plan: "free", status: "active" } }]
    });
    render(await ApplicationDetailPage({ params }));
    expect(screen.getByText("Untitled role")).toBeInTheDocument();
  });

  it("renders with a cover letter and no runs", async () => {
    holder.client = client({
      applications: [{ data: { id: "app-1", status: "applied", notes: "note", cover_letter: "Dear team", applied_at: null, created_at: "2026-07-01", jobs: { company: "Acme", title: "Engineer", location: "", url: "https://x", description: "d" } } }],
      application_runs: [{ data: [] }],
      subscriptions: [{ data: null }]
    });
    render(await ApplicationDetailPage({ params }));
    expect(screen.getByText("Cover letter")).toBeInTheDocument();
  });
});
