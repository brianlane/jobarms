/**
 * Run-outcome policy (pure, unit-tested): user behavior consumes the metered
 * slot, system failure refunds it. Shared by the cancel and retry routes so
 * the two can never disagree.
 */

export interface RunAnswerLike {
  value?: string | null;
  skipped?: boolean;
}

export interface RunLike {
  status: string;
  answers: RunAnswerLike[] | null;
  created_at: string;
}

/** Did the arm deliver at least one real drafted answer? */
export function hasMeaningfulAnswers(answers: RunAnswerLike[] | null): boolean {
  return (answers ?? []).some((a) => !a.skipped && (a.value ?? "").trim() !== "");
}

/**
 * When a user clicks Cancel: refund only if the run had ALREADY dead-ended
 * with nothing reviewable (system failure in disguise; the click is cleanup).
 * Canceling working machinery or a real review consumes.
 */
export function cancelRefund(status: string, answers: RunAnswerLike[] | null): boolean {
  // A run parked on a LinkedIn PIN never got past sign-in, so canceling it did
  // not consume any application work: refund, like a review that dead-ended
  // with nothing to approve.
  if (status === "needs_login_code") return true;
  return status === "needs_review" && !hasMeaningfulAnswers(answers);
}

const STALE_ACTIVE_MS = 24 * 60 * 60 * 1000;

export interface RetryDecision {
  eligible: boolean;
  /** The stale run must be marked canceled before dispatching a new one. */
  cancelStale: boolean;
  /** The stale run's slot refunds (it was a system failure). */
  refundStale: boolean;
  reason: string;
}

/** Is this application's latest run retry-able, and what happens to it? */
export function retryDecision(run: RunLike | null, now: Date = new Date()): RetryDecision {
  if (!run) {
    return { eligible: true, cancelStale: false, refundStale: false, reason: "no prior run" };
  }

  if (run.status === "failed" || run.status === "canceled") {
    // Terminal runs already settled their own metering (worker refunds
    // system failures; refund_arm_run is idempotent so a second call from
    // retry is harmless for legacy runs that predate worker refunds).
    // "Work done = paid": a failed run that still produced real drafted answers
    // (captcha_blocked, submit_unconfirmed) does NOT refund; only a failure with
    // nothing to show (form_not_found, early crash) does.
    return {
      eligible: true,
      cancelStale: false,
      refundStale: run.status === "failed" && !hasMeaningfulAnswers(run.answers),
      reason: "terminal run"
    };
  }

  if (run.status === "needs_review" && !hasMeaningfulAnswers(run.answers)) {
    return {
      eligible: true,
      cancelStale: true,
      refundStale: true,
      reason: "dead-ended review with nothing reviewable"
    };
  }

  // States where the arm is mid-flight and a stall means it is never finishing.
  // `needs_account_verification` and `needs_login_code` belong here rather than
  // with the review gate: both wait on something outside the run (an ATS mail, a
  // LinkedIn PIN), and if the worker died without updating the row a run can
  // zombie there past its own timeout, so a day later it is stuck, not patient.
  const STALLABLE = [
    "queued",
    "running",
    "needs_account_verification",
    "needs_login_code"
  ];
  const ageMs = now.getTime() - new Date(run.created_at).getTime();
  if (STALLABLE.includes(run.status) && ageMs > STALE_ACTIVE_MS) {
    return {
      eligible: true,
      cancelStale: true,
      refundStale: true,
      reason: "run stuck for more than 24h"
    };
  }

  return {
    eligible: false,
    cancelStale: false,
    refundStale: false,
    reason: `run is ${run.status}`
  };
}
