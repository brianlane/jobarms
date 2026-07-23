import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceClient } from "@/lib/supabase/service";
import { cancelRun } from "@/lib/arm";

/** Cancel a queued/running/review-gated run. */
export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { data: run } = await supabase
    .from("application_runs")
    .select("id, status, application_id")
    .eq("id", id)
    .maybeSingle();
  if (!run) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const cancellable = ["queued", "running", "needs_review", "approved"];
  if (!cancellable.includes(run.status)) {
    return NextResponse.json({ error: "not_cancellable", status: run.status }, { status: 409 });
  }

  await cancelRun(id); // best-effort; the DB is the source of truth below

  const service = createSupabaseServiceClient();
  await service.from("application_runs").update({ status: "canceled" }).eq("id", id);
  await service.from("applications").update({ status: "saved" }).eq("id", run.application_id);

  return NextResponse.json({ ok: true });
}
