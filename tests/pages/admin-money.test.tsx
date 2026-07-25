// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { SpendEventRow } from "@/lib/admin/spend";
import type { AdminProfileRow, AdminSubscriptionRow } from "@/lib/admin/overview";
import type { AdminRunRow } from "@/lib/admin/run-stats";

const holder = vi.hoisted(() => ({
  events: [] as unknown[],
  profiles: [] as unknown[],
  subscriptions: [] as unknown[],
  runs: [] as unknown[]
}));

vi.mock("@/lib/admin/reads", async () => {
  const actual = await vi.importActual<typeof import("@/lib/admin/reads")>("@/lib/admin/reads");
  return {
    ...actual,
    loadSpendEvents: vi.fn(async () => holder.events),
    loadProfiles: vi.fn(async () => holder.profiles),
    loadSubscriptions: vi.fn(async () => holder.subscriptions),
    loadRecentRuns: vi.fn(async () => holder.runs)
  };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

import AdminAiPage from "@/app/admin/(protected)/ai/page";
import AdminRevenuePage from "@/app/admin/(protected)/revenue/page";

const TODAY = new Date().toISOString().slice(0, 10);

function event(over: Partial<SpendEventRow> = {}): SpendEventRow {
  return {
    user_id: "u1",
    run_id: null,
    kind: "resume_parse",
    model: "gemini-3.6-flash",
    used_fallback: false,
    input_tokens: 1000,
    output_tokens: 200,
    cost_micros: 3000,
    day: TODAY,
    created_at: new Date().toISOString(),
    ...over
  };
}

function profile(over: Partial<AdminProfileRow> = {}): AdminProfileRow {
  return {
    id: "u1",
    email: "one@x.com",
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
    updated_at: "2026-07-05T00:00:00Z",
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
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...over
  };
}

beforeEach(() => {
  holder.events = [
    event(),
    event({ kind: "arm_answers", cost_micros: 900_000, run_id: "r1" }),
    event({ kind: "vision_recovery", user_id: null, cost_micros: 400, model: "" }),
    // A surface with no display label yet, and a free user who costs us money.
    event({ kind: "future_surface", user_id: "u3", cost_micros: 200 }),
    // A paying user who costs more than they pay: the one number on this page
    // that should worry someone.
    event({
      user_id: "u2",
      cost_micros: 25_000_000,
      used_fallback: true,
      model: "some-future-model"
    })
  ];
  holder.profiles = [
    profile(),
    profile({ id: "u2", email: "two@x.com" }),
    profile({ id: "u3", email: "three@x.com" })
  ];
  holder.subscriptions = [sub(), sub({ user_id: "u2" })];
  holder.runs = [run(), run({ id: "r2", status: "failed" })];
});

describe("AdminAiPage", () => {
  it("renders spend by surface, model, and user with unit economics", async () => {
    render(await AdminAiPage());

    expect(screen.getByText("AI spend")).toBeInTheDocument();
    expect(screen.getByText("Application answers")).toBeInTheDocument();
    expect(screen.getByText("Vision recovery")).toBeInTheDocument();
    // A blank model reads as unknown rather than an empty cell.
    expect(screen.getByText("unknown")).toBeInTheDocument();
    // One fallback call of five.
    expect(screen.getByText("20% fallback")).toBeInTheDocument();
    // The free user with cost is underwater; the premium user is not.
    expect(screen.getByText("1 paying underwater")).toBeInTheDocument();
    // An unlabelled surface falls back to its raw kind, and a free payer shows
    // the free badge next to the paid ones.
    expect(screen.getByText("future_surface")).toBeInTheDocument();
    expect(screen.getByText("free")).toBeInTheDocument();
    expect(screen.getByText(/priced at the primary model rate/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "one@x.com" })).toBeInTheDocument();
  });

  it("renders an empty ledger without claiming a per-application cost", async () => {
    holder.events = [];
    holder.runs = [];
    render(await AdminAiPage());
    expect(screen.getAllByText("Nothing in the ledger yet.").length).toBe(2);
    expect(screen.getByText("No user-attributed spend in the window.")).toBeInTheDocument();
    expect(screen.getByText("no fallback")).toBeInTheDocument();
  });
});

describe("AdminRevenuePage", () => {
  it("renders MRR, conversion, and the billing problem list", async () => {
    holder.subscriptions = [
      sub(),
      sub({ user_id: "u2", status: "past_due", updated_at: "2026-07-14T00:00:00Z" }),
      sub({ user_id: "u3", status: "unpaid", updated_at: null })
    ];
    render(await AdminRevenuePage());

    expect(screen.getByText("Revenue")).toBeInTheDocument();
    expect(screen.getByText("MRR")).toBeInTheDocument();
    expect(screen.getByText("2 to fix")).toBeInTheDocument();
    expect(screen.getByText("past due")).toBeInTheDocument();
    expect(screen.getByText(/median .*d to convert/)).toBeInTheDocument();
    expect(screen.getByText(/reconstructed from when each paying subscription/)).toBeInTheDocument();
  });

  it("renders the healthy case with nothing to fix and no conversions yet", async () => {
    holder.subscriptions = [];
    holder.events = [];
    render(await AdminRevenuePage());
    expect(screen.getByText("No failed or stuck payments.")).toBeInTheDocument();
    expect(screen.getByText(/0 of 3 signups/)).toBeInTheDocument();
  });

  it("flags a negative margin when model spend outruns revenue", async () => {
    holder.subscriptions = [];
    holder.events = [event({ cost_micros: 50_000_000 })];
    render(await AdminRevenuePage());
    expect(screen.getByText("-$50")).toBeInTheDocument();
  });

  it("shows pending churn when a paid plan is set to cancel", async () => {
    holder.subscriptions = [sub({ cancel_at_period_end: true })];
    render(await AdminRevenuePage());
    expect(screen.getByText("1 canceling at period end")).toBeInTheDocument();
  });
});
