import { describe, expect, it } from "vitest";
import {
  classifyRunError,
  isTerminalRun,
  needsAttention,
  summarizeRunErrors,
  summarizeRuns,
  type AdminRunRow
} from "@/lib/admin/run-stats";

const NOW = new Date("2026-07-15T12:00:00Z");

function run(over: Partial<AdminRunRow> = {}): AdminRunRow {
  return {
    id: "r1",
    user_id: "u1",
    application_id: "a1",
    status: "submitted",
    autonomy: "review_gate",
    error: null,
    created_at: "2026-07-15T11:00:00Z",
    updated_at: "2026-07-15T11:05:00Z",
    ...over
  };
}

describe("isTerminalRun", () => {
  it("knows which statuses have stopped moving", () => {
    expect(isTerminalRun("submitted")).toBe(true);
    expect(isTerminalRun("failed")).toBe(true);
    expect(isTerminalRun("canceled")).toBe(true);
    expect(isTerminalRun("needs_review")).toBe(false);
  });
});

describe("classifyRunError", () => {
  it("buckets the codes the worker writes", () => {
    expect(classifyRunError("form_not_found: no form on the page")).toBe("form_not_found");
    expect(classifyRunError("captcha_blocked: anti-bot check")).toBe("captcha_blocked");
    expect(classifyRunError("submit_unconfirmed - no confirmation")).toBe("submit_unconfirmed");
    expect(classifyRunError("review_timeout: expired after 7 days")).toBe("review_timeout");
    expect(classifyRunError("ACCOUNT_REQUIRED for this tenant")).toBe("account_required");
  });

  it("collapses unexpected crashes into one bucket", () => {
    expect(classifyRunError("TypeError: cannot read property of undefined")).toBe("workflow_error");
  });

  it("reports no error for empty values", () => {
    expect(classifyRunError(null)).toBe("none");
    expect(classifyRunError(undefined)).toBe("none");
    expect(classifyRunError("   ")).toBe("none");
  });
});

describe("summarizeRunErrors", () => {
  it("counts buckets with a sample, most common first", () => {
    const buckets = summarizeRunErrors([
      run({ error: "form_not_found: a" }),
      run({ error: "form_not_found: b" }),
      run({ error: "captcha_blocked: c" }),
      run({ error: null })
    ]);

    expect(buckets.map((b) => [b.code, b.count])).toEqual([
      ["form_not_found", 2],
      ["captcha_blocked", 1]
    ]);
    expect(buckets[0].sample).toBe("form_not_found: a");
    expect(buckets[0].meaning).toContain("never reached");
  });

  it("is empty with no failures", () => {
    expect(summarizeRunErrors([run()])).toEqual([]);
  });
});

describe("summarizeRuns", () => {
  it("counts windows, statuses, rates, refunds, and provenance", () => {
    const summary = summarizeRuns(
      [
        run({ id: "1", status: "submitted", created_at: "2026-07-15T01:00:00Z" }),
        run({ id: "2", status: "submitted", created_at: "2026-07-10T01:00:00Z", autonomy: "full_auto" }),
        // Older than the 30-day window, so it counts in the totals only.
        run({ id: "3", status: "failed", created_at: "2026-05-30T01:00:00Z", slot_refunded: true }),
        run({ id: "4", status: "canceled", canceled_by: "user", created_at: "2026-07-14T01:00:00Z" }),
        run({ id: "5", status: "canceled", canceled_by: "system", created_at: "2026-07-14T02:00:00Z", slot_refunded: true }),
        run({ id: "6", status: "needs_review", created_at: "2026-07-13T01:00:00Z", user_id: "u2" }),
        run({ id: "7", status: "running", created_at: "2026-07-15T11:00:00Z" }),
        run({ id: "8", status: "queued", created_at: "bad-date" })
      ],
      NOW
    );

    expect(summary.total).toBe(8);
    expect(summary.today).toBe(2);
    expect(summary.last7d).toBe(6);
    expect(summary.last30d).toBe(6);
    expect(summary.submitted).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.canceled).toBe(2);
    expect(summary.terminal).toBe(5);
    expect(summary.submittedRatePct).toBe(40);
    expect(summary.failureRatePct).toBe(20);
    expect(summary.refunded).toBe(2);
    expect(summary.refundRatePct).toBe(40);
    expect(summary.canceledByUser).toBe(1);
    expect(summary.canceledBySystem).toBe(1);
    expect(summary.needsReview).toBe(1);
    expect(summary.inFlight).toBe(2);
    expect(summary.fullAuto).toBe(1);
    expect(summary.reviewGate).toBe(7);
    expect(summary.activeUsers).toBe(2);
  });

  it("counts a status outside the known list without crashing", () => {
    const summary = summarizeRuns([run({ status: "surprise" })], NOW);
    expect(summary.byStatus.surprise).toBe(1);
  });

  it("reports zero rates with no terminal runs", () => {
    const summary = summarizeRuns([], NOW);
    expect(summary.submittedRatePct).toBe(0);
    expect(summary.failureRatePct).toBe(0);
    expect(summary.refundRatePct).toBe(0);
  });
});

describe("needsAttention", () => {
  it("flags aging reviews and stuck active runs, oldest first", () => {
    const rows = needsAttention(
      [
        run({ id: "fresh-review", status: "needs_review", created_at: "2026-07-14T00:00:00Z" }),
        run({ id: "aging-review", status: "needs_review", created_at: "2026-07-08T00:00:00Z" }),
        run({ id: "stuck-run", status: "running", created_at: "2026-07-13T00:00:00Z" }),
        run({ id: "stuck-submitting", status: "submitting", created_at: "2026-07-12T00:00:00Z" }),
        run({ id: "young-run", status: "queued", created_at: "2026-07-15T11:00:00Z" }),
        run({ id: "done", status: "submitted", created_at: "2026-01-01T00:00:00Z" }),
        run({ id: "broken-date", status: "running", created_at: "nope" })
      ],
      NOW
    );

    expect(rows.map((r) => r.id)).toEqual(["aging-review", "stuck-submitting", "stuck-run"]);
  });
});
