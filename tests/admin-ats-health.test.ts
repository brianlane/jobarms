import { describe, expect, it } from "vitest";
import {
  describeStrategy,
  summarizeAtsHealth,
  viewFieldStats,
  viewPlaybooks,
  type AtsRunRow,
  type FieldStatRow,
  type PlaybookRow
} from "@/lib/admin/ats-health";

function atsRun(over: Partial<AtsRunRow> = {}): AtsRunRow {
  return { status: "submitted", error: null, autonomy: "review_gate", ats: "lever", ...over };
}

function playbook(over: Partial<PlaybookRow> = {}): PlaybookRow {
  return {
    domain: "careers.acme.com",
    ats: "greenhouse",
    strategy: { action: "click", click_text: "Apply now" },
    success_count: 5,
    failure_count: 1,
    last_success_at: "2026-07-14T00:00:00Z",
    updated_at: "2026-07-14T00:00:00Z",
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
    times_skipped: 2,
    times_edited: 3,
    option_counts: { Yes: 7, No: 1 },
    updated_at: "2026-07-14T00:00:00Z",
    ...over
  };
}

describe("summarizeAtsHealth", () => {
  it("aggregates per platform, busiest first, with the biggest failure bucket", () => {
    const rows = summarizeAtsHealth([
      atsRun({ ats: "lever", status: "submitted" }),
      atsRun({ ats: "lever", status: "failed", error: "form_not_found: gone" }),
      atsRun({ ats: "lever", status: "failed", error: "form_not_found: gone again" }),
      atsRun({ ats: "lever", status: "failed", error: "captcha_blocked: blocked" }),
      atsRun({ ats: "lever", status: "canceled" }),
      atsRun({ ats: "lever", status: "needs_review" }),
      atsRun({ ats: "greenhouse", status: "submitted" }),
      // An empty ats string is normalized rather than becoming its own row.
      atsRun({ ats: "", status: "needs_review" })
    ]);

    expect(rows.map((row) => row.ats)).toEqual(["lever", "greenhouse", "unknown"]);

    const lever = rows[0];
    expect(lever).toMatchObject({
      runs: 6,
      submitted: 1,
      failed: 3,
      canceled: 1,
      finished: 5,
      topFailure: "form_not_found",
      topFailureCount: 2
    });
    expect(lever.successRatePct).toBe(20);

    // Nothing has finished on the unknown bucket, so there is no rate to claim.
    expect(rows[2].successRatePct).toBeNull();
    expect(rows[2].topFailure).toBeNull();
    expect(rows[2].topFailureCount).toBe(0);
  });

  it("is empty with no runs", () => {
    expect(summarizeAtsHealth([])).toEqual([]);
  });
});

describe("describeStrategy", () => {
  it("reads each recovery action as a sentence", () => {
    expect(describeStrategy({ action: "click", click_text: "Apply" })).toBe('click "Apply"');
    expect(describeStrategy({ action: "click" })).toBe('click "an apply control"');
    expect(describeStrategy({ action: "iframe" })).toContain("iframe");
    expect(describeStrategy({ action: "scroll" })).toContain("scroll");
    expect(describeStrategy({ action: "teleport" })).toBe("teleport");
    expect(describeStrategy({})).toBe("unknown");
    expect(describeStrategy(null)).toBe("unknown strategy");
  });
});

describe("viewPlaybooks", () => {
  it("puts decaying playbooks first and computes the hit rate", () => {
    const rows = viewPlaybooks([
      playbook({ domain: "good.com", success_count: 9, failure_count: 1 }),
      playbook({ domain: "bad.com", success_count: 1, failure_count: 6 }),
      playbook({ domain: "better.com", success_count: 20, failure_count: 0 }),
      playbook({ domain: "fresh.com", success_count: 0, failure_count: 0, strategy: null })
    ]);

    expect(rows.map((row) => row.domain)).toEqual([
      "bad.com",
      "better.com",
      "good.com",
      "fresh.com"
    ]);
    expect(rows[0].decaying).toBe(true);
    expect(rows[0].successRatePct).toBe(14);
    expect(rows[1].decaying).toBe(false);
    expect(rows[1].successRatePct).toBe(100);
    // A row with no attempts yet cannot claim a rate.
    expect(rows[3].successRatePct).toBe(0);
    expect(rows[3].summary).toBe("unknown strategy");
  });

  it("is empty with no playbooks", () => {
    expect(viewPlaybooks([])).toEqual([]);
  });
});

describe("viewFieldStats", () => {
  it("derives rates and the majority option, most-seen first", () => {
    const rows = viewFieldStats(
      [
        fieldStat({ question_key: "work_auth", times_seen: 10 }),
        fieldStat({ question_key: "start_date", times_seen: 20, option_counts: {}, field_type: "text" }),
        fieldStat({ question_key: "zero", times_seen: 0, times_skipped: 0, times_edited: 0, option_counts: {} })
      ],
      new Set(["work_auth"])
    );

    expect(rows.map((row) => row.question_key)).toEqual(["start_date", "work_auth", "zero"]);

    const auth = rows.find((row) => row.question_key === "work_auth")!;
    expect(auth.skipRatePct).toBe(20);
    expect(auth.editRatePct).toBe(30);
    expect(auth.topOption).toEqual({ value: "Yes", sharePct: 88 });
    expect(auth.guiding).toBe(true);

    // Free-text questions carry no option counts, so there is no majority.
    expect(rows.find((row) => row.question_key === "start_date")!.topOption).toBeNull();
    expect(rows.find((row) => row.question_key === "start_date")!.guiding).toBe(false);

    // A never-seen row must not divide by zero.
    const zero = rows.find((row) => row.question_key === "zero")!;
    expect(zero.skipRatePct).toBe(0);
    expect(zero.editRatePct).toBe(0);
  });

  it("tolerates a missing option_counts payload", () => {
    const rows = viewFieldStats(
      [{ ...fieldStat(), option_counts: undefined as unknown as Record<string, number> }],
      new Set()
    );
    expect(rows[0].topOption).toBeNull();
  });
});
