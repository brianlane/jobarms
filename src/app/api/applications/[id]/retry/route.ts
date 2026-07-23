import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceClient } from "@/lib/supabase/service";
import { SUPPORTED_ATS, type Ats } from "@/lib/ats";
import {
  armRunQuota,
  canFullAuto,
  effectivePlan,
  meterKey,
  type SubscriptionRow
} from "@/lib/plans";
import { retryDecision } from "@/lib/run-outcome";
import { cancelRun } from "@/lib/arm";
import { buildAndDispatchRun } from "@/lib/arm-dispatch";

export const maxDuration = 60;

/**
 * Retry an application with a fresh arm. Eligible when the latest run is
 * terminal (failed/canceled), dead-ended at a junk review, or stuck >24h.
 * Stale-run metering follows the outcome policy: system failures refund
 * (idempotent refund_arm_run), user behavior stays consumed. The new run
 * reserves its own slot.
 */
export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // Ownership via RLS.
  const { data: app } = await supabase
    .from("applications")
    .select("id, resume_id, jobs(url, ats, title, company, description)")
    .eq("id", id)
    .maybeSingle();
  if (!app) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const job = app.jobs as unknown as {
    url: string;
    ats: Ats;
    title: string;
    company: string;
    description: string;
  } | null;
  if (!job || !SUPPORTED_ATS.has(job.ats)) {
    return NextResponse.json(
      { error: "ats_unsupported", hint: "The arm currently drives Greenhouse and Lever postings." },
      { status: 422 }
    );
  }

  const { data: latestRun } = await supabase
    .from("application_runs")
    .select("id, status, answers, created_at")
    .eq("application_id", id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const decision = retryDecision(latestRun ?? null);
  if (!decision.eligible) {
    return NextResponse.json(
      { error: "not_retryable", hint: `This application can't be retried right now (${decision.reason}).` },
      { status: 409 }
    );
  }

  const service = createSupabaseServiceClient();

  // Settle the stale run per policy.
  if (latestRun) {
    if (decision.cancelStale) {
      await cancelRun(latestRun.id); // best-effort worker terminate
      await service
        .from("application_runs")
        .update({ status: "canceled", canceled_by: "system" })
        .eq("id", latestRun.id);
    }
    if (decision.refundStale) {
      await service.rpc("refund_arm_run", { p_run_id: latestRun.id });
    }
  }

  // Profile + resume (prefer the application's tailored resume when set).
  const { data: profile } = await service
    .from("profiles")
    .select(
      "full_name, email, phone, location, headline, summary, links, work_history, education, skills, eeo, preferences, arm_autonomy"
    )
    .eq("id", user.id)
    .single();
  if (!profile) return NextResponse.json({ error: "profile_missing" }, { status: 400 });

  let resume: { file_name: string; storage_path: string; mime_type: string } | null = null;
  if (app.resume_id) {
    const { data } = await service
      .from("resumes")
      .select("file_name, storage_path, mime_type")
      .eq("id", app.resume_id)
      .maybeSingle();
    resume = data ?? null;
  }
  if (!resume) {
    const { data } = await service
      .from("resumes")
      .select("file_name, storage_path, mime_type")
      .eq("user_id", user.id)
      .eq("kind", "base")
      .eq("parse_status", "parsed")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    resume = data ?? null;
  }

  // Meter the fresh run.
  const { data: sub } = await service
    .from("subscriptions")
    .select("plan, status, current_period_end, cancel_at_period_end")
    .eq("user_id", user.id)
    .maybeSingle();
  const plan = effectivePlan(sub as SubscriptionRow | null);
  const quota = armRunQuota(plan);
  const mk = meterKey(quota.window);
  const { data: reserved } = await service.rpc("try_reserve_arm_run", {
    p_user_id: user.id,
    p_month_key: mk,
    p_limit: quota.limit
  });
  if (!reserved) {
    return NextResponse.json(
      { error: "run_limit_reached", hint: "You're out of arm runs for this window." },
      { status: 402 }
    );
  }

  const requestedAutonomy = (profile.arm_autonomy as "review_gate" | "full_auto") ?? "review_gate";
  const autonomy = canFullAuto(plan) ? requestedAutonomy : "review_gate";

  const { data: newRun, error: runError } = await service
    .from("application_runs")
    .insert({ application_id: id, user_id: user.id, autonomy, month_key: mk })
    .select("id")
    .single();
  if (runError || !newRun) {
    await service.rpc("release_arm_run", { p_user_id: user.id, p_month_key: mk });
    return NextResponse.json({ error: "run_insert_failed" }, { status: 500 });
  }

  const dispatch = await buildAndDispatchRun(service, {
    runId: newRun.id,
    applicationId: id,
    userId: user.id,
    jobUrl: job.url,
    ats: job.ats as "greenhouse" | "lever",
    autonomy,
    jobTitle: job.title,
    jobCompany: job.company,
    jobDescription: job.description,
    profile: profile as Record<string, unknown>,
    resume
  });

  if (!dispatch.ok) {
    await service
      .from("application_runs")
      .update({ status: "failed", error: dispatch.reason })
      .eq("id", newRun.id);
    await service.rpc("release_arm_run", { p_user_id: user.id, p_month_key: mk });
    return NextResponse.json(
      { error: dispatch.reason, hint: "The arm couldn't start. Try again shortly." },
      { status: 503 }
    );
  }

  await service.from("applications").update({ status: "applying" }).eq("id", id);
  return NextResponse.json({ ok: true, run_id: newRun.id });
}
