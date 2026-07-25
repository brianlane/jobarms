/**
 * Admin action audit trail. Every mutating admin route records WHO did WHAT to
 * WHICH target in `admin_audit_log` before it answers, so /admin/system can
 * show the operator history.
 *
 * Writes are fire-and-forget by design: auditing must never take down the
 * action it observes, so a failed insert is logged to stderr and swallowed.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/service";

export interface AdminAuditInput {
  adminEmail: string;
  /** snake_case verb, e.g. "comp_plan", "refund_run", "delete_user". */
  action: string;
  targetUserId?: string | null;
  targetRunId?: string | null;
  detail?: Record<string, unknown>;
}

export interface AdminAuditRow {
  id: string;
  admin_email: string;
  action: string;
  target_user_id: string | null;
  target_run_id: string | null;
  detail: Record<string, unknown> | null;
  created_at: string;
}

export async function logAdminAction(input: AdminAuditInput): Promise<void> {
  try {
    const supabase = createSupabaseServiceClient();
    const { error } = await supabase.from("admin_audit_log").insert({
      admin_email: input.adminEmail,
      action: input.action,
      target_user_id: input.targetUserId ?? null,
      target_run_id: input.targetRunId ?? null,
      detail: input.detail ?? {}
    });
    if (error) throw error;
  } catch (err) {
    console.error(
      "admin audit write failed",
      input.action,
      err instanceof Error ? err.message : err
    );
  }
}

/** Newest audit rows for the /admin/system viewer. */
export async function listAdminAuditLog(limit = 50): Promise<AdminAuditRow[]> {
  const supabase = createSupabaseServiceClient();
  const { data } = await supabase
    .from("admin_audit_log")
    .select("id, admin_email, action, target_user_id, target_run_id, detail, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);
  return (data ?? []) as AdminAuditRow[];
}

/** Human label for an audit verb: "comp_plan" becomes "comp plan". */
export function auditActionLabel(action: string): string {
  return action.replaceAll("_", " ");
}
