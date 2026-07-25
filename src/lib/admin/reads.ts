/**
 * Service-role reads behind the admin surfaces. Isolated from the aggregation
 * math (src/lib/admin/overview.ts, run-stats.ts) so pages stay thin and the
 * analytics stay unit-testable without a database.
 *
 * These bypass RLS on purpose: every admin table is read-own or service-only,
 * so a fleet-wide view has to hold the service role. Callers must already have
 * passed `getAdminUser()`.
 *
 * Reads are BOUNDED. Row-returning queries carry an explicit cap and, where the
 * table grows without limit (jobs, runs), a time window; big tables are counted
 * with head requests so no rows cross the wire.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/service";
import { armRunQuota, meterKey } from "@/lib/plans";
import {
  planOf,
  subscriptionsByUser,
  type AdminAiUsageRow,
  type AdminApplicationRow,
  type AdminProfileRow,
  type AdminSubscriptionRow,
  type CatalogSummary
} from "@/lib/admin/overview";
import type { AdminRunRow } from "@/lib/admin/run-stats";
import type { FieldStatRow, PlaybookRow } from "@/lib/admin/ats-health";

/** Row caps. Generous next to current scale, small enough to stay one page. */
export const USER_ROW_CAP = 5000;
export const RUN_ROW_CAP = 4000;
export const APPLICATION_ROW_CAP = 5000;
export const RUN_WINDOW_DAYS = 30;

const PROFILE_COLUMNS = "id, email, created_at, onboarding_complete, arm_autonomy";
const SUBSCRIPTION_COLUMNS =
  "user_id, plan, status, current_period_end, cancel_at_period_end, stripe_subscription_id, updated_at";
const RUN_COLUMNS =
  "id, user_id, application_id, status, autonomy, error, created_at, updated_at, slot_refunded, canceled_by";
const APPLICATION_COLUMNS = "id, user_id, status, source, created_at, applied_at";

export function windowStartIso(days: number, now: Date = new Date()): string {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

export async function loadProfiles(): Promise<AdminProfileRow[]> {
  const supabase = createSupabaseServiceClient();
  const { data } = await supabase
    .from("profiles")
    .select(PROFILE_COLUMNS)
    .order("created_at", { ascending: false })
    .limit(USER_ROW_CAP);
  return (data ?? []) as AdminProfileRow[];
}

export async function loadSubscriptions(): Promise<AdminSubscriptionRow[]> {
  const supabase = createSupabaseServiceClient();
  const { data } = await supabase
    .from("subscriptions")
    .select(SUBSCRIPTION_COLUMNS)
    .limit(USER_ROW_CAP);
  return (data ?? []) as AdminSubscriptionRow[];
}

export async function loadRecentRuns(
  days = RUN_WINDOW_DAYS,
  now: Date = new Date()
): Promise<AdminRunRow[]> {
  const supabase = createSupabaseServiceClient();
  const { data } = await supabase
    .from("application_runs")
    .select(RUN_COLUMNS)
    .gte("created_at", windowStartIso(days, now))
    .order("created_at", { ascending: false })
    .limit(RUN_ROW_CAP);
  return (data ?? []) as AdminRunRow[];
}

export async function loadApplications(): Promise<AdminApplicationRow[]> {
  const supabase = createSupabaseServiceClient();
  const { data } = await supabase
    .from("applications")
    .select(APPLICATION_COLUMNS)
    .order("created_at", { ascending: false })
    .limit(APPLICATION_ROW_CAP);
  return (data ?? []) as AdminApplicationRow[];
}

/** AI-call meter rows for one month key (the window every AI quota uses). */
export async function loadAiUsage(month = meterKey("month")): Promise<AdminAiUsageRow[]> {
  const supabase = createSupabaseServiceClient();
  const { data } = await supabase
    .from("ai_usage")
    .select("user_id, month_key, kind, used")
    .eq("month_key", month)
    .limit(USER_ROW_CAP);
  return (data ?? []) as AdminAiUsageRow[];
}

/**
 * Arm-run usage keyed to each user's OWN quota window: month for free and
 * premium, day for max. Returns runs-used per user id, so quota pressure can be
 * compared against `armRunQuota(plan).limit` directly.
 */
export async function loadQuotaUsage(
  profiles: AdminProfileRow[],
  subscriptions: AdminSubscriptionRow[],
  now: Date = new Date()
): Promise<Map<string, number>> {
  const supabase = createSupabaseServiceClient();
  const monthK = meterKey("month", now);
  const dayK = meterKey("day", now);

  const [{ data: monthRows }, { data: dayRows }] = await Promise.all([
    supabase.from("arm_run_usage").select("user_id, runs_used").eq("month_key", monthK).limit(USER_ROW_CAP),
    supabase.from("arm_run_usage").select("user_id, runs_used").eq("month_key", dayK).limit(USER_ROW_CAP)
  ]);

  const byMonth = new Map<string, number>();
  for (const row of (monthRows ?? []) as { user_id: string; runs_used: number }[]) {
    byMonth.set(row.user_id, row.runs_used);
  }
  const byDay = new Map<string, number>();
  for (const row of (dayRows ?? []) as { user_id: string; runs_used: number }[]) {
    byDay.set(row.user_id, row.runs_used);
  }

  const subs = subscriptionsByUser(subscriptions);
  const result = new Map<string, number>();
  for (const profile of profiles) {
    const window = armRunQuota(planOf(subs.get(profile.id) ?? null)).window;
    const source = window === "day" ? byDay : byMonth;
    result.set(profile.id, source.get(profile.id) ?? 0);
  }
  return result;
}

/**
 * Catalog size and ingestion freshness. Counted with head requests: the jobs
 * table is already in the thousands and grows every half hour, so pulling rows
 * to count them would be the one query on this page that does not scale.
 */
export async function loadCatalogSummary(now: Date = new Date()): Promise<CatalogSummary> {
  const supabase = createSupabaseServiceClient();
  const dayAgo = windowStartIso(1, now);

  const [total, added, companies, newest] = await Promise.all([
    supabase.from("jobs").select("id", { count: "exact", head: true }),
    supabase.from("jobs").select("id", { count: "exact", head: true }).gte("created_at", dayAgo),
    supabase.from("companies").select("id", { count: "exact", head: true }),
    supabase.from("jobs").select("created_at").order("created_at", { ascending: false }).limit(1)
  ]);

  const newestRows = (newest.data ?? []) as { created_at: string }[];
  return {
    jobs: total.count ?? 0,
    jobsAdded24h: added.count ?? 0,
    companies: companies.count ?? 0,
    byAts: {},
    newestJobAt: newestRows[0]?.created_at ?? null
  };
}

/**
 * Runs with their step log and the job they were applying to. Separate from
 * `loadRecentRuns` because the steps array and the nested job are only worth
 * carrying on the pages that read them (the run console and ATS health), not on
 * every overview render.
 */
export interface AdminRunWithJob extends AdminRunRow {
  steps: unknown;
  tenant_host?: string | null;
  applications: {
    id: string;
    status: string;
    jobs: { company: string; title: string; ats: string; url: string } | null;
  } | null;
}

export async function loadRunsWithJobs(
  days = RUN_WINDOW_DAYS,
  now: Date = new Date()
): Promise<AdminRunWithJob[]> {
  const supabase = createSupabaseServiceClient();
  const { data } = await supabase
    .from("application_runs")
    .select(
      `${RUN_COLUMNS}, steps, tenant_host, applications(id, status, jobs(company, title, ats, url))`
    )
    .gte("created_at", windowStartIso(days, now))
    .order("created_at", { ascending: false })
    .limit(RUN_ROW_CAP);
  return (data ?? []) as unknown as AdminRunWithJob[];
}

export const PLAYBOOK_ROW_CAP = 500;
export const FIELD_STAT_ROW_CAP = 500;

export async function loadPlaybooks(): Promise<PlaybookRow[]> {
  const supabase = createSupabaseServiceClient();
  const { data } = await supabase
    .from("arm_playbooks")
    .select("domain, ats, strategy, success_count, failure_count, last_success_at, updated_at")
    .order("updated_at", { ascending: false })
    .limit(PLAYBOOK_ROW_CAP);
  return (data ?? []) as PlaybookRow[];
}

export async function loadFieldStats(): Promise<FieldStatRow[]> {
  const supabase = createSupabaseServiceClient();
  const { data } = await supabase
    .from("platform_field_stats")
    .select(
      "ats, question_key, label_example, field_type, times_seen, times_skipped, times_edited, option_counts, updated_at"
    )
    .order("times_seen", { ascending: false })
    .limit(FIELD_STAT_ROW_CAP);
  return (data ?? []) as FieldStatRow[];
}

/** Pagination bounds for the auth-directory scan, far above current scale. */
export const AUTH_PAGE_CAP = 10;
export const AUTH_PER_PAGE = 500;

export interface AuthDirectory {
  byId: Map<string, { lastSignInAt: string | null; emailConfirmedAt: string | null }>;
  /**
   * True when the scan filled its page cap, meaning the directory is PARTIAL.
   * Callers must degrade rather than mis-read the users it never reached as
   * never having signed in.
   */
  clipped: boolean;
}

/**
 * Last sign-in and email-confirmation state for every account. Lives in the
 * auth schema rather than `profiles`, so it needs the admin API; the scan is
 * capped so a large directory cannot turn one page render into thousands of
 * calls. A failure degrades to an empty directory, since engagement is a
 * nice-to-have column and not worth erroring a page over.
 */
export async function loadAuthDirectory(): Promise<AuthDirectory> {
  const byId = new Map<string, { lastSignInAt: string | null; emailConfirmedAt: string | null }>();
  try {
    const supabase = createSupabaseServiceClient();
    for (let page = 1; page <= AUTH_PAGE_CAP; page += 1) {
      const { data, error } = await supabase.auth.admin.listUsers({
        page,
        perPage: AUTH_PER_PAGE
      });
      if (error) return { byId, clipped: true };
      const users = data?.users ?? [];
      for (const user of users) {
        byId.set(user.id, {
          lastSignInAt: user.last_sign_in_at ?? null,
          emailConfirmedAt: user.email_confirmed_at ?? null
        });
      }
      if (users.length < AUTH_PER_PAGE) return { byId, clipped: false };
    }
    return { byId, clipped: true };
  } catch {
    return { byId, clipped: true };
  }
}

export interface FleetSnapshot {
  profiles: AdminProfileRow[];
  subscriptions: AdminSubscriptionRow[];
  runs: AdminRunRow[];
  applications: AdminApplicationRow[];
  aiUsage: AdminAiUsageRow[];
  quotaUsage: Map<string, number>;
  catalog: CatalogSummary;
}

/**
 * Everything the platform overview needs, in as few round trips as the shape
 * allows. Quota usage depends on the profile and subscription rows, so it is
 * the one read that cannot join the first wave.
 */
export async function loadFleetSnapshot(now: Date = new Date()): Promise<FleetSnapshot> {
  const [profiles, subscriptions, runs, applications, aiUsage, catalog] = await Promise.all([
    loadProfiles(),
    loadSubscriptions(),
    loadRecentRuns(RUN_WINDOW_DAYS, now),
    loadApplications(),
    loadAiUsage(meterKey("month", now)),
    loadCatalogSummary(now)
  ]);
  const quotaUsage = await loadQuotaUsage(profiles, subscriptions, now);
  return { profiles, subscriptions, runs, applications, aiUsage, quotaUsage, catalog };
}
