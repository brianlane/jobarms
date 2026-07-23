import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceClient } from "@/lib/supabase/service";
import { detectAts, normalizeJobUrl, SUPPORTED_ATS } from "@/lib/ats";
import { fetchJobMeta } from "@/lib/job-fetch";
import { armRunLimit, effectivePlan, monthKey, type SubscriptionRow } from "@/lib/plans";
import { dispatchRun } from "@/lib/arm";

export const maxDuration = 60;

const bodySchema = z.object({
  url: z.string().max(2000),
  mode: z.enum(["arm", "track_only"]).default("arm")
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

  const { data: resume } = await service
    .from("resumes")
    .select("id, file_name, storage_path, mime_type")
    .eq("user_id", user.id)
    .eq("kind", "base")
    .eq("parse_status", "parsed")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  // --- meter the run ---
  const { data: sub } = await service
    .from("subscriptions")
    .select("plan, status, current_period_end, cancel_at_period_end")
    .eq("user_id", user.id)
    .maybeSingle();
  const limit = armRunLimit(effectivePlan(sub as SubscriptionRow | null));
  const mk = monthKey();
  const { data: reserved } = await service.rpc("try_reserve_arm_run", {
    p_user_id: user.id,
    p_month_key: mk,
    p_limit: limit
  });
  if (!reserved) {
    return NextResponse.json(
      { error: "run_limit_reached", hint: "Upgrade to Premium for unlimited arm runs." },
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
    }
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
  return NextResponse.json({ application_id: applicationId, run_id: run.id });
}
