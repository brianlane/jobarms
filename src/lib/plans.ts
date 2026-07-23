/**
 * Plan definitions + gating. One source of truth for what each tier
 * includes - UI copy, API gates, and metering all read from here.
 *
 * Quotas are window-aware: month, day, or lifetime. Arm-run metering counts
 * SUCCESSFUL runs only: the slot is reserved at dispatch, and the worker
 * refunds it when a run dies from a system failure (user cancels count).
 */

export const FREE_ARM_RUNS_PER_MONTH = 3;
export const FREE_RESUME_PARSES_LIFETIME = 2;
export const PREMIUM_ARM_RUNS_PER_MONTH = 200;
export const MAX_ARM_RUNS_PER_DAY = 100;
export const PREMIUM_PRICE_USD_MONTHLY = 19;
export const MAX_PRICE_USD_MONTHLY = 199;

export type Plan = "free" | "premium" | "max";

export interface SubscriptionRow {
  plan: Plan;
  status: string;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
}

/** Statuses that count as an active paid subscription. */
const ACTIVE_STATUSES = new Set(["active", "trialing", "past_due"]);

export function effectivePlan(sub: Pick<SubscriptionRow, "plan" | "status"> | null): Plan {
  if (!sub) return "free";
  if ((sub.plan === "premium" || sub.plan === "max") && ACTIVE_STATUSES.has(sub.status)) {
    return sub.plan;
  }
  return "free";
}

export type QuotaWindow = "month" | "day" | "lifetime";

export interface Quota {
  limit: number;
  window: QuotaWindow;
}

const ARM_RUN_QUOTAS: Record<Plan, Quota> = {
  free: { limit: FREE_ARM_RUNS_PER_MONTH, window: "month" },
  premium: { limit: PREMIUM_ARM_RUNS_PER_MONTH, window: "month" },
  max: { limit: MAX_ARM_RUNS_PER_DAY, window: "day" }
};

export function armRunQuota(plan: Plan): Quota {
  return ARM_RUN_QUOTAS[plan];
}

/** Resume tailoring + cover letters are paid features. */
export function canTailor(plan: Plan): boolean {
  return plan !== "free";
}

/** Full-auto submission (no review gate) is a paid feature. */
export function canFullAuto(plan: Plan): boolean {
  return plan !== "free";
}

export type AiCallKind = "resume_parse" | "tailor_resume" | "cover_letter";

/**
 * Quotas for every AI surface, per plan. Free parses are LIFETIME (an
 * onboarding allowance, and a conversion lever); paid caps are fair-use
 * ceilings a real user will not hit.
 */
const AI_CALL_QUOTAS: Record<AiCallKind, Record<Plan, Quota>> = {
  resume_parse: {
    free: { limit: FREE_RESUME_PARSES_LIFETIME, window: "lifetime" },
    premium: { limit: 100, window: "month" },
    max: { limit: 300, window: "month" }
  },
  tailor_resume: {
    free: { limit: 0, window: "month" },
    premium: { limit: 100, window: "month" },
    max: { limit: 300, window: "month" }
  },
  cover_letter: {
    free: { limit: 0, window: "month" },
    premium: { limit: 100, window: "month" },
    max: { limit: 300, window: "month" }
  }
};

export function aiCallQuota(plan: Plan, kind: AiCallKind): Quota {
  return AI_CALL_QUOTAS[kind][plan];
}

/**
 * Metering key for a quota window (stored in the text key column of
 * arm_run_usage / ai_usage): 'YYYY-MM', 'YYYY-MM-DD', or 'lifetime'.
 */
export function meterKey(window: QuotaWindow, date: Date = new Date()): string {
  if (window === "lifetime") return "lifetime";
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  if (window === "month") return `${y}-${m}`;
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Back-compat helper: the monthly meter key. */
export function monthKey(date: Date = new Date()): string {
  return meterKey("month", date);
}

export const PLAN_COPY = {
  free: {
    name: "Free",
    price: "$0",
    features: [
      `${FREE_ARM_RUNS_PER_MONTH} autonomous applications a month`,
      `${FREE_RESUME_PARSES_LIFETIME} free AI resume parses`,
      "One profile + application tracker",
      "Review-gate on every submit"
    ]
  },
  premium: {
    name: "Premium",
    price: `$${PREMIUM_PRICE_USD_MONTHLY}/mo`,
    features: [
      `Up to ${PREMIUM_ARM_RUNS_PER_MONTH} autonomous applications a month`,
      "AI resume tailoring per job",
      "AI cover letter generation",
      "Full-auto mode (opt-in)",
      "100 resume parses a month"
    ]
  },
  max: {
    name: "Max",
    price: `$${MAX_PRICE_USD_MONTHLY}/mo`,
    features: [
      `${MAX_ARM_RUNS_PER_DAY} autonomous applications every day`,
      "Only successful submissions count",
      "300 tailored resumes + cover letters a month",
      "300 resume parses a month",
      "Full-auto mode at volume"
    ]
  }
} as const;
