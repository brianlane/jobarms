/**
 * Revenue analytics for /admin/revenue. Pure: subscription rows in, numbers out.
 *
 * JobArms bills two fixed prices, so there is no proration or seat arithmetic to
 * model. What there IS to be careful about is honesty: `subscriptions` is a cache
 * of Stripe state with one row per user, so history is thin. Every function here
 * is explicit about what it can and cannot know from that.
 */

import { PLAN_PRICE_CENTS, planOf, type AdminProfileRow, type AdminSubscriptionRow } from "@/lib/admin/overview";
import type { Plan } from "@/lib/plans";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface RevenueBreakdown {
  totalCents: number;
  byPlan: Record<Plan, { users: number; cents: number }>;
  payingUsers: number;
  arpuCents: number;
  /** Revenue on rows already flagged to cancel at period end. */
  pendingChurnCents: number;
  pendingChurnUsers: number;
}

export function revenueBreakdown(
  profiles: AdminProfileRow[],
  subscriptions: AdminSubscriptionRow[]
): RevenueBreakdown {
  const byUser = new Map(subscriptions.map((sub) => [sub.user_id, sub]));
  const byPlan: Record<Plan, { users: number; cents: number }> = {
    free: { users: 0, cents: 0 },
    premium: { users: 0, cents: 0 },
    max: { users: 0, cents: 0 }
  };
  let pendingChurnCents = 0;
  let pendingChurnUsers = 0;

  for (const profile of profiles) {
    const sub = byUser.get(profile.id) ?? null;
    const plan = planOf(sub);
    const cents = PLAN_PRICE_CENTS[plan];
    byPlan[plan].users += 1;
    byPlan[plan].cents += cents;
    if (plan !== "free" && sub?.cancel_at_period_end) {
      pendingChurnCents += cents;
      pendingChurnUsers += 1;
    }
  }

  const totalCents = byPlan.premium.cents + byPlan.max.cents;
  const payingUsers = byPlan.premium.users + byPlan.max.users;
  return {
    totalCents,
    byPlan,
    payingUsers,
    arpuCents: payingUsers > 0 ? Math.round(totalCents / payingUsers) : 0,
    pendingChurnCents,
    pendingChurnUsers
  };
}

export interface ConversionStats {
  signups: number;
  converted: number;
  conversionRatePct: number;
  /** Median days from signup to the first paid subscription row. */
  medianDaysToConvert: number | null;
}

/**
 * Free to paid conversion. Time-to-convert is measured from the profile's
 * creation to the subscription row's, which is the closest thing the cache
 * carries to "when they started paying". A row created before the profile (an
 * admin comp on an old account, say) is ignored rather than reported as negative.
 */
export function conversionStats(
  profiles: AdminProfileRow[],
  subscriptions: AdminSubscriptionRow[]
): ConversionStats {
  const byUser = new Map(subscriptions.map((sub) => [sub.user_id, sub]));
  const gaps: number[] = [];
  let converted = 0;

  for (const profile of profiles) {
    const sub = byUser.get(profile.id) ?? null;
    if (!sub || planOf(sub) === "free") continue;
    converted += 1;
    const signedUp = Date.parse(profile.created_at);
    const started = sub.created_at ? Date.parse(sub.created_at) : NaN;
    if (!Number.isFinite(signedUp) || !Number.isFinite(started)) continue;
    const days = (started - signedUp) / DAY_MS;
    if (days >= 0) gaps.push(days);
  }

  gaps.sort((a, b) => a - b);
  return {
    signups: profiles.length,
    converted,
    conversionRatePct:
      profiles.length > 0 ? Math.round((converted / profiles.length) * 1000) / 10 : 0,
    medianDaysToConvert: gaps.length > 0 ? Math.round(gaps[Math.floor(gaps.length / 2)]) : null
  };
}

export interface MrrTrendPoint {
  label: string;
  cents: number;
  payingUsers: number;
}

/**
 * MRR at the end of each of the last `months` months, reconstructed from when
 * each paying subscription row was created.
 *
 * This is an operator health metric, not a billing report: `subscriptions` keeps
 * ONE row per user, so a user who paid, canceled, and resubscribed leaves only
 * their latest state, and a plan change rewrites the row in place. The trend can
 * therefore understate past months. It is labelled as a reconstruction in the UI
 * for exactly that reason.
 */
export function mrrTrend(
  profiles: AdminProfileRow[],
  subscriptions: AdminSubscriptionRow[],
  months = 6,
  now: Date = new Date()
): MrrTrendPoint[] {
  const byUser = new Map(subscriptions.map((sub) => [sub.user_id, sub]));
  const paying = profiles
    .map((profile) => ({ profile, sub: byUser.get(profile.id) ?? null }))
    .filter((entry) => planOf(entry.sub) !== "free");

  const points: MrrTrendPoint[] = [];
  for (let back = months - 1; back >= 0; back -= 1) {
    // Last instant of that UTC month, clamped to now for the current one.
    const monthEnd = new Date(
      Math.min(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back + 1, 1) - 1,
        now.getTime()
      )
    );
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));

    let cents = 0;
    let payingUsers = 0;
    for (const entry of paying) {
      const startedAt = entry.sub?.created_at ? Date.parse(entry.sub.created_at) : NaN;
      // No creation date on the cached row: assume it was already paying, which
      // is the conservative read for a trend (it cannot invent growth).
      if (Number.isFinite(startedAt) && startedAt > monthEnd.getTime()) continue;
      cents += PLAN_PRICE_CENTS[planOf(entry.sub)];
      payingUsers += 1;
    }

    points.push({
      label: monthStart.toLocaleString("en-US", { month: "short", timeZone: "UTC" }),
      cents,
      payingUsers
    });
  }
  return points;
}

export interface PaymentProblem {
  userId: string;
  email: string;
  status: string;
  /** The plan the row records, which is NOT what the user currently gets. */
  recordedPlan: string;
  grantedPlan: Plan;
  updatedAt: string | null;
}

/**
 * Accounts whose billing has gone wrong: `past_due` (dunning) and `unpaid`.
 * These are the ones where the row still says premium but the gate has already
 * dropped them to free, so the user is locked out and probably about to write in.
 */
export const PROBLEM_STATUSES = ["past_due", "unpaid", "incomplete", "incomplete_expired"];

export function paymentProblems(
  profiles: AdminProfileRow[],
  subscriptions: AdminSubscriptionRow[]
): PaymentProblem[] {
  const emailById = new Map(profiles.map((profile) => [profile.id, profile.email]));
  return subscriptions
    .filter((sub) => PROBLEM_STATUSES.includes(sub.status))
    .map((sub) => ({
      userId: sub.user_id,
      email: emailById.get(sub.user_id) ?? "",
      status: sub.status,
      recordedPlan: sub.plan,
      grantedPlan: planOf(sub),
      updatedAt: sub.updated_at ?? null
    }))
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
}
