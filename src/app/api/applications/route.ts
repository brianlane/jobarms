import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceClient } from "@/lib/supabase/service";
import { detectAts, normalizeJobUrl, SUPPORTED_ATS } from "@/lib/ats";
import { fetchJobMeta } from "@/lib/job-fetch";
import {
  aiCallLimit,
  armRunLimit,
  canTailor,
  effectivePlan,
  monthKey,
  type SubscriptionRow
} from "@/lib/plans";
import { randomUUID } from "node:crypto";
import { tailorResume } from "@/lib/tailor";
import { renderResumePdf } from "@/lib/resume-pdf";
import { parsedResumeSchema } from "@/lib/resume-parse";
import { dispatchRun } from "@/lib/arm";
import { lessonsFromStats } from "@/lib/answer-memory";

export const maxDuration = 60;

const bodySchema = z.object({
  url: z.string().max(2000),
  mode: z.enum(["arm", "track_only"]).default("arm"),
  tailor: z.boolean().default(false)
});

/**
 * Create an application from a job URL.
 *  - track_only: tracker row, no arm.
 *  - arm: reserve a metered run and dispatch the apply arm.
 */
export async function POST(request: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });

  const jobUrl = normalizeJobUrl(parsed.data.url);
  if (!jobUrl) return NextResponse.json({ error: "invalid_url" }, { status: 400 });

  const ats = detectAts(jobUrl);
  const service = createSupabaseServiceClient();

  // --- upsert the job (shared catalog, keyed by URL) ---
  const meta = await fetchJobMeta(jobUrl);
  const { data: job, error: jobError } = await service
    .from("jobs")
    .upsert(
      {
        url: jobUrl,
        ats,
        source: "manual",
        company: meta.company,
        title: meta.title,
        location: meta.location,
        description: meta.description
      },
      { onConflict: "url" }
    )
    .select("id")
    .single();
  if (jobError || !job) return NextResponse.json({ error: "job_upsert_failed" }, { status: 500 });

  // --- create (or reuse) the application row ---
  const { data: existing } = await service
    .from("applications")
    .select("id, status")
    .eq("user_id", user.id)
    .eq("job_id", job.id)
    .maybeSingle();
  if (existing && parsed.data.mode === "arm" && existing.status !== "saved" && existing.status !== "failed") {
    return NextResponse.json({ error: "already_applied", application_id: existing.id }, { status: 409 });
  }

  const applicationId =
    existing?.id ??
    (
      await service
        .from("applications")
        .insert({ user_id: user.id, job_id: job.id, source: parsed.data.mode === "arm" ? "arm" : "manual" })
        .select("id")
        .single()
    ).data?.id;
  if (!applicationId) return NextResponse.json({ error: "application_insert_failed" }, { status: 500 });

  if (parsed.data.mode === "track_only") {
    return NextResponse.json({ application_id: applicationId });
  }

  // --- arm mode: supported ATS? ---
  if (!SUPPORTED_ATS.has(ats)) {
    return NextResponse.json(
      {
        error: "ats_unsupported",
        application_id: applicationId,
        hint: "The arm currently drives Greenhouse and Lever. The job was saved to your tracker."
      },
      { status: 422 }
    );
  }

  // --- load profile + latest parsed resume ---
  const { data: profile } = await service
    .from("profiles")
    .select(
      "full_name, email, phone, location, headline, summary, links, work_history, education, skills, eeo, preferences, arm_autonomy"
    )
    .eq("id", user.id)
    .single();
  if (!profile) return NextResponse.json({ error: "profile_missing" }, { status: 400 });

  let { data: resume } = await service
    .from("resumes")
    .select("id, file_name, storage_path, mime_type")
    .eq("user_id", user.id)
    .eq("kind", "base")
    .eq("parse_status", "parsed")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  // Tailor-first (premium): rewrite the resume around this job's keywords
  // BEFORE the arm runs, so the tailored PDF is the file it uploads. Any
  // tailoring failure falls back to the base resume; it never blocks the run.
  let tailored = false;
  if (parsed.data.tailor && resume) {
    const { data: subForTailor } = await service
      .from("subscriptions")
      .select("plan, status, current_period_end, cancel_at_period_end")
      .eq("user_id", user.id)
      .maybeSingle();
    const tailorPlan = effectivePlan(subForTailor as SubscriptionRow | null);
    if (canTailor(tailorPlan)) {
      const { data: slot } = await service.rpc("try_reserve_ai_call", {
        p_user_id: user.id,
        p_month_key: monthKey(),
        p_kind: "tailor_resume",
        p_limit: aiCallLimit(tailorPlan, "tailor_resume")
      });
      if (slot) {
        try {
          const result = await tailorResume(
            profile as Record<string, unknown>,
            meta.title,
            meta.company,
            meta.description
          );
          const pdf = await renderResumePdf(parsedResumeSchema.parse(result.resume));
          const storagePath = `${user.id}/${randomUUID()}.pdf`;
          const { error: uploadError } = await service.storage
            .from("resumes")
            .upload(storagePath, pdf, { contentType: "application/pdf" });
          if (uploadError) throw uploadError;

          const fileName = `${(meta.company || "tailored").replace(/[^a-z0-9]+/gi, "-")}-resume.pdf`;
          const { data: tailoredRow } = await service
            .from("resumes")
            .insert({
              user_id: user.id,
              kind: "tailored",
              application_id: applicationId,
              file_name: fileName,
              storage_path: storagePath,
              mime_type: "application/pdf",
              parsed: result.resume,
              parse_status: "parsed"
            })
            .select("id, file_name, storage_path, mime_type")
            .single();
          if (tailoredRow) {
            await service
              .from("applications")
              .update({ resume_id: tailoredRow.id })
              .eq("id", applicationId);
            resume = tailoredRow;
            tailored = true;
          }
        } catch {
          await service.rpc("release_ai_call", {
            p_user_id: user.id,
            p_month_key: monthKey(),
            p_kind: "tailor_resume"
          });
        }
      }
    }
  }

  // --- meter the run ---
  const { data: sub } = await service
    .from("subscriptions")
    .select("plan, status, current_period_end, cancel_at_period_end")
    .eq("user_id", user.id)
    .maybeSingle();
  const plan = effectivePlan(sub as SubscriptionRow | null);
  const limit = armRunLimit(plan);
  const mk = monthKey();
  const { data: reserved } = await service.rpc("try_reserve_arm_run", {
    p_user_id: user.id,
    p_month_key: mk,
    p_limit: limit
  });
  if (!reserved) {
    return NextResponse.json(
      {
        error: "run_limit_reached",
        hint:
          plan === "free"
            ? "You've used this month's free arm runs. Upgrade to Premium for 300 a month."
            : "You've hit this month's fair-use cap for arm runs. It resets next month."
      },
      { status: 402 }
    );
  }

  // --- create the run row ---
  const { data: run, error: runError } = await service
    .from("application_runs")
    .insert({
      application_id: applicationId,
      user_id: user.id,
      autonomy: profile.arm_autonomy ?? "review_gate",
      month_key: mk
    })
    .select("id")
    .single();
  if (runError || !run) {
    await service.rpc("release_arm_run", { p_user_id: user.id, p_month_key: mk });
    return NextResponse.json({ error: "run_insert_failed" }, { status: 500 });
  }

  // --- learning payloads: user memory + anonymous platform lessons ---
  const [{ data: memoryRows }, { data: statRows }] = await Promise.all([
    service
      .from("user_answer_memory")
      .select("label, answer, source")
      .eq("user_id", user.id)
      .order("times_used", { ascending: false })
      .order("updated_at", { ascending: false })
      .limit(80),
    service
      .from("platform_field_stats")
      .select("question_key, label_example, times_seen, times_skipped, option_counts")
      .eq("ats", ats)
      .order("times_seen", { ascending: false })
      .limit(60)
  ]);
  const memory = {
    answers: (memoryRows ?? []).map((m) => ({
      label: m.label as string,
      answer: m.answer as string,
      source: m.source as string
    })),
    lessons: lessonsFromStats(
      (statRows ?? []).map((r) => ({
        question_key: r.question_key as string,
        label_example: r.label_example as string,
        times_seen: r.times_seen as number,
        times_skipped: r.times_skipped as number,
        option_counts: (r.option_counts ?? {}) as Record<string, number>
      }))
    ).map((l) => l.guidance)
  };

  // --- signed resume URL (24h - outlives the review gate for most users) ---
  let signedUrl: string | null = null;
  if (resume) {
    const { data: signed } = await service.storage
      .from("resumes")
      .createSignedUrl(resume.storage_path, 60 * 60 * 24);
    signedUrl = signed?.signedUrl ?? null;
  }

  // --- dispatch to the arm worker ---
  const dispatch = await dispatchRun({
    runId: run.id,
    applicationId,
    userId: user.id,
    jobUrl,
    ats,
    autonomy: (profile.arm_autonomy as "review_gate" | "full_auto") ?? "review_gate",
    jobTitle: meta.title,
    jobCompany: meta.company,
    jobDescription: meta.description,
    profile: profile as Record<string, unknown>,
    resume: {
      signedUrl,
      fileName: resume?.file_name ?? "resume.pdf",
      mimeType: resume?.mime_type ?? "application/pdf"
    },
    memory
  });

  if (!dispatch.ok) {
    await service
      .from("application_runs")
      .update({ status: "failed", error: dispatch.reason })
      .eq("id", run.id);
    await service.rpc("release_arm_run", { p_user_id: user.id, p_month_key: mk });
    const hint =
      dispatch.reason === "arm_unconfigured" || dispatch.reason === "arm_offline"
        ? "The arm isn't deployed yet (Phase 3 Workers Paid upgrade). The job was saved to your tracker."
        : "The arm couldn't start. Try again shortly.";
    return NextResponse.json({ error: dispatch.reason, application_id: applicationId, hint }, { status: 503 });
  }

  await service.from("applications").update({ status: "applying" }).eq("id", applicationId);
  return NextResponse.json({ application_id: applicationId, run_id: run.id, tailored });
}
