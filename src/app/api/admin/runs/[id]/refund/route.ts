import { NextResponse } from "next/server";
import { getAdminUser } from "@/lib/admin/guard";
import { logAdminAction } from "@/lib/admin/audit";
import { createSupabaseServiceClient } from "@/lib/supabase/service";

/**
 * Refund a metered arm-run slot by hand.
 *
 * The worker already refunds system failures automatically, so this is for the
 * cases policy cannot see: a run that burned a slot for a reason we decide after
 * the fact was ours (a bad deploy, an outage, a goodwill credit).
 *
 * `refund_arm_run` is idempotent and row-locks `slot_refunded` with the
 * decrement, so pressing this twice cannot double-refund. The RPC returns
 * whether it actually moved the counter, which is what we report.
 */
export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const admin = await getAdminUser();
  if (!admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { id } = await ctx.params;
  const supabase = createSupabaseServiceClient();
  const { data: run } = await supabase
    .from("application_runs")
    .select("id, user_id, slot_refunded")
    .eq("id", id)
    .maybeSingle();
  if (!run) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const { data: refunded, error } = await supabase.rpc("refund_arm_run", { p_run_id: id });
  if (error) return NextResponse.json({ error: "refund_failed" }, { status: 500 });

  await logAdminAction({
    adminEmail: admin.email,
    action: "force_refund_run",
    targetUserId: run.user_id as string,
    targetRunId: id,
    detail: { alreadyRefunded: Boolean(run.slot_refunded), moved: Boolean(refunded) }
  });

  return NextResponse.json({ ok: true, refunded: Boolean(refunded) });
}
