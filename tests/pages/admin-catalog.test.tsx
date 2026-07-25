// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { CatalogJobRow, CompanyRow } from "@/lib/admin/catalog";
import type { AdminApplicationRow, AdminProfileRow, CatalogSummary } from "@/lib/admin/overview";
import type { AuthDirectory } from "@/lib/admin/reads";

const holder = vi.hoisted(() => ({
  summary: null as unknown,
  companies: [] as unknown[],
  jobs: [] as unknown[],
  applicationSources: [] as unknown[],
  profiles: [] as unknown[],
  applications: [] as unknown[],
  directory: null as unknown,
  resumeOwners: new Set<string>(),
  submittedOwners: new Set<string>()
}));

vi.mock("@/lib/admin/reads", async () => {
  const actual = await vi.importActual<typeof import("@/lib/admin/reads")>("@/lib/admin/reads");
  return {
    ...actual,
    loadCatalogSummary: vi.fn(async () => holder.summary),
    loadCompanies: vi.fn(async () => holder.companies),
    loadRecentJobs: vi.fn(async () => holder.jobs),
    loadApplicationSources: vi.fn(async () => holder.applicationSources),
    loadProfiles: vi.fn(async () => holder.profiles),
    loadApplications: vi.fn(async () => holder.applications),
    loadAuthDirectory: vi.fn(async () => holder.directory),
    loadResumeOwners: vi.fn(async () => holder.resumeOwners),
    loadSubmittedOwners: vi.fn(async () => holder.submittedOwners)
  };
});

import AdminCatalogPage from "@/app/admin/(protected)/catalog/page";
import AdminEngagementPage from "@/app/admin/(protected)/engagement/page";

const NOW_ISO = new Date().toISOString();
const RECENT_ISO = new Date(Date.now() - 60 * 60 * 1000).toISOString();
const OLD_ISO = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();

function summary(over: Partial<CatalogSummary> = {}): CatalogSummary {
  return {
    jobs: 4200,
    jobsAdded24h: 88,
    companies: 3,
    byAts: {},
    newestJobAt: RECENT_ISO,
    ...over
  };
}

function company(over: Partial<CompanyRow> = {}): CompanyRow {
  return {
    id: "c1",
    name: "Acme",
    ats: "lever",
    board_token: "acme",
    active: true,
    last_ingested_at: RECENT_ISO,
    created_at: OLD_ISO,
    ...over
  };
}

function job(over: Partial<CatalogJobRow> = {}): CatalogJobRow {
  return {
    ats: "lever",
    source: "ingest:lever",
    company: "Acme",
    created_at: RECENT_ISO,
    ...over
  };
}

function profile(over: Partial<AdminProfileRow> = {}): AdminProfileRow {
  return {
    id: "u1",
    email: "one@x.com",
    created_at: RECENT_ISO,
    onboarding_complete: true,
    arm_autonomy: "review_gate",
    ...over
  };
}

function application(over: Partial<AdminApplicationRow> = {}): AdminApplicationRow {
  return {
    id: "a1",
    user_id: "u1",
    status: "applied",
    source: "arm",
    created_at: RECENT_ISO,
    applied_at: RECENT_ISO,
    ...over
  };
}

function directory(clipped = false): AuthDirectory {
  return {
    byId: new Map([
      ["u1", { lastSignInAt: NOW_ISO, emailConfirmedAt: NOW_ISO }],
      ["u2", { lastSignInAt: null, emailConfirmedAt: null }]
    ]),
    clipped
  };
}

beforeEach(() => {
  holder.summary = summary();
  holder.companies = [
    company(),
    company({ id: "c2", name: "Quiet Co", last_ingested_at: OLD_ISO }),
    company({ id: "c3", name: "Paused Co", active: false, last_ingested_at: null })
  ];
  holder.jobs = [job(), job(), job({ ats: "greenhouse", source: "ingest:greenhouse" })];
  holder.applicationSources = [
    { jobs: { source: "ingest:lever" } },
    { jobs: { source: "manual" } }
  ];
  holder.profiles = [profile(), profile({ id: "u2", email: "two@x.com", onboarding_complete: false })];
  holder.applications = [application()];
  holder.directory = directory();
  holder.resumeOwners = new Set(["u1"]);
  holder.submittedOwners = new Set(["u1"]);
});

describe("AdminCatalogPage", () => {
  it("renders totals, mix, freshness, attribution, and the board list", async () => {
    render(await AdminCatalogPage());

    expect(screen.getByText("Job catalog")).toBeInTheDocument();
    expect(screen.getByText("4,200")).toBeInTheDocument();
    expect(screen.getByText("cron is producing")).toBeInTheDocument();

    // Mix and freshness.
    expect(screen.getAllByText("lever").length).toBeGreaterThan(0);
    expect(screen.getAllByText("producing").length).toBeGreaterThan(0);
    expect(screen.getAllByText("quiet").length).toBeGreaterThan(0);
    expect(screen.getAllByText("nothing in the window").length).toBeGreaterThan(0);

    // Attribution.
    expect(screen.getByText(/50% of applications came from the catalog/)).toBeInTheDocument();

    // Boards: a stale one and a paused one both call themselves out.
    expect(screen.getByText("Quiet Co")).toBeInTheDocument();
    expect(screen.getByText("paused")).toBeInTheDocument();
    expect(screen.getByText("1 stale")).toBeInTheDocument();
  });

  it("renders an empty catalog with a stalled sweep", async () => {
    holder.summary = summary({ jobs: 0, jobsAdded24h: 0, companies: 0, newestJobAt: null });
    holder.companies = [];
    holder.jobs = [];
    holder.applicationSources = [];
    render(await AdminCatalogPage());

    expect(screen.getByText("the cron may be stalled")).toBeInTheDocument();
    expect(screen.getByText("No jobs ingested in the window.")).toBeInTheDocument();
    expect(screen.getByText(/No companies seeded/)).toBeInTheDocument();
  });
});

describe("AdminEngagementPage", () => {
  it("renders active counts, the funnel, segments, and cohorts", async () => {
    render(await AdminEngagementPage());

    expect(screen.getByText("Engagement")).toBeInTheDocument();
    expect(screen.getByText("Active today")).toBeInTheDocument();
    expect(screen.getByText("Signed up")).toBeInTheDocument();
    expect(screen.getByText("Landed an application")).toBeInTheDocument();
    expect(screen.getByText(/did not get this far/)).toBeInTheDocument();
    expect(screen.getByText("active")).toBeInTheDocument();
    expect(screen.getByText("new")).toBeInTheDocument();
    expect(screen.getByText("Weekly cohorts")).toBeInTheDocument();
    expect(screen.getByText("50%")).toBeInTheDocument();
  });

  it("warns when the auth directory scan was truncated", async () => {
    holder.directory = directory(true);
    render(await AdminEngagementPage());
    expect(screen.getByText(/scan was truncated/)).toBeInTheDocument();
  });

  it("renders an empty platform with no cohorts", async () => {
    holder.profiles = [];
    holder.applications = [];
    holder.directory = { byId: new Map(), clipped: false };
    holder.resumeOwners = new Set();
    holder.submittedOwners = new Set();
    render(await AdminEngagementPage());
    expect(screen.getByText("No signups in the last eight weeks.")).toBeInTheDocument();
  });

  it("flags a poorly retained cohort", async () => {
    holder.profiles = [profile(), profile({ id: "u2" }), profile({ id: "u3" })];
    holder.directory = {
      byId: new Map([
        ["u1", { lastSignInAt: NOW_ISO, emailConfirmedAt: null }],
        ["u2", { lastSignInAt: null, emailConfirmedAt: null }],
        ["u3", { lastSignInAt: null, emailConfirmedAt: null }]
      ]),
      clipped: false
    };
    render(await AdminEngagementPage());
    expect(screen.getByText("33%")).toBeInTheDocument();
  });

  it("shows a well-retained cohort in the healthy colour", async () => {
    holder.profiles = [profile(), profile({ id: "u2" })];
    holder.directory = {
      byId: new Map([
        ["u1", { lastSignInAt: NOW_ISO, emailConfirmedAt: null }],
        ["u2", { lastSignInAt: NOW_ISO, emailConfirmedAt: null }]
      ]),
      clipped: false
    };
    render(await AdminEngagementPage());
    expect(screen.getByText("100%")).toBeInTheDocument();
  });
});
