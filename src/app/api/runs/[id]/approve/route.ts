import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceClient } from "@/lib/supabase/service";
import { approveRun } from "@/lib/arm";

const bodySchema = z.object({
  answers: z
    .array(
      z.object({
        name: z.string(),
        label: z.string(),
        value: z.string(),
        skipped: z.boolean().optional()
      })
    )
    .optional()
});

/** Approve a review-gated run (optionally with user-edited answers). */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });

  // Ownership + state check under the user's own RLS.
  const { data: run } = await supabase
    .from("application_runs")
    .select("id, status")
    .eq("id", id)
    .maybeSingle();
  if (!run) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (run.status !== "needs_review") {
    return NextResponse.json({ error: "not_reviewable", status: run.status }, { status: 409 });
  }

  if (parsed.data.answers) {
    const service = createSupabaseServiceClient();
    await service.from("application_runs").update({ answers: parsed.data.answers }).eq("id", id);
  }

  const result = await approveRun(id, parsed.data.answers);
  if (!result.ok) {
    return NextResponse.json({ error: result.reason }, { status: 503 });
  }
  return NextResponse.json({ ok: true });
}
