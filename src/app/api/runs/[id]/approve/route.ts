import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceClient } from "@/lib/supabase/service";
import { approveRun } from "@/lib/arm";
import {
  memoryFromApproval,
  statsFromApproval,
  type AnswerLike,
  type FieldLike
} from "@/lib/answer-memory";

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
    .select("id, status, answers, form_fields, application_id")
    .eq("id", id)
    .maybeSingle();
  if (!run) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (run.status !== "needs_review") {
    return NextResponse.json({ error: "not_reviewable", status: run.status }, { status: 409 });
  }

  const service = createSupabaseServiceClient();
  const generated = (run.answers ?? []) as AnswerLike[];
  const approved = (parsed.data.answers ?? generated) as AnswerLike[];

  if (parsed.data.answers) {
    await service.from("application_runs").update({ answers: parsed.data.answers }).eq("id", id);
  }

  const result = await approveRun(id, parsed.data.answers);
  if (!result.ok) {
    return NextResponse.json({ error: result.reason }, { status: 503 });
  }

  // Learning capture (best-effort; never blocks the approval): the user's
  // approved/edited answers become their memory, and anonymized per-field
  // aggregates make every future arm run smarter platform-wide.
  try {
    const memory = memoryFromApproval(generated, approved);
    if (memory.length > 0) {
      await service.rpc("record_answer_memory", {
        p_user_id: user.id,
        p_entries: memory
      });
    }

    const fields = (run.form_fields ?? []) as FieldLike[];
    if (fields.length > 0) {
      const { data: app } = await service
        .from("applications")
        .select("jobs(ats)")
        .eq("id", run.application_id)
        .maybeSingle();
      const ats = (app?.jobs as unknown as { ats?: string } | null)?.ats;
      if (ats) {
        await service.rpc("record_field_stats", {
          p_ats: ats,
          p_updates: statsFromApproval(fields, generated, approved)
        });
      }
    }
  } catch {
    // capture is advisory; the submission is already in flight
  }

  return NextResponse.json({ ok: true });
}
