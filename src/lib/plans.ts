/**
 * Plan definitions + gating. One source of truth for what free vs premium
 * includes — UI copy, API gates, and metering all read from here.
 */

export const FREE_ARM_RUNS_PER_MONTH = 5;
export const PREMIUM_PRICE_USD_MONTHLY = 19;

export type Plan = "free" | "premium";

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
  return sub.plan === "premium" && ACTIVE_STATUSES.has(sub.status) ? "premium" : "free";
}

/** Monthly arm-run allowance for a plan. -1 = unlimited. */
export function armRunLimit(plan: Plan): number {
  return plan === "premium" ? -1 : FREE_ARM_RUNS_PER_MONTH;
}

/** Resume tailoring + cover letters are premium-only. */
export function canTailor(plan: Plan): boolean {
  return plan === "premium";
}

/** Month key used by the arm_run_usage table: 'YYYY-MM' in UTC. */
export function monthKey(date: Date = new Date()): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

export const PLAN_COPY = {
  free: {
    name: "Free",
    price: "$0",
    features: [
      `${FREE_ARM_RUNS_PER_MONTH} autonomous applications / month`,
      "One profile, resume parsing",
      "Application tracker",
      "Review-gate on every submit"
    ]
  },
  premium: {
    name: "Premium",
    price: `$${PREMIUM_PRICE_USD_MONTHLY}/mo`,
    features: [
      "Unlimited autonomous applications",
      "AI resume tailoring per job",
      "AI cover letter generation",
      "Full-auto mode (opt-in)",
      "Priority arm queue"
    ]
  }
} as const;
