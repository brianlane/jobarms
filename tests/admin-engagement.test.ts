import { describe, expect, it } from "vitest";
import { activeUserCounts, cohortRetention, onboardingFunnel } from "@/lib/admin/engagement";
import type { AdminProfileRow } from "@/lib/admin/overview";
import type { AuthDirectoryEntry } from "@/lib/admin/users-table";

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

function directory(entries: [string, string | null][]): Map<string, AuthDirectoryEntry> {
  return new Map(
    entries.map(([id, lastSignInAt]) => [id, { lastSignInAt, emailConfirmedAt: null }])
  );
}

describe("activeUserCounts", () => {
  it("counts nested active windows and never-signed-in accounts", () => {
    const counts = activeUserCounts(
      directory([
        ["today", "2026-07-15T06:00:00Z"],
        ["thisWeek", "2026-07-11T00:00:00Z"],
        ["thisMonth", "2026-06-30T00:00:00Z"],
        ["longAgo", "2026-01-01T00:00:00Z"],
        ["never", null],
        ["unreadable", "nonsense"]
      ]),
      NOW
    );

    expect(counts.daily).toBe(1);
    expect(counts.weekly).toBe(2);
    expect(counts.monthly).toBe(3);
    expect(counts.neverSignedIn).toBe(2);
    expect(counts.stickinessPct).toBe(33);
  });

  it("claims no stickiness with nobody active", () => {
    expect(activeUserCounts(directory([["never", null]]), NOW).stickinessPct).toBe(0);
  });
});

describe("onboardingFunnel", () => {
  it("measures each step against all signups and reports the drop", () => {
    const steps = onboardingFunnel({
      profiles: [
        profile({ id: "full" }),
        profile({ id: "applied" }),
        profile({ id: "onboarded" }),
        profile({ id: "resumeOnly", onboarding_complete: false }),
        profile({ id: "empty", onboarding_complete: false })
      ],
      resumeUserIds: new Set(["full", "applied", "onboarded", "resumeOnly"]),
      applicationUserIds: new Set(["full", "applied"]),
      submittedUserIds: new Set(["full"])
    });

    expect(steps.map((step) => [step.label, step.users, step.sharePct])).toEqual([
      ["Signed up", 5, 100],
      ["Uploaded a resume", 4, 80],
      ["Finished onboarding", 3, 60],
      ["Tracked a job", 2, 40],
      ["Landed an application", 1, 20]
    ]);
    expect(steps.map((step) => step.lost)).toEqual([0, 1, 1, 1, 1]);
  });

  it("reports zeroes on an empty platform", () => {
    const steps = onboardingFunnel({
      profiles: [],
      resumeUserIds: new Set(),
      applicationUserIds: new Set(),
      submittedUserIds: new Set()
    });
    expect(steps.every((step) => step.users === 0 && step.sharePct === 0)).toBe(true);
  });

  it("never reads above 100% when a user skipped a step", () => {
    const steps = onboardingFunnel({
      profiles: [profile({ id: "skipper", onboarding_complete: false })],
      resumeUserIds: new Set(),
      applicationUserIds: new Set(["skipper"]),
      submittedUserIds: new Set(["skipper"])
    });
    expect(steps.every((step) => step.sharePct <= 100)).toBe(true);
    expect(steps.find((step) => step.label === "Tracked a job")!.users).toBe(1);
  });
});

describe("cohortRetention", () => {
  it("groups signups into weeks starting Monday and measures who came back", () => {
    const cohorts = cohortRetention(
      [
        // Wednesday and Friday of the same week.
        profile({ id: "a", created_at: "2026-07-08T00:00:00Z" }),
        profile({ id: "b", created_at: "2026-07-10T00:00:00Z" }),
        // A Sunday, which belongs to the week that STARTED the previous Monday.
        profile({ id: "c", created_at: "2026-07-05T00:00:00Z" }),
        // Outside the window.
        profile({ id: "old", created_at: "2026-01-01T00:00:00Z" }),
        // In the future, and unreadable.
        profile({ id: "future", created_at: "2027-01-01T00:00:00Z" }),
        profile({ id: "broken", created_at: "nonsense" })
      ],
      directory([
        ["a", "2026-07-14T00:00:00Z"],
        ["b", null],
        ["c", "2026-02-01T00:00:00Z"]
      ]),
      8,
      NOW
    );

    expect(cohorts.map((cohort) => cohort.weekStart)).toEqual(["2026-06-29", "2026-07-06"]);
    expect(cohorts[0]).toMatchObject({ signups: 1, stillActive: 0, retentionPct: 0 });
    expect(cohorts[1]).toMatchObject({ signups: 2, stillActive: 1, retentionPct: 50 });
  });

  it("is empty with no signups in the window, and defaults its arguments", () => {
    expect(cohortRetention([], new Map())).toEqual([]);
  });
});
