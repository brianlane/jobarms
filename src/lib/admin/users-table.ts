/**
 * The per-user fleet view. Pure: every read the /admin/users table needs is
 * passed in, and this file only joins and counts.
 */

import { armRunQuota, type Plan } from "@/lib/plans";
import {
  pct,
  planOf,
  subscriptionsByUser,
  type AdminAiUsageRow,
  type AdminApplicationRow,
  type AdminProfileRow,
  type AdminSubscriptionRow
} from "@/lib/admin/overview";
import { isTerminalRun, type AdminRunRow } from "@/lib/admin/run-stats";

const DAY_MS = 24 * 60 * 60 * 1000;

/** What we can learn about an account from the Supabase auth directory. */
export interface AuthDirectoryEntry {
  lastSignInAt: string | null;
  emailConfirmedAt: string | null;
}

/**
 * How engaged is this account? The bands are deliberately coarse: with a
 * job-search product a user goes quiet when they get hired, so "quiet" is a
 * churn signal worth seeing, not necessarily a problem to fix.
 */
export type EngagementSegment = "new" | "active" | "cooling" | "quiet";

export const ENGAGEMENT_ACTIVE_DAYS = 14;
export const ENGAGEMENT_COOLING_DAYS = 45;
export const ENGAGEMENT_NEW_DAYS = 7;

export function classifyEngagement(
  params: { createdAt: string; lastSignInAt: string | null },
  now: Date = new Date()
): EngagementSegment {
  const signedIn = params.lastSignInAt ? Date.parse(params.lastSignInAt) : NaN;
  if (Number.isFinite(signedIn)) {
    const age = now.getTime() - signedIn;
    if (age <= ENGAGEMENT_ACTIVE_DAYS * DAY_MS) return "active";
    if (age <= ENGAGEMENT_COOLING_DAYS * DAY_MS) return "cooling";
    return "quiet";
  }
  // Never signed in (or an unreadable timestamp): a brand new signup is still
  // "new", but an old account that never came back is quiet.
  const created = Date.parse(params.createdAt);
  if (Number.isFinite(created) && now.getTime() - created <= ENGAGEMENT_NEW_DAYS * DAY_MS) {
    return "new";
  }
  return "quiet";
}

export interface AdminUserRow {
  id: string;
  email: string;
  createdAt: string;
  plan: Plan;
  subscriptionStatus: string;
  cancelAtPeriodEnd: boolean;
  onboardingComplete: boolean;
  autonomy: string;
  lastSignInAt: string | null;
  segment: EngagementSegment;
  applications: number;
  applied: number;
  runs: number;
  runsSubmitted: number;
  runsFailed: number;
  /** Submitted over finished runs, as a percentage. Null with nothing finished. */
  successRatePct: number | null;
  aiCalls: number;
  quotaUsed: number;
  quotaLimit: number;
  quotaWindow: string;
  quotaPct: number;
}

export function buildUserRows(
  params: {
    profiles: AdminProfileRow[];
    subscriptions: AdminSubscriptionRow[];
    applications: AdminApplicationRow[];
    runs: AdminRunRow[];
    aiUsage: AdminAiUsageRow[];
    quotaUsage: Map<string, number>;
    authDirectory?: Map<string, AuthDirectoryEntry>;
  },
  now: Date = new Date()
): AdminUserRow[] {
  const subs = subscriptionsByUser(params.subscriptions);

  const appCounts = new Map<string, { total: number; applied: number }>();
  for (const app of params.applications) {
    const entry = appCounts.get(app.user_id) ?? { total: 0, applied: 0 };
    entry.total += 1;
    if (app.applied_at) entry.applied += 1;
    appCounts.set(app.user_id, entry);
  }

  const runCounts = new Map<
    string,
    { total: number; submitted: number; failed: number; finished: number }
  >();
  for (const run of params.runs) {
    const entry =
      runCounts.get(run.user_id) ?? { total: 0, submitted: 0, failed: 0, finished: 0 };
    entry.total += 1;
    if (run.status === "submitted") entry.submitted += 1;
    if (run.status === "failed") entry.failed += 1;
    if (isTerminalRun(run.status)) entry.finished += 1;
    runCounts.set(run.user_id, entry);
  }

  const aiCounts = new Map<string, number>();
  for (const row of params.aiUsage) {
    aiCounts.set(row.user_id, (aiCounts.get(row.user_id) ?? 0) + row.used);
  }

  return params.profiles.map((profile) => {
    const sub = subs.get(profile.id) ?? null;
    const plan = planOf(sub);
    const quota = armRunQuota(plan);
    const quotaUsed = params.quotaUsage.get(profile.id) ?? 0;
    const apps = appCounts.get(profile.id) ?? { total: 0, applied: 0 };
    const runs = runCounts.get(profile.id) ?? {
      total: 0,
      submitted: 0,
      failed: 0,
      finished: 0
    };
    const auth = params.authDirectory?.get(profile.id) ?? null;
    const lastSignInAt = auth?.lastSignInAt ?? null;

    return {
      id: profile.id,
      email: profile.email,
      createdAt: profile.created_at,
      plan,
      subscriptionStatus: sub?.status ?? "none",
      cancelAtPeriodEnd: Boolean(sub?.cancel_at_period_end),
      onboardingComplete: profile.onboarding_complete,
      autonomy: profile.arm_autonomy,
      lastSignInAt,
      segment: classifyEngagement({ createdAt: profile.created_at, lastSignInAt }, now),
      applications: apps.total,
      applied: apps.applied,
      runs: runs.total,
      runsSubmitted: runs.submitted,
      runsFailed: runs.failed,
      successRatePct:
        runs.finished > 0 ? Math.round((runs.submitted / runs.finished) * 100) : null,
      aiCalls: aiCounts.get(profile.id) ?? 0,
      quotaUsed,
      quotaLimit: quota.limit,
      quotaWindow: quota.window,
      quotaPct: pct(quotaUsed, quota.limit)
    };
  });
}

export type UserSort = "newest" | "email" | "plan" | "runs" | "applied" | "quota";

const PLAN_RANK: Record<Plan, number> = { max: 0, premium: 1, free: 2 };

export function sortUserRows(rows: AdminUserRow[], sort: UserSort): AdminUserRow[] {
  const copy = [...rows];
  switch (sort) {
    case "email":
      return copy.sort((a, b) => a.email.localeCompare(b.email));
    case "plan":
      return copy.sort(
        (a, b) => PLAN_RANK[a.plan] - PLAN_RANK[b.plan] || a.email.localeCompare(b.email)
      );
    case "runs":
      return copy.sort((a, b) => b.runs - a.runs);
    case "applied":
      return copy.sort((a, b) => b.applied - a.applied);
    case "quota":
      return copy.sort((a, b) => b.quotaPct - a.quotaPct);
    default:
      return copy.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }
}

export function isUserSort(value: string | undefined): value is UserSort {
  return ["newest", "email", "plan", "runs", "applied", "quota"].includes(value ?? "");
}

/** Free-text filter over the columns an operator would actually search. */
export function filterUserRows(rows: AdminUserRow[], term: string): AdminUserRow[] {
  const needle = term.trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter(
    (row) =>
      row.email.toLowerCase().includes(needle) ||
      row.id.toLowerCase().includes(needle) ||
      row.plan.includes(needle) ||
      row.segment.includes(needle)
  );
}

