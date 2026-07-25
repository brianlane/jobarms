/**
 * Arm-run analytics for the admin surfaces. Pure: rows in, numbers out.
 *
 * The run lifecycle is queued, running, needs_review, approved, submitting,
 * submitted, with failed and canceled as the other two terminal states
 * (see the application_runs check constraint).
 */

export interface AdminRunRow {
  id: string;
  user_id: string;
  application_id: string;
  status: string;
  autonomy: string;
  error: string | null;
  created_at: string;
  updated_at: string;
  slot_refunded?: boolean | null;
  canceled_by?: string | null;
}

export const RUN_STATUSES = [
  "queued",
  "running",
  "needs_review",
  "approved",
  "submitting",
  "submitted",
  "failed",
  "canceled"
] as const;

/** Runs that have stopped moving on their own. */
export const TERMINAL_RUN_STATUSES = ["submitted", "failed", "canceled"] as const;

export function isTerminalRun(status: string): boolean {
  return (TERMINAL_RUN_STATUSES as readonly string[]).includes(status);
}

const DAY_MS = 24 * 60 * 60 * 1000;

// ─── failure taxonomy ───────────────────────────────────────────────────────

/**
 * The failure codes the worker writes into `application_runs.error`, in the
 * order they are matched. Everything else is a workflow crash whose message we
 * keep but whose bucket is "workflow_error", so a single unexpected exception
 * cannot fragment the taxonomy into dozens of one-row buckets.
 */
export const RUN_ERROR_CODES = [
  "form_not_found",
  "captcha_blocked",
  "submit_unconfirmed",
  "review_timeout",
  "account_required",
  "workflow_error"
] as const;

export type RunErrorCode = (typeof RUN_ERROR_CODES)[number] | "none";

export function classifyRunError(error: string | null | undefined): RunErrorCode {
  if (!error || !error.trim()) return "none";
  const text = error.toLowerCase();
  for (const code of RUN_ERROR_CODES) {
    if (code === "workflow_error") continue;
    if (text.includes(code)) return code;
  }
  return "workflow_error";
}

/** Operator-facing one-liner for each failure bucket. */
export const RUN_ERROR_MEANING: Record<RunErrorCode, string> = {
  none: "no error recorded",
  form_not_found: "the arm never reached a real application form",
  captcha_blocked: "an anti-bot check blocked the automated submit",
  submit_unconfirmed: "submit fired but the ATS never confirmed",
  review_timeout: "the review gate expired after 7 days",
  account_required: "the ATS wanted a candidate account",
  workflow_error: "an unexpected crash inside the workflow"
};

export interface ErrorBucket {
  code: RunErrorCode;
  count: number;
  meaning: string;
  /** A representative raw message, so the operator can go read the real thing. */
  sample: string;
}

export function summarizeRunErrors(runs: AdminRunRow[]): ErrorBucket[] {
  const counts = new Map<RunErrorCode, { count: number; sample: string }>();
  for (const run of runs) {
    const code = classifyRunError(run.error);
    if (code === "none") continue;
    const entry = counts.get(code);
    if (entry) entry.count += 1;
    // A non-"none" code guarantees a non-empty error string.
    else counts.set(code, { count: 1, sample: String(run.error).slice(0, 200) });
  }
  return [...counts.entries()]
    .map(([code, entry]) => ({
      code,
      count: entry.count,
      meaning: RUN_ERROR_MEANING[code],
      sample: entry.sample
    }))
    .sort((a, b) => b.count - a.count);
}

// ─── fleet summary ──────────────────────────────────────────────────────────

export interface RunSummary {
  total: number;
  today: number;
  last7d: number;
  last30d: number;
  byStatus: Record<string, number>;
  /** Still moving: queued, running, approved, submitting. */
  inFlight: number;
  /** Parked at the review gate, waiting on a human. */
  needsReview: number;
  terminal: number;
  submitted: number;
  failed: number;
  canceled: number;
  submittedRatePct: number;
  failureRatePct: number;
  refunded: number;
  refundRatePct: number;
  canceledByUser: number;
  canceledBySystem: number;
  fullAuto: number;
  reviewGate: number;
  /** Distinct users with a run in the fetched window. */
  activeUsers: number;
}

export function summarizeRuns(runs: AdminRunRow[], now: Date = new Date()): RunSummary {
  const byStatus: Record<string, number> = {};
  for (const status of RUN_STATUSES) byStatus[status] = 0;

  const users = new Set<string>();
  let today = 0;
  let last7d = 0;
  let last30d = 0;
  let refunded = 0;
  let canceledByUser = 0;
  let canceledBySystem = 0;
  let fullAuto = 0;

  const startOfDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

  for (const run of runs) {
    byStatus[run.status] = (byStatus[run.status] ?? 0) + 1;
    users.add(run.user_id);
    if (run.autonomy === "full_auto") fullAuto += 1;
    if (run.slot_refunded) refunded += 1;
    if (run.canceled_by === "user") canceledByUser += 1;
    if (run.canceled_by === "system") canceledBySystem += 1;

    const at = Date.parse(run.created_at);
    if (!Number.isFinite(at)) continue;
    if (at >= startOfDay) today += 1;
    if (now.getTime() - at <= 7 * DAY_MS) last7d += 1;
    if (now.getTime() - at <= 30 * DAY_MS) last30d += 1;
  }

  const submitted = byStatus.submitted;
  const failed = byStatus.failed;
  const canceled = byStatus.canceled;
  const terminal = submitted + failed + canceled;
  const inFlight = byStatus.queued + byStatus.running + byStatus.approved + byStatus.submitting;

  return {
    total: runs.length,
    today,
    last7d,
    last30d,
    byStatus,
    inFlight,
    needsReview: byStatus.needs_review,
    terminal,
    submitted,
    failed,
    canceled,
    submittedRatePct: terminal > 0 ? Math.round((submitted / terminal) * 100) : 0,
    failureRatePct: terminal > 0 ? Math.round((failed / terminal) * 100) : 0,
    refunded,
    refundRatePct: terminal > 0 ? Math.round((refunded / terminal) * 100) : 0,
    canceledByUser,
    canceledBySystem,
    fullAuto,
    reviewGate: runs.length - fullAuto,
    activeUsers: users.size
  };
}

// ─── funnel ─────────────────────────────────────────────────────────────────

/**
 * The step names the workflow logs, in order (workers/apply-arm/src/workflow.ts).
 * These are what the funnel measures, rather than run STATUS, because status
 * only tells you where a run is now: the step log tells you how far it got
 * before it died.
 */
export const FUNNEL_STEPS = [
  { step: "navigate", label: "Reached the page" },
  { step: "form_extracted", label: "Found the form" },
  { step: "answers_generated", label: "Drafted answers" },
  { step: "review_requested", label: "Parked for review" },
  { step: "approved", label: "Approved" },
  { step: "submitted", label: "Submitted" }
] as const;

export interface RunStep {
  at?: string;
  step?: string;
  detail?: string;
}

export function runSteps(steps: unknown): RunStep[] {
  return Array.isArray(steps) ? (steps as RunStep[]) : [];
}

export interface FunnelStage {
  step: string;
  label: string;
  reached: number;
  /** Share of runs that reached this stage, as a percentage of all runs. */
  reachedPct: number;
  /** Runs that reached the PREVIOUS stage and stopped before this one. */
  droppedHere: number;
}

/**
 * How far runs get. Full-auto runs never log `review_requested` or `approved`,
 * so those two stages count only the review-gate runs that could reach them,
 * which keeps a full-auto fleet from reading as a 100% review drop-off.
 */
export function runFunnel(runs: { steps?: unknown; autonomy?: string }[]): FunnelStage[] {
  const total = runs.length;
  const reviewGateTotal = runs.filter((run) => run.autonomy !== "full_auto").length;

  const stages: FunnelStage[] = [];
  let previousReached = total;

  for (const stage of FUNNEL_STEPS) {
    const gateOnly = stage.step === "review_requested" || stage.step === "approved";
    const population = gateOnly ? reviewGateTotal : total;
    const eligible = gateOnly
      ? runs.filter((run) => run.autonomy !== "full_auto")
      : runs;
    const reached = eligible.filter((run) =>
      runSteps(run.steps).some((entry) => entry.step === stage.step)
    ).length;

    stages.push({
      step: stage.step,
      label: stage.label,
      reached,
      reachedPct: population > 0 ? Math.round((reached / population) * 100) : 0,
      droppedHere: Math.max(previousReached - reached, 0)
    });
    previousReached = reached;
  }

  return stages;
}

// ─── durations ──────────────────────────────────────────────────────────────

export interface PhaseDuration {
  label: string;
  /** Median seconds between the two steps, across runs that logged both. */
  medianSeconds: number | null;
  p95Seconds: number | null;
  samples: number;
}

const PHASES: { label: string; from: string; to: string }[] = [
  { label: "Navigate to form found", from: "navigate", to: "form_extracted" },
  { label: "Form to drafted answers", from: "form_extracted", to: "answers_generated" },
  { label: "Answers to review gate", from: "answers_generated", to: "review_requested" },
  { label: "Review gate to approval", from: "review_requested", to: "approved" },
  { label: "Approval to submitted", from: "approved", to: "submitted" }
];

function percentile(sorted: number[], fraction: number): number {
  const index = Math.min(sorted.length - 1, Math.floor(fraction * sorted.length));
  return sorted[index];
}

function stepTime(steps: RunStep[], name: string): number | null {
  for (const entry of steps) {
    if (entry.step !== name || !entry.at) continue;
    const at = Date.parse(entry.at);
    if (Number.isFinite(at)) return at;
  }
  return null;
}

/**
 * Wall-clock time per workflow phase. "Review gate to approval" is dominated by
 * how long the human took, which is the point: it is the phase an operator can
 * actually act on (a nudge), and the rest is machine time.
 */
export function phaseDurations(runs: { steps?: unknown }[]): PhaseDuration[] {
  return PHASES.map((phase) => {
    const samples: number[] = [];
    for (const run of runs) {
      const steps = runSteps(run.steps);
      const from = stepTime(steps, phase.from);
      const to = stepTime(steps, phase.to);
      if (from === null || to === null || to < from) continue;
      samples.push((to - from) / 1000);
    }
    if (samples.length === 0) {
      return { label: phase.label, medianSeconds: null, p95Seconds: null, samples: 0 };
    }
    samples.sort((a, b) => a - b);
    return {
      label: phase.label,
      medianSeconds: Math.round(percentile(samples, 0.5)),
      p95Seconds: Math.round(percentile(samples, 0.95)),
      samples: samples.length
    };
  });
}

/** Compact duration: seconds under a minute, then minutes, then hours. */
export function formatDuration(seconds: number | null): string {
  if (seconds === null) return "-";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 360) / 10}h`;
}

/**
 * Runs the operator should look at right now: a review gate that has been
 * parked long enough to be heading for its 7-day timeout, or an active run
 * that has not moved in a day (the same staleness bar the retry endpoint uses).
 */
export const STALE_ACTIVE_HOURS = 24;
export const REVIEW_AGING_DAYS = 5;

export function needsAttention(runs: AdminRunRow[], now: Date = new Date()): AdminRunRow[] {
  return runs
    .filter((run) => {
      const age = now.getTime() - Date.parse(run.created_at);
      if (!Number.isFinite(age)) return false;
      if (run.status === "needs_review") return age > REVIEW_AGING_DAYS * DAY_MS;
      if (run.status === "queued" || run.status === "running" || run.status === "submitting") {
        return age > STALE_ACTIVE_HOURS * 60 * 60 * 1000;
      }
      return false;
    })
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
}
