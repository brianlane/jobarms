import { NextResponse } from "next/server";
import { getAdminUser } from "@/lib/admin/guard";
import { logAdminAction } from "@/lib/admin/audit";
import { createSupabaseServiceClient } from "@/lib/supabase/service";
import { cancelRun } from "@/lib/arm";
import { cancelRefund } from "@/lib/run-outcome";

const CANCELLABLE = ["queued", "running", "needs_review", "approved", "submitting"];

/**
 * Cancel a run on the user's behalf: for a run wedged in the workflow, or a
 * review gate the user has clearly abandoned and is about to time out into a
 * consumed slot.
 *
 * Metering follows the SAME `cancelRefund` policy as the user-facing cancel, but
 * with one difference recorded in the data: `canceled_by` is stamped `system`,
 * because the user did not make this choice. That keeps the provenance honest,
 * and the operator can still force a refund separately if the situation warrants
 * one that policy does not grant.
 */
export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const admin = await getAdminUser();
  if (!admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { id } = await ctx.params;
  const supabase = createSupabaseServiceClient();
  const { data: run } = await supabase
    .from("application_runs")
    .select("id, user_id, status, answers, application_id")
    .eq("id", id)
    .maybeSingle();
  if (!run) return NextResponse.json({ error: "not_found" }, { status: 404 });

  if (!CANCELLABLE.includes(run.status as string)) {
    return NextResponse.json(
      { error: "not_cancellable", status: run.status },
      { status: 409 }
    );
  }

  await cancelRun(id); // best effort; the database below is the source of truth
  const refund = cancelRefund(run.status as string, run.answers);

  await supabase
    .from("application_runs")
    .update({ status: "canceled", canceled_by: "system" })
    .eq("id", id);
  await supabase.from("applications").update({ status: "saved" }).eq("id", run.application_id);
  if (refund) await supabase.rpc("refund_arm_run", { p_run_id: id });

  await logAdminAction({
    adminEmail: admin.email,
    action: "cancel_run",
    targetUserId: run.user_id as string,
    targetRunId: id,
    detail: { previousStatus: run.status, refunded: refund }
  });

  return NextResponse.json({ ok: true, refunded: refund });
}
