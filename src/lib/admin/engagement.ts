/**
 * Engagement and activation. Pure: rows in, numbers out.
 *
 * The question these answer is not "how many users" but "how many are getting
 * value". For a job-search product that is unusually important, because the
 * healthiest possible outcome (they got hired) and the worst (they bounced) both
 * look like a user who stopped signing in.
 */

import { pct } from "@/lib/admin/overview";
import type { AdminProfileRow } from "@/lib/admin/overview";
import type { AuthDirectoryEntry } from "@/lib/admin/users-table";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ActiveUserCounts {
  /** Signed in within the last day, week, and month. */
  daily: number;
  weekly: number;
  monthly: number;
  neverSignedIn: number;
  /** Daily over monthly, the standard stickiness ratio. */
  stickinessPct: number;
}

export function activeUserCounts(
  directory: Map<string, AuthDirectoryEntry>,
  now: Date = new Date()
): ActiveUserCounts {
  let daily = 0;
  let weekly = 0;
  let monthly = 0;
  let neverSignedIn = 0;

  for (const entry of directory.values()) {
    const at = entry.lastSignInAt ? Date.parse(entry.lastSignInAt) : NaN;
    if (!Number.isFinite(at)) {
      neverSignedIn += 1;
      continue;
    }
    const age = now.getTime() - at;
    if (age <= DAY_MS) daily += 1;
    if (age <= 7 * DAY_MS) weekly += 1;
    if (age <= 30 * DAY_MS) monthly += 1;
  }

  return {
    daily,
    weekly,
    monthly,
    neverSignedIn,
    stickinessPct: monthly > 0 ? Math.round((daily / monthly) * 100) : 0
  };
}

export interface FunnelStep {
  label: string;
  users: number;
  /** Share of all signups, as a percentage. */
  sharePct: number;
  /** Users lost between the previous step and this one. */
  lost: number;
}

/**
 * Signup to first successful application, the whole activation path. Each step is
 * a SUBSET of signups rather than of the previous step, so a user who somehow
 * skipped a step (an imported profile, say) cannot make a later step read as
 * more than 100%.
 */
export function onboardingFunnel(params: {
  profiles: AdminProfileRow[];
  resumeUserIds: Set<string>;
  applicationUserIds: Set<string>;
  submittedUserIds: Set<string>;
}): FunnelStep[] {
  const total = params.profiles.length;
  const onboarded = params.profiles.filter((profile) => profile.onboarding_complete).length;
  const withResume = params.profiles.filter((profile) => params.resumeUserIds.has(profile.id)).length;
  const applied = params.profiles.filter((profile) =>
    params.applicationUserIds.has(profile.id)
  ).length;
  const submitted = params.profiles.filter((profile) =>
    params.submittedUserIds.has(profile.id)
  ).length;

  const steps = [
    { label: "Signed up", users: total },
    { label: "Uploaded a resume", users: withResume },
    { label: "Finished onboarding", users: onboarded },
    { label: "Tracked a job", users: applied },
    { label: "Landed an application", users: submitted }
  ];

  let previous = total;
  return steps.map((step) => {
    const lost = Math.max(previous - step.users, 0);
    previous = step.users;
    return {
      ...step,
      sharePct: total > 0 ? Math.round((step.users / total) * 100) : 0,
      lost
    };
  });
}

export interface CohortRow {
  /** ISO date of the Monday that starts the cohort week. */
  weekStart: string;
  signups: number;
  /** Cohort members who have signed in within the last 30 days. */
  stillActive: number;
  retentionPct: number;
}

function mondayOf(date: Date): string {
  const day = date.getUTCDay();
  // getUTCDay is 0 for Sunday, so shift Sunday back six days rather than forward.
  const offset = day === 0 ? 6 : day - 1;
  const monday = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - offset)
  );
  return monday.toISOString().slice(0, 10);
}

/**
 * Weekly signup cohorts and how many of each are still around. Retention is
 * measured against a 30-day sign-in window rather than a per-cohort anniversary:
 * with a small platform the anniversary version is mostly sampling noise.
 */
export function cohortRetention(
  profiles: AdminProfileRow[],
  directory: Map<string, AuthDirectoryEntry>,
  weeks = 8,
  now: Date = new Date()
): CohortRow[] {
  const cutoff = now.getTime() - weeks * 7 * DAY_MS;
  const cohorts = new Map<string, { signups: number; stillActive: number }>();

  for (const profile of profiles) {
    const created = Date.parse(profile.created_at);
    if (!Number.isFinite(created) || created < cutoff || created > now.getTime()) continue;
    const key = mondayOf(new Date(created));
    const cohort = cohorts.get(key) ?? { signups: 0, stillActive: 0 };
    cohort.signups += 1;
    const lastSignIn = directory.get(profile.id)?.lastSignInAt;
    const at = lastSignIn ? Date.parse(lastSignIn) : NaN;
    if (Number.isFinite(at) && now.getTime() - at <= 30 * DAY_MS) cohort.stillActive += 1;
    cohorts.set(key, cohort);
  }

  return [...cohorts.entries()]
    .map(([weekStart, cohort]) => ({
      weekStart,
      signups: cohort.signups,
      stillActive: cohort.stillActive,
      retentionPct: pct(cohort.stillActive, cohort.signups)
    }))
    .sort((a, b) => a.weekStart.localeCompare(b.weekStart));
}
