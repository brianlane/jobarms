/**
 * Everything the admin needs about ONE user. Service-role reads, bounded per
 * table, plus the impact preview the delete action shows before it destroys
 * anything.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/service";
import { aiCallQuota, armRunQuota, meterKey, type AiCallKind, type Plan } from "@/lib/plans";
import { pct, planOf, type AdminSubscriptionRow } from "@/lib/admin/overview";
import type { AdminRunRow } from "@/lib/admin/run-stats";
import type { AuthDirectoryEntry } from "@/lib/admin/users-table";

/** Per-table caps: a detail page shows history, not an unbounded archive. */
export const DETAIL_APPLICATION_CAP = 200;
export const DETAIL_RUN_CAP = 200;
export const DETAIL_RESUME_CAP = 50;
export const DETAIL_EMAIL_CAP = 25;
export const DETAIL_MEMORY_CAP = 500;
export const DETAIL_SITE_ACCOUNT_CAP = 50;

export interface AdminUserProfile {
  id: string;
  email: string;
  full_name: string;
  phone: string;
  location: string;
  headline: string;
  summary: string;
  links: Record<string, unknown> | null;
  work_history: unknown[] | null;
  education: unknown[] | null;
  skills: unknown[] | null;
  eeo: Record<string, unknown> | null;
  preferences: Record<string, unknown> | null;
  arm_autonomy: string;
  onboarding_complete: boolean;
  welcome_sent: boolean;
  applicant_alias: string | null;
  created_at: string;
  updated_at: string;
}

export interface AdminUserApplication {
  id: string;
  status: string;
  source: string;
  created_at: string;
  applied_at: string | null;
  jobs: { company: string; title: string; ats: string; url: string } | null;
}

export interface AdminUserResume {
  id: string;
  kind: string;
  file_name: string;
  application_id: string | null;
  created_at: string;
}

export interface AdminUserEmail {
  id: string;
  alias: string;
  from_address: string;
  subject: string;
  verification_link: string | null;
  verification_code: string | null;
  forwarded: boolean;
  created_at: string;
}

export interface AdminUserSiteAccount {
  tenant_host: string;
  alias_email: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface MemoryStats {
  total: number;
  userEdited: number;
  approved: number;
  topQuestions: { label: string; timesUsed: number; source: string }[];
}

export interface QuotaStatus {
  used: number;
  limit: number;
  window: string;
  pct: number;
}

export interface AdminUserDetail {
  profile: AdminUserProfile;
  subscription: AdminSubscriptionRow | null;
  plan: Plan;
  auth: AuthDirectoryEntry | null;
  applications: AdminUserApplication[];
  runs: AdminRunRow[];
  resumes: AdminUserResume[];
  emails: AdminUserEmail[];
  siteAccounts: AdminUserSiteAccount[];
  memory: MemoryStats;
  armQuota: QuotaStatus;
  aiQuotas: { kind: AiCallKind; used: number; limit: number; window: string }[];
}

const AI_KINDS: AiCallKind[] = ["resume_parse", "tailor_resume", "cover_letter"];

/** The auth-directory facts for one user, or null when the lookup fails. */
export async function loadAuthEntry(userId: string): Promise<AuthDirectoryEntry | null> {
  try {
    const supabase = createSupabaseServiceClient();
    const { data, error } = await supabase.auth.admin.getUserById(userId);
    if (error || !data?.user) return null;
    return {
      lastSignInAt: data.user.last_sign_in_at ?? null,
      emailConfirmedAt: data.user.email_confirmed_at ?? null
    };
  } catch {
    return null;
  }
}

function summarizeMemory(
  rows: { question_key: string; label: string; source: string; times_used: number }[]
): MemoryStats {
  let userEdited = 0;
  for (const row of rows) {
    if (row.source === "user_edited") userEdited += 1;
  }
  const topQuestions = [...rows]
    .sort((a, b) => b.times_used - a.times_used)
    .slice(0, 8)
    .map((row) => ({
      label: row.label || row.question_key,
      timesUsed: row.times_used,
      source: row.source
    }));
  return { total: rows.length, userEdited, approved: rows.length - userEdited, topQuestions };
}

/**
 * The whole per-user picture. Returns null when the profile does not exist,
 * which is what the page turns into a 404.
 */
export async function loadUserDetail(
  userId: string,
  now: Date = new Date()
): Promise<AdminUserDetail | null> {
  const supabase = createSupabaseServiceClient();

  const { data: profile } = await supabase
    .from("profiles")
    .select(
      "id, email, full_name, phone, location, headline, summary, links, work_history, education, skills, eeo, preferences, arm_autonomy, onboarding_complete, welcome_sent, applicant_alias, created_at, updated_at"
    )
    .eq("id", userId)
    .maybeSingle();
  if (!profile) return null;

  const [
    { data: subscription },
    { data: applications },
    { data: runs },
    { data: resumes },
    { data: emails },
    { data: siteAccounts },
    { data: memory },
    { data: aiUsage },
    auth
  ] = await Promise.all([
    supabase
      .from("subscriptions")
      .select(
        "user_id, plan, status, current_period_end, cancel_at_period_end, stripe_customer_id, stripe_subscription_id, updated_at"
      )
      .eq("user_id", userId)
      .maybeSingle(),
    supabase
      .from("applications")
      .select("id, status, source, created_at, applied_at, jobs(company, title, ats, url)")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(DETAIL_APPLICATION_CAP),
    supabase
      .from("application_runs")
      .select(
        "id, user_id, application_id, status, autonomy, error, created_at, updated_at, slot_refunded, canceled_by"
      )
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(DETAIL_RUN_CAP),
    supabase
      .from("resumes")
      .select("id, kind, file_name, application_id, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(DETAIL_RESUME_CAP),
    supabase
      .from("inbound_emails")
      .select(
        "id, alias, from_address, subject, verification_link, verification_code, forwarded, created_at"
      )
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(DETAIL_EMAIL_CAP),
    // Candidate accounts the arm created on login-gated ATSes. The encrypted
    // password column is deliberately NOT selected: an operator screen has no
    // reason to hold a user's ATS credentials, even encrypted.
    supabase
      .from("site_accounts")
      .select("tenant_host, alias_email, status, created_at, updated_at")
      .eq("user_id", userId)
      .order("updated_at", { ascending: false })
      .limit(DETAIL_SITE_ACCOUNT_CAP),
    supabase
      .from("user_answer_memory")
      .select("question_key, label, source, times_used")
      .eq("user_id", userId)
      .limit(DETAIL_MEMORY_CAP),
    supabase.from("ai_usage").select("user_id, month_key, kind, used").eq("user_id", userId),
    loadAuthEntry(userId)
  ]);

  const sub = (subscription ?? null) as AdminSubscriptionRow | null;
  const plan = planOf(sub);

  // Arm-run usage is keyed to the plan's own window (day for max, month
  // otherwise), so read exactly the slot the gate would read.
  const arm = armRunQuota(plan);
  const { data: armUsage } = await supabase
    .from("arm_run_usage")
    .select("runs_used")
    .eq("user_id", userId)
    .eq("month_key", meterKey(arm.window, now))
    .maybeSingle();
  const armUsed = (armUsage as { runs_used: number } | null)?.runs_used ?? 0;

  const aiRows = (aiUsage ?? []) as { month_key: string; kind: string; used: number }[];
  const aiQuotas = AI_KINDS.map((kind) => {
    const quota = aiCallQuota(plan, kind);
    const key = meterKey(quota.window, now);
    const row = aiRows.find((r) => r.kind === kind && r.month_key === key);
    return { kind, used: row?.used ?? 0, limit: quota.limit, window: quota.window };
  });

  return {
    profile: profile as unknown as AdminUserProfile,
    subscription: sub,
    plan,
    auth,
    applications: (applications ?? []) as unknown as AdminUserApplication[],
    runs: (runs ?? []) as AdminRunRow[],
    resumes: (resumes ?? []) as AdminUserResume[],
    emails: (emails ?? []) as AdminUserEmail[],
    siteAccounts: (siteAccounts ?? []) as AdminUserSiteAccount[],
    memory: summarizeMemory(
      (memory ?? []) as {
        question_key: string;
        label: string;
        source: string;
        times_used: number;
      }[]
    ),
    armQuota: {
      used: armUsed,
      limit: arm.limit,
      window: arm.window,
      pct: pct(armUsed, arm.limit)
    },
    aiQuotas
  };
}

export interface DeletionImpact {
  applications: number;
  runs: number;
  resumes: number;
  emails: number;
  memory: number;
  siteAccounts: number;
  /** Set when the account is paying, so the operator cancels Stripe first. */
  activeSubscriptionId: string | null;
}

/**
 * What a delete would destroy. Every count is a real cascade: applications,
 * runs, resumes, alias mail, answer memory, and vaulted ATS accounts all
 * reference `auth.users` with `on delete cascade`, so removing the auth user
 * removes all of it.
 *
 * A live Stripe subscription is called out separately because the database
 * cascade cannot stop the billing: deleting the user leaves Stripe charging a
 * card with nobody to serve, so it has to be canceled first.
 */
export async function loadDeletionImpact(userId: string): Promise<DeletionImpact> {
  const supabase = createSupabaseServiceClient();
  const [applications, runs, resumes, emails, memory, siteAccounts, subscription] =
    await Promise.all([
      supabase
        .from("applications")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId),
      supabase
        .from("application_runs")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId),
      supabase.from("resumes").select("id", { count: "exact", head: true }).eq("user_id", userId),
      supabase
        .from("inbound_emails")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId),
      supabase
        .from("user_answer_memory")
        .select("question_key", { count: "exact", head: true })
        .eq("user_id", userId),
      supabase
        .from("site_accounts")
        .select("tenant_host", { count: "exact", head: true })
        .eq("user_id", userId),
      supabase
        .from("subscriptions")
        .select("stripe_subscription_id, plan, status")
        .eq("user_id", userId)
        .maybeSingle()
    ]);

  const sub = (subscription.data ?? null) as {
    stripe_subscription_id: string | null;
    plan: string;
    status: string;
  } | null;
  const live = sub && planOf(sub as AdminSubscriptionRow) !== "free";

  return {
    applications: applications.count ?? 0,
    runs: runs.count ?? 0,
    resumes: resumes.count ?? 0,
    emails: emails.count ?? 0,
    memory: memory.count ?? 0,
    siteAccounts: siteAccounts.count ?? 0,
    activeSubscriptionId: live ? sub.stripe_subscription_id : null
  };
}
