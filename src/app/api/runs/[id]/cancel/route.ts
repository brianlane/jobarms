import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceClient } from "@/lib/supabase/service";
import { cancelRun } from "@/lib/arm";
import { cancelRefund } from "@/lib/run-outcome";

/**
 * Cancel a queued/running/review-gated run.
 * Metering follows the outcome policy: a user canceling working machinery
 * or a real review CONSUMES the slot; canceling a run that already
 * dead-ended with nothing reviewable refunds it (system failure; the click
 * is cleanup, not a choice).
 */
export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { data: run } = await supabase
    .from("application_runs")
    .select("id, status, answers, application_id")
    .eq("id", id)
    .maybeSingle();
  if (!run) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const cancellable = ["queued", "running", "needs_review", "approved"];
  if (!cancellable.includes(run.status)) {
    return NextResponse.json({ error: "not_cancellable", status: run.status }, { status: 409 });
  }

  await cancelRun(id); // best-effort; the DB is the source of truth below

  const refund = cancelRefund(run.status, run.answers);
  const service = createSupabaseServiceClient();
  await service
    .from("application_runs")
    .update({ status: "canceled", canceled_by: refund ? "system" : "user" })
    .eq("id", id);
  await service.from("applications").update({ status: "saved" }).eq("id", run.application_id);
  if (refund) {
    await service.rpc("refund_arm_run", { p_run_id: id });
  }

  return NextResponse.json({ ok: true, refunded: refund });
}
