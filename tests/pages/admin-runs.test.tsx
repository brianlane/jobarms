// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { AdminRunWithJob } from "@/lib/admin/reads";
import type { AdminRunDetail } from "@/lib/admin/run-detail";
import type { FieldStatRow, PlaybookRow } from "@/lib/admin/ats-health";

const holder = vi.hoisted(() => ({
  runs: [] as unknown[],
  profiles: [] as unknown[],
  playbooks: [] as unknown[],
  fieldStats: [] as unknown[],
  detail: null as unknown
}));

vi.mock("@/lib/admin/reads", async () => {
  const actual = await vi.importActual<typeof import("@/lib/admin/reads")>("@/lib/admin/reads");
  return {
    ...actual,
    loadRunsWithJobs: vi.fn(async () => holder.runs),
    loadProfiles: vi.fn(async () => holder.profiles),
    loadPlaybooks: vi.fn(async () => holder.playbooks),
    loadFieldStats: vi.fn(async () => holder.fieldStats)
  };
});
vi.mock("@/lib/admin/run-detail", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/admin/run-detail")>("@/lib/admin/run-detail");
  return { ...actual, loadRunDetail: vi.fn(async () => holder.detail) };
});
vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("NOT_FOUND");
  }),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() })
}));

import AdminRunsPage from "@/app/admin/(protected)/runs/page";
import AdminRunDetailPage from "@/app/admin/(protected)/runs/[id]/page";
import AdminAtsPage from "@/app/admin/(protected)/ats/page";

const NOW_ISO = new Date().toISOString();

function run(over: Partial<AdminRunWithJob> = {}): AdminRunWithJob {
  return {
    id: "r1",
    user_id: "u1",
    application_id: "a1",
    status: "submitted",
    autonomy: "review_gate",
    error: null,
    created_at: NOW_ISO,
    updated_at: NOW_ISO,
    slot_refunded: false,
    canceled_by: null,
    steps: [
      { step: "navigate", at: "2026-07-15T10:00:00Z" },
      { step: "form_extracted", at: "2026-07-15T10:00:20Z" },
      { step: "answers_generated", at: "2026-07-15T10:01:00Z" },
      { step: "review_requested", at: "2026-07-15T10:01:05Z" },
      { step: "approved", at: "2026-07-15T10:30:00Z" },
      { step: "submitted", at: "2026-07-15T10:30:40Z" }
    ],
    applications: {
      id: "a1",
      status: "applied",
      jobs: { company: "Acme", title: "Engineer", ats: "lever", url: "https://x" }
    },
    ...over
  };
}

function detail(over: Partial<AdminRunDetail> = {}): AdminRunDetail {
  return {
    id: "r1",
    user_id: "u1",
    application_id: "a1",
    status: "failed",
    autonomy: "full_auto",
    error: "captcha_blocked: the employer blocked the submit",
    created_at: NOW_ISO,
    updated_at: NOW_ISO,
    slot_refunded: true,
    canceled_by: "system",
    steps: [
      { step: "navigate", at: NOW_ISO, detail: "reached the posting" },
      { step: "form_extracted", at: NOW_ISO }
    ],
    answers: [
      { label: "Full name", value: "Bri Lane", type: "text", edited: true },
      { label: "", name: "phone", value: "   ", type: "tel" },
      { name: "cover", value: "text", skipped: true, type: "textarea" },
      { value: "kept", type: "text" },
      { label: "No type recorded" }
    ],
    formFieldCount: 12,
    screenshots: [{ path: "u1/r1/one.png", url: "https://signed.example/one" }],
    month_key: "2026-07",
    tenant_host: "acme.wd1.myworkdayjobs.com",
    workflow_instance_id: "wf-1",
    user: { id: "u1", email: "one@x.com" },
    application: {
      id: "a1",
      status: "failed",
      company: "Acme",
      title: "Engineer",
      ats: "workday",
      url: "https://x"
    },
    ...over
  };
}

function playbook(over: Partial<PlaybookRow> = {}): PlaybookRow {
  return {
    domain: "careers.acme.com",
    ats: "greenhouse",
    strategy: { action: "click", click_text: "Apply now" },
    success_count: 8,
    failure_count: 1,
    last_success_at: NOW_ISO,
    updated_at: NOW_ISO,
    ...over
  };
}

function fieldStat(over: Partial<FieldStatRow> = {}): FieldStatRow {
  return {
    ats: "lever",
    question_key: "work_auth",
    label_example: "Are you authorized to work?",
    field_type: "select",
    times_seen: 10,
    times_skipped: 1,
    times_edited: 2,
    option_counts: { Yes: 8, No: 1 },
    updated_at: NOW_ISO,
    ...over
  };
}

beforeEach(() => {
  holder.runs = [
    run(),
    run({
      id: "r2",
      status: "failed",
      error: "form_not_found: nothing there",
      autonomy: "full_auto",
      steps: [{ step: "navigate", at: "2026-07-15T10:00:00Z" }],
      applications: {
        id: "a2",
        status: "failed",
        jobs: { company: "", title: "", ats: "greenhouse", url: "https://y" }
      }
    }),
    run({
      id: "r3",
      status: "canceled",
      canceled_by: "user",
      slot_refunded: true,
      user_id: "ghost",
      steps: null,
      applications: null
    })
  ];
  holder.profiles = [
    {
      id: "u1",
      email: "one@x.com",
      created_at: NOW_ISO,
      onboarding_complete: true,
      arm_autonomy: "review_gate"
    }
  ];
  holder.playbooks = [playbook(), playbook({ domain: "bad.com", success_count: 1, failure_count: 5 })];
  holder.fieldStats = [
    fieldStat(),
    fieldStat({
      question_key: "start_date",
      label_example: "",
      field_type: "text",
      option_counts: {},
      times_seen: 4,
      times_skipped: 3
    })
  ];
  holder.detail = detail();
});

describe("AdminRunsPage", () => {
  it("renders the unfiltered console with funnel, durations, and failures", async () => {
    render(await AdminRunsPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByText("Arm runs")).toBeInTheDocument();
    expect(screen.getByText("Reached the page")).toBeInTheDocument();
    expect(screen.getByText("Navigate to form found")).toBeInTheDocument();
    expect(screen.getByText("form_not_found")).toBeInTheDocument();
    expect(screen.getAllByText(/stopped before this step/).length).toBeGreaterThan(0);

    // Rows: a titled job, an untitled one, and a run whose user is unknown.
    expect(screen.getByText(/Engineer/)).toBeInTheDocument();
    expect(screen.getAllByText(/Untitled role/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/unknown company/).length).toBeGreaterThan(0);
    expect(screen.getByText("ghost")).toBeInTheDocument();
    expect(screen.getByText("refunded (user)")).toBeInTheDocument();
  });

  it("filters by status, ats, and mode", async () => {
    render(
      await AdminRunsPage({
        searchParams: Promise.resolve({ status: "failed", ats: "greenhouse", autonomy: "full_auto" })
      })
    );
    expect(screen.getByText(/showing 1 of 1/)).toBeInTheDocument();
    expect(screen.getByText("form_not_found")).toBeInTheDocument();
  });

  it("filters by ats alone, so non-matching platforms drop out", async () => {
    render(await AdminRunsPage({ searchParams: Promise.resolve({ ats: "lever" }) }));
    expect(screen.getByText(/showing 1 of 1/)).toBeInTheDocument();
  });

  it("filters by mode alone, and a healthy slice reads as a good submit rate", async () => {
    render(await AdminRunsPage({ searchParams: Promise.resolve({ autonomy: "review_gate" }) }));
    // The one full-auto run drops out; of the two finished review-gate runs one
    // submitted, which is the threshold where the rate stops reading as a worry.
    expect(screen.getByText(/showing 2 of 2/)).toBeInTheDocument();
    expect(screen.getByText("50%")).toBeInTheDocument();
  });

  it("says so when the filters match nothing", async () => {
    render(await AdminRunsPage({ searchParams: Promise.resolve({ status: "queued" }) }));
    expect(screen.getAllByText("No runs match these filters.").length).toBe(2);
  });

  it("renders with no runs at all", async () => {
    holder.runs = [];
    render(await AdminRunsPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByText("No failures in this slice.")).toBeInTheDocument();
  });
});

describe("AdminRunDetailPage", () => {
  it("404s on an unknown run", async () => {
    holder.detail = null;
    await expect(
      AdminRunDetailPage({ params: Promise.resolve({ id: "nope" }) })
    ).rejects.toThrow("NOT_FOUND");
  });

  it("renders the forensics view of a failed run", async () => {
    render(await AdminRunDetailPage({ params: Promise.resolve({ id: "r1" }) }));

    expect(screen.getByRole("heading", { name: "Engineer" })).toBeInTheDocument();
    expect(screen.getByText(/Acme · workday/)).toBeInTheDocument();
    expect(screen.getByText("captcha_blocked: the employer blocked the submit")).toBeInTheDocument();
    expect(screen.getByText(/anti-bot check blocked/)).toBeInTheDocument();
    expect(screen.getByText("slot refunded")).toBeInTheDocument();
    expect(screen.getByText("canceled by system")).toBeInTheDocument();
    expect(screen.getByText("wf-1")).toBeInTheDocument();
    expect(screen.getByText("acme.wd1.myworkdayjobs.com")).toBeInTheDocument();

    // Answers: labelled, unlabelled, edited, skipped, and blank all render.
    expect(screen.getByText("Full name")).toBeInTheDocument();
    expect(screen.getByText("user edited")).toBeInTheDocument();
    expect(screen.getByText("phone")).toBeInTheDocument();
    expect(screen.getByText("unlabelled field")).toBeInTheDocument();
    expect(screen.getAllByText("skipped").length).toBe(3);
    expect(screen.getByText("No type recorded")).toBeInTheDocument();

    expect(screen.getByRole("img")).toHaveAttribute("src", "https://signed.example/one");
    expect(screen.getByText("reached the posting")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refund again" })).toBeInTheDocument();
  });

  it("renders a bare successful run with nothing optional set", async () => {
    holder.detail = detail({
      status: "submitted",
      error: null,
      slot_refunded: false,
      canceled_by: null,
      steps: [],
      answers: [],
      screenshots: [],
      month_key: "",
      tenant_host: null,
      workflow_instance_id: null,
      user: null,
      application: null
    });
    render(await AdminRunDetailPage({ params: Promise.resolve({ id: "r1" }) }));

    expect(screen.getByRole("heading", { name: "Arm run" })).toBeInTheDocument();
    expect(screen.getByText("The application behind this run is gone")).toBeInTheDocument();
    expect(screen.getByText("The arm never logged a step.")).toBeInTheDocument();
    expect(screen.getByText("No answers were drafted.")).toBeInTheDocument();
    expect(screen.getByText("No screenshots were captured.")).toBeInTheDocument();
    expect(screen.getByText("never started")).toBeInTheDocument();
    expect(screen.getByText("not account-gated")).toBeInTheDocument();
    expect(screen.getByText("slot consumed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refund slot" })).toBeInTheDocument();
  });

  it("renders an application with no posting url", async () => {
    holder.detail = detail({
      application: {
        id: "a1",
        status: "failed",
        company: "",
        title: "Engineer",
        ats: "lever",
        url: ""
      }
    });
    render(await AdminRunDetailPage({ params: Promise.resolve({ id: "r1" }) }));
    expect(screen.getByText("no url")).toBeInTheDocument();
    expect(screen.getByText(/unknown company · lever/)).toBeInTheDocument();
  });

  it("names an unnamed step", async () => {
    holder.detail = detail({ steps: [{ at: NOW_ISO }] });
    render(await AdminRunDetailPage({ params: Promise.resolve({ id: "r1" }) }));
    expect(screen.getByText("unnamed")).toBeInTheDocument();
  });
});

describe("AdminAtsPage", () => {
  it("renders per-platform health, playbooks, and learned fields", async () => {
    render(await AdminAtsPage());

    expect(screen.getByText("ATS health")).toBeInTheDocument();
    // "lever" shows both as a platform row and as a field-stat column value.
    expect(screen.getAllByText("lever").length).toBeGreaterThan(0);
    expect(screen.getAllByText("greenhouse").length).toBeGreaterThan(0);
    expect(screen.getByText("unknown")).toBeInTheDocument();

    // A decaying playbook is flagged and sorted to the top.
    expect(screen.getByText("bad.com")).toBeInTheDocument();
    expect(screen.getByText("decaying")).toBeInTheDocument();
    expect(screen.getByText("1 decaying")).toBeInTheDocument();

    // The guiding badge comes from the same thresholds the arm prompt uses.
    expect(screen.getAllByText("Are you authorized to work?").length).toBeGreaterThan(0);
    expect(screen.getAllByText("guiding").length).toBe(2);
    // A row with no human label falls back to its normalized key.
    expect(screen.getByText("start_date")).toBeInTheDocument();
    expect(screen.getByText("Yes (89%)")).toBeInTheDocument();
  });

  it("renders the empty platform with nothing learned yet", async () => {
    holder.runs = [];
    holder.playbooks = [];
    holder.fieldStats = [];
    render(await AdminAtsPage());
    expect(screen.getByText("No runs in the window.")).toBeInTheDocument();
    expect(screen.getByText(/No playbooks yet/)).toBeInTheDocument();
    expect(screen.getByText(/Nothing aggregated yet/)).toBeInTheDocument();
  });

  it("shows a platform with nothing finished as having no rate", async () => {
    holder.runs = [run({ status: "needs_review", applications: null })];
    render(await AdminAtsPage());
    expect(screen.getAllByText("-").length).toBeGreaterThan(0);
  });
});
