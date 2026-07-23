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

  const ageMs = now.getTime() - new Date(run.created_at).getTime();
  if ((run.status === "queued" || run.status === "running") && ageMs > STALE_ACTIVE_MS) {
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
