import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceClient } from "@/lib/supabase/service";
import { cancelBatch } from "@/lib/arm";

/** Batch states where a cancel still means something. */
const CANCELLABLE = new Set(["queued", "searching", "running", "needs_login_code"]);

/**
 * Cancel a batch: terminate the workflow, then release the reserved slots that
 * were never spent on real application work. The release happens HERE (not in
 * the worker) from a re-read of the row after termination, so the count
 * reflects whatever the batch managed to do before it stopped.
 */
export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { data: batch } = await supabase
    .from("apply_batches")
    .select("id, status")
    .eq("id", id)
    .maybeSingle();
  if (!batch) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (!CANCELLABLE.has(batch.status)) {
    return NextResponse.json({ error: "not_cancellable", status: batch.status }, { status: 409 });
  }

  const result = await cancelBatch(id);
  if (!result.ok) return NextResponse.json({ error: result.reason }, { status: 503 });

  // The worker marks the row canceled only if it was still live, so a cancel
  // that raced the batch's own settle step leaves status "completed"/"failed"
  // and the batch's own release stands. Release here ONLY when the cancel
  // landed, from a re-read taken after termination.
  const service = createSupabaseServiceClient();
  const { data: settled } = await service
    .from("apply_batches")
    .select("status, reserved, consumed, month_key")
    .eq("id", id)
    .maybeSingle();
  if (settled && settled.status === "canceled" && settled.reserved > settled.consumed) {
    await service.rpc("release_arm_runs", {
      p_user_id: user.id,
      p_month_key: settled.month_key,
      p_count: settled.reserved - settled.consumed
    });
  }

  return NextResponse.json({ ok: true });
}
