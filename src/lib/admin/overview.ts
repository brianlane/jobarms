/**
 * Platform aggregation for the admin surfaces. Every function here is pure:
 * it takes rows and returns numbers, so the whole analytics layer is unit
 * testable without a database. The service-role reads that feed it live in
 * src/lib/admin/reads.ts.
 */

import {
  armRunQuota,
  effectivePlan,
  MAX_PRICE_USD_MONTHLY,
  PREMIUM_PRICE_USD_MONTHLY,
  type AiCallKind,
  type Plan
} from "@/lib/plans";

export const AI_CALL_KINDS: AiCallKind[] = ["resume_parse", "tailor_resume", "cover_letter"];

const DAY_MS = 24 * 60 * 60 * 1000;

// ─── shared row shapes (the columns the admin reads actually select) ─────────

export interface AdminProfileRow {
  id: string;
  email: string;
  created_at: string;
  onboarding_complete: boolean;
  arm_autonomy: string;
}

export interface AdminSubscriptionRow {
  user_id: string;
  plan: string;
  status: string;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  stripe_subscription_id?: string | null;
  updated_at?: string | null;
}

export interface AdminApplicationRow {
  id: string;
  user_id: string;
  status: string;
  source: string;
  created_at: string;
  applied_at: string | null;
}

export interface AdminAiUsageRow {
  user_id: string;
  month_key: string;
  kind: string;
  used: number;
}

export interface AdminArmUsageRow {
  user_id: string;
  month_key: string;
  runs_used: number;
}

// ─── formatting ─────────────────────────────────────────────────────────────

/** Whole dollars under $10k, one decimal in k above it. */
export function formatCents(cents: number): string {
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const body =
    abs >= 1_000_000 ? `$${(abs / 100_000).toFixed(1)}k` : `$${(abs / 100).toFixed(0)}`;
  return negative ? `-${body}` : body;
}

/** Integer percentage of part in whole; 0 when whole is 0. */
export function pct(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.round((part / whole) * 100);
}

/** One-decimal percentage, for rates where whole numbers hide the signal. */
export function ratePct(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.round((part / whole) * 1000) / 10;
}

/** "Jul", counting back from `now`. */
export function monthLabel(monthsBack: number, now: Date = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsBack, 1));
  return d.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
}

/** Whole months between two instants, calendar-wise (not by elapsed days). */
export function monthsBetween(from: Date, to: Date): number {
  return (
    (to.getUTCFullYear() - from.getUTCFullYear()) * 12 +
    (to.getUTCMonth() - from.getUTCMonth())
  );
}

function withinDays(iso: string, days: number, now: Date): boolean {
  const at = Date.parse(iso);
  return Number.isFinite(at) && now.getTime() - at <= days * DAY_MS && at <= now.getTime();
}

// ─── users ──────────────────────────────────────────────────────────────────

export interface MonthPoint {
  label: string;
  count: number;
}

export interface UserSummary {
  total: number;
  new7d: number;
  new30d: number;
  onboarded: number;
  onboardedPct: number;
  fullAuto: number;
  /** Oldest month first, so the sparkline reads left to right. */
  signupsByMonth: MonthPoint[];
}

export function summarizeUsers(
  profiles: AdminProfileRow[],
  now: Date = new Date(),
  months = 6
): UserSummary {
  const buckets = new Array<number>(months).fill(0);
  let new7d = 0;
  let new30d = 0;
  let onboarded = 0;
  let fullAuto = 0;

  for (const profile of profiles) {
    if (profile.onboarding_complete) onboarded += 1;
    if (profile.arm_autonomy === "full_auto") fullAuto += 1;
    if (withinDays(profile.created_at, 7, now)) new7d += 1;
    if (withinDays(profile.created_at, 30, now)) new30d += 1;

    const created = new Date(profile.created_at);
    if (Number.isNaN(created.getTime())) continue;
    const back = monthsBetween(created, now);
    if (back >= 0 && back < months) buckets[back] += 1;
  }

  const signupsByMonth: MonthPoint[] = [];
  for (let back = months - 1; back >= 0; back -= 1) {
    signupsByMonth.push({ label: monthLabel(back, now), count: buckets[back] });
  }

  return {
    total: profiles.length,
    new7d,
    new30d,
    onboarded,
    onboardedPct: pct(onboarded, profiles.length),
    fullAuto,
    signupsByMonth
  };
}

// ─── plans and money ────────────────────────────────────────────────────────

/**
 * Effective plan per user. Reads through `effectivePlan`, so a past_due or
 * canceled row counts as free here exactly as it does at every feature gate:
 * the admin view can never claim revenue the product is not granting.
 */
export function planOf(sub: AdminSubscriptionRow | null | undefined): Plan {
  return effectivePlan(sub ? { plan: sub.plan as Plan, status: sub.status } : null);
}

export interface PlanBreakdown {
  counts: Record<Plan, number>;
  statusCounts: Record<string, number>;
  pendingCancellations: number;
  paying: number;
}

export function summarizePlans(
  profiles: AdminProfileRow[],
  subscriptions: AdminSubscriptionRow[]
): PlanBreakdown {
  const byUser = subscriptionsByUser(subscriptions);
  const counts: Record<Plan, number> = { free: 0, premium: 0, max: 0 };
  const statusCounts: Record<string, number> = {};
  let pendingCancellations = 0;

  for (const profile of profiles) {
    const sub = byUser.get(profile.id) ?? null;
    counts[planOf(sub)] += 1;
    const status = sub?.status ?? "none";
    statusCounts[status] = (statusCounts[status] ?? 0) + 1;
    if (sub?.cancel_at_period_end && planOf(sub) !== "free") pendingCancellations += 1;
  }

  return {
    counts,
    statusCounts,
    pendingCancellations,
    paying: counts.premium + counts.max
  };
}

export function subscriptionsByUser(
  subscriptions: AdminSubscriptionRow[]
): Map<string, AdminSubscriptionRow> {
  return new Map(subscriptions.map((sub) => [sub.user_id, sub]));
}

export const PLAN_PRICE_CENTS: Record<Plan, number> = {
  free: 0,
  premium: PREMIUM_PRICE_USD_MONTHLY * 100,
  max: MAX_PRICE_USD_MONTHLY * 100
};

export interface MrrSummary {
  totalCents: number;
  premiumCents: number;
  maxCents: number;
  arpuCents: number;
  /** Revenue already committed to leave at period end. */
  pendingChurnCents: number;
}

export function summarizeMrr(
  profiles: AdminProfileRow[],
  subscriptions: AdminSubscriptionRow[]
): MrrSummary {
  const byUser = subscriptionsByUser(subscriptions);
  let premiumCents = 0;
  let maxCents = 0;
  let pendingChurnCents = 0;
  let paying = 0;

  for (const profile of profiles) {
    const sub = byUser.get(profile.id) ?? null;
    const plan = planOf(sub);
    if (plan === "free") continue;
    paying += 1;
    const price = PLAN_PRICE_CENTS[plan];
    if (plan === "max") maxCents += price;
    else premiumCents += price;
    if (sub?.cancel_at_period_end) pendingChurnCents += price;
  }

  const totalCents = premiumCents + maxCents;
  return {
    totalCents,
    premiumCents,
    maxCents,
    arpuCents: paying > 0 ? Math.round(totalCents / paying) : 0,
    pendingChurnCents
  };
}

// ─── applications ───────────────────────────────────────────────────────────

export interface ApplicationSummary {
  total: number;
  byStatus: Record<string, number>;
  applied: number;
  fromArm: number;
  fromManual: number;
  /** Users with at least one application: the activation numerator. */
  activatedUsers: number;
}

export function summarizeApplications(
  applications: AdminApplicationRow[]
): ApplicationSummary {
  const byStatus: Record<string, number> = {};
  const users = new Set<string>();
  let applied = 0;
  let fromArm = 0;
  let fromManual = 0;

  for (const app of applications) {
    byStatus[app.status] = (byStatus[app.status] ?? 0) + 1;
    users.add(app.user_id);
    if (app.applied_at) applied += 1;
    if (app.source === "manual") fromManual += 1;
    else fromArm += 1;
  }

  return {
    total: applications.length,
    byStatus,
    applied,
    fromArm,
    fromManual,
    activatedUsers: users.size
  };
}

// ─── AI usage ───────────────────────────────────────────────────────────────

export interface AiUsageSummary {
  total: number;
  byKind: Record<string, number>;
  users: number;
}

export function summarizeAiUsage(rows: AdminAiUsageRow[]): AiUsageSummary {
  const byKind: Record<string, number> = {};
  for (const kind of AI_CALL_KINDS) byKind[kind] = 0;
  const users = new Set<string>();
  let total = 0;

  for (const row of rows) {
    byKind[row.kind] = (byKind[row.kind] ?? 0) + row.used;
    total += row.used;
    if (row.used > 0) users.add(row.user_id);
  }

  return { total, byKind, users: users.size };
}

// ─── quota pressure ─────────────────────────────────────────────────────────

export interface QuotaPressureRow {
  userId: string;
  email: string;
  plan: Plan;
  used: number;
  limit: number;
  usedPct: number;
  window: string;
}

export const QUOTA_PRESSURE_THRESHOLD_PCT = 80;

/**
 * Users burning through their arm-run quota. On free that is the upgrade
 * signal; on paid it is the fair-use ceiling coming into view, which is worth
 * seeing before the user hits a 402.
 *
 * `usage` must already be keyed to each plan's own window (month for
 * free/premium, day for max), which is what `loadQuotaUsage` does.
 */
export function quotaPressure(params: {
  profiles: AdminProfileRow[];
  subscriptions: AdminSubscriptionRow[];
  usageByUser: Map<string, number>;
  thresholdPct?: number;
}): QuotaPressureRow[] {
  const threshold = params.thresholdPct ?? QUOTA_PRESSURE_THRESHOLD_PCT;
  const byUser = subscriptionsByUser(params.subscriptions);
  const rows: QuotaPressureRow[] = [];

  for (const profile of params.profiles) {
    const plan = planOf(byUser.get(profile.id) ?? null);
    const quota = armRunQuota(plan);
    const used = params.usageByUser.get(profile.id) ?? 0;
    const usedPct = pct(used, quota.limit);
    if (usedPct < threshold) continue;
    rows.push({
      userId: profile.id,
      email: profile.email,
      plan,
      used,
      limit: quota.limit,
      usedPct,
      window: quota.window
    });
  }

  return rows.sort((a, b) => b.usedPct - a.usedPct || b.used - a.used);
}

// ─── catalog ────────────────────────────────────────────────────────────────

export interface CatalogSummary {
  jobs: number;
  jobsAdded24h: number;
  companies: number;
  byAts: Record<string, number>;
  newestJobAt: string | null;
}

/**
 * Is the ingestion cron alive? The worker sweeps twice an hour, so nothing new
 * for six hours means a stalled sweep rather than a quiet market.
 */
export const INGEST_STALE_HOURS = 6;

export function ingestStale(newestJobAt: string | null, now: Date = new Date()): boolean {
  if (!newestJobAt) return true;
  const at = Date.parse(newestJobAt);
  if (!Number.isFinite(at)) return true;
  return now.getTime() - at > INGEST_STALE_HOURS * 60 * 60 * 1000;
}
