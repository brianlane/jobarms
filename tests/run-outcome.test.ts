import { describe, expect, it } from "vitest";
import { cancelRefund, hasMeaningfulAnswers, retryDecision } from "@/lib/run-outcome";

const NOW = new Date("2026-07-23T20:00:00Z");
const recent = new Date(NOW.getTime() - 60_000).toISOString();
const stale = new Date(NOW.getTime() - 25 * 60 * 60 * 1000).toISOString();

const realAnswers = [{ value: "Brian Lane", skipped: false }];
const junkAnswers = [{ value: "", skipped: true }];

describe("hasMeaningfulAnswers", () => {
  it("real drafted answers count", () => {
    expect(hasMeaningfulAnswers(realAnswers)).toBe(true);
  });
  it("skipped/empty/null do not", () => {
    expect(hasMeaningfulAnswers(junkAnswers)).toBe(false);
    expect(hasMeaningfulAnswers([])).toBe(false);
    expect(hasMeaningfulAnswers(null)).toBe(false);
  });
});

describe("cancelRefund: user behavior consumes, system failure refunds", () => {
  it("cancel while the arm works consumes", () => {
    expect(cancelRefund("queued", null)).toBe(false);
    expect(cancelRefund("running", null)).toBe(false);
  });
  it("cancel at a REAL review consumes", () => {
    expect(cancelRefund("needs_review", realAnswers)).toBe(false);
  });
  it("cancel on a dead-ended junk review refunds (cleanup, not a choice)", () => {
    expect(cancelRefund("needs_review", junkAnswers)).toBe(true);
  });
});

describe("retryDecision", () => {
  it("failed run: eligible, refund only when nothing was delivered", () => {
    const d = retryDecision({ status: "failed", answers: junkAnswers, created_at: recent }, NOW);
    expect(d.eligible).toBe(true);
    expect(d.refundStale).toBe(true);
    expect(d.cancelStale).toBe(false);
  });

  it("failed run with real answers (post-review failure): eligible, no double refund", () => {
    const d = retryDecision({ status: "failed", answers: realAnswers, created_at: recent }, NOW);
    expect(d.eligible).toBe(true);
    expect(d.refundStale).toBe(false);
  });

  it("captcha_blocked / submit_unconfirmed CONSUME: failed with drafted answers never refunds", () => {
    // Both outcomes end as status=failed but carry the drafted answers the arm
    // filled in, so "work done = paid" -> no refund on retry.
    const d = retryDecision({ status: "failed", answers: realAnswers, created_at: stale }, NOW);
    expect(d.refundStale).toBe(false);
  });

  it("canceled run: eligible, metering already settled", () => {
    const d = retryDecision({ status: "canceled", answers: null, created_at: recent }, NOW);
    expect(d.eligible).toBe(true);
    expect(d.refundStale).toBe(false);
  });

  it("dead-ended junk review: eligible, cancel + refund the stale run", () => {
    const d = retryDecision(
      { status: "needs_review", answers: junkAnswers, created_at: recent },
      NOW
    );
    expect(d).toMatchObject({ eligible: true, cancelStale: true, refundStale: true });
  });

  it("REAL review waiting for the user: not eligible", () => {
    const d = retryDecision(
      { status: "needs_review", answers: realAnswers, created_at: recent },
      NOW
    );
    expect(d.eligible).toBe(false);
  });

  it("running run: not eligible until stuck >24h, then cancel + refund", () => {
    expect(retryDecision({ status: "running", answers: null, created_at: recent }, NOW).eligible).toBe(false);
    const d = retryDecision({ status: "running", answers: null, created_at: stale }, NOW);
    expect(d).toMatchObject({ eligible: true, cancelStale: true, refundStale: true });
  });

  it("submitted run: never eligible", () => {
    expect(retryDecision({ status: "submitted", answers: realAnswers, created_at: recent }, NOW).eligible).toBe(false);
  });

  it("no prior run: eligible", () => {
    expect(retryDecision(null, NOW).eligible).toBe(true);
  });
});
