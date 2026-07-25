/**
 * One arm run, in full, for the admin forensics page: the step log, the form the
 * arm extracted, every answer it drafted, and signed screenshot URLs.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/service";
import { runSteps, type AdminRunRow, type RunStep } from "@/lib/admin/run-stats";

/** Screenshot links expire fast: an operator page is not a sharing surface. */
export const SCREENSHOT_TTL_SECONDS = 600;

export interface RunAnswer {
  label?: string;
  name?: string;
  value?: string | null;
  skipped?: boolean;
  type?: string;
  edited?: boolean;
}

export interface AdminRunDetail extends AdminRunRow {
  steps: RunStep[];
  answers: RunAnswer[];
  formFieldCount: number;
  screenshots: { path: string; url: string }[];
  month_key: string;
  tenant_host: string | null;
  workflow_instance_id: string | null;
  user: { id: string; email: string } | null;
  application: {
    id: string;
    status: string;
    company: string;
    title: string;
    ats: string;
    url: string;
  } | null;
}

/** The full run, or null when the id does not exist. */
export async function loadRunDetail(runId: string): Promise<AdminRunDetail | null> {
  const supabase = createSupabaseServiceClient();
  const { data: run } = await supabase
    .from("application_runs")
    .select(
      "id, user_id, application_id, status, autonomy, error, created_at, updated_at, slot_refunded, canceled_by, steps, answers, form_fields, screenshots, month_key, tenant_host, workflow_instance_id, applications(id, status, jobs(company, title, ats, url))"
    )
    .eq("id", runId)
    .maybeSingle();
  if (!run) return null;

  const row = run as Record<string, unknown>;
  const { data: profile } = await supabase
    .from("profiles")
    .select("id, email")
    .eq("id", row.user_id as string)
    .maybeSingle();

  // Signed one at a time: the bucket is private and these links are the only
  // way to see what the arm actually saw.
  const paths = Array.isArray(row.screenshots) ? (row.screenshots as string[]) : [];
  const screenshots: { path: string; url: string }[] = [];
  for (const path of paths) {
    const { data } = await supabase.storage
      .from("run-artifacts")
      .createSignedUrl(path, SCREENSHOT_TTL_SECONDS);
    if (data?.signedUrl) screenshots.push({ path, url: data.signedUrl });
  }

  const application = row.applications as {
    id: string;
    status: string;
    jobs: { company: string; title: string; ats: string; url: string } | null;
  } | null;

  return {
    id: row.id as string,
    user_id: row.user_id as string,
    application_id: row.application_id as string,
    status: row.status as string,
    autonomy: row.autonomy as string,
    error: (row.error as string | null) ?? null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
    slot_refunded: Boolean(row.slot_refunded),
    canceled_by: (row.canceled_by as string | null) ?? null,
    steps: runSteps(row.steps),
    answers: Array.isArray(row.answers) ? (row.answers as RunAnswer[]) : [],
    formFieldCount: Array.isArray(row.form_fields) ? row.form_fields.length : 0,
    screenshots,
    month_key: (row.month_key as string) ?? "",
    tenant_host: (row.tenant_host as string | null) ?? null,
    workflow_instance_id: (row.workflow_instance_id as string | null) ?? null,
    user: profile ? { id: profile.id as string, email: profile.email as string } : null,
    application: application
      ? {
          id: application.id,
          status: application.status,
          company: application.jobs?.company ?? "",
          title: application.jobs?.title ?? "",
          ats: application.jobs?.ats ?? "unknown",
          url: application.jobs?.url ?? ""
        }
      : null
  };
}

/** How many of the drafted answers the arm actually filled versus skipped. */
export function answerCounts(answers: RunAnswer[]): { filled: number; skipped: number } {
  let filled = 0;
  let skipped = 0;
  for (const answer of answers) {
    if (answer.skipped || !(answer.value ?? "").trim()) skipped += 1;
    else filled += 1;
  }
  return { filled, skipped };
}
