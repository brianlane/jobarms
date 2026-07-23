import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceClient } from "@/lib/supabase/service";
import {
  aiCallQuota,
  canTailor,
  effectivePlan,
  meterKey,
  type SubscriptionRow
} from "@/lib/plans";
import { generateCoverLetter, tailorResume } from "@/lib/tailor";
import { renderResumePdf } from "@/lib/resume-pdf";
import { parsedResumeSchema } from "@/lib/resume-parse";

export const maxDuration = 60;

const bodySchema = z.object({ kind: z.enum(["resume", "cover_letter"]) });

/**
 * Premium: tailor a resume (structured rewrite -> rendered PDF, becomes the
 * file the arm uploads) or generate a cover letter for this application.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });

  // Ownership (RLS) + job join
  const { data: app } = await supabase
    .from("applications")
    .select("id, jobs(title, company, description)")
    .eq("id", id)
    .maybeSingle();
  if (!app) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const job = app.jobs as unknown as { title: string; company: string; description: string } | null;

  const service = createSupabaseServiceClient();

  // Premium gate
  const { data: sub } = await service
    .from("subscriptions")
    .select("plan, status, current_period_end, cancel_at_period_end")
    .eq("user_id", user.id)
    .maybeSingle();
  const plan = effectivePlan(sub as SubscriptionRow | null);
  if (!canTailor(plan)) {
    return NextResponse.json(
      { error: "premium_required", hint: "Resume tailoring and cover letters are Premium features." },
      { status: 402 }
    );
  }

  // Meter the model call (fair-use cap; see plans.aiCallQuota).
  const kind = parsed.data.kind === "resume" ? "tailor_resume" : "cover_letter";
  const quota = aiCallQuota(plan, kind);
  const mk = meterKey(quota.window);
  const { data: reserved } = await service.rpc("try_reserve_ai_call", {
    p_user_id: user.id,
    p_month_key: mk,
    p_kind: kind,
    p_limit: quota.limit
  });
  if (!reserved) {
    return NextResponse.json(
      { error: "ai_limit_reached", hint: "You've hit this month's fair-use cap for this feature. It resets next month." },
      { status: 402 }
    );
  }

  const { data: profile } = await service
    .from("profiles")
    .select(
      "full_name, email, phone, location, headline, summary, links, work_history, education, skills"
    )
    .eq("id", user.id)
    .single();
  if (!profile) return NextResponse.json({ error: "profile_missing" }, { status: 400 });

  try {
    if (parsed.data.kind === "cover_letter") {
      const letter = await generateCoverLetter(
        profile as Record<string, unknown>,
        job?.title ?? "",
        job?.company ?? "",
        job?.description ?? ""
      );
      await service.from("applications").update({ cover_letter: letter }).eq("id", id);
      return NextResponse.json({ cover_letter: letter });
    }

    // kind === "resume"
    const result = await tailorResume(
      profile as Record<string, unknown>,
      job?.title ?? "",
      job?.company ?? "",
      job?.description ?? ""
    );
    const pdf = await renderResumePdf(parsedResumeSchema.parse(result.resume));

    const storagePath = `${user.id}/${randomUUID()}.pdf`;
    const { error: uploadError } = await service.storage
      .from("resumes")
      .upload(storagePath, pdf, { contentType: "application/pdf" });
    if (uploadError) return NextResponse.json({ error: "upload_failed" }, { status: 500 });

    const fileName = `${(job?.company || "tailored").replace(/[^a-z0-9]+/gi, "-")}-resume.pdf`;
    const { data: resumeRow, error: insertError } = await service
      .from("resumes")
      .insert({
        user_id: user.id,
        kind: "tailored",
        application_id: id,
        file_name: fileName,
        storage_path: storagePath,
        mime_type: "application/pdf",
        parsed: result.resume,
        parse_status: "parsed"
      })
      .select("id")
      .single();
    if (insertError || !resumeRow) {
      return NextResponse.json({ error: "insert_failed" }, { status: 500 });
    }

    await service.from("applications").update({ resume_id: resumeRow.id }).eq("id", id);

    const { data: signed } = await service.storage
      .from("resumes")
      .createSignedUrl(storagePath, 600);

    return NextResponse.json({
      resume_id: resumeRow.id,
      keywords: result.keywords,
      download_url: signed?.signedUrl ?? null
    });
  } catch {
    // Generation failed: give the metered slot back.
    await service.rpc("release_ai_call", {
      p_user_id: user.id,
      p_month_key: mk,
      p_kind: kind
    });
    return NextResponse.json(
      { error: "generation_failed", hint: "Temporary AI error. Try again in a moment." },
      { status: 503 }
    );
  }
}
