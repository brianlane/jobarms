import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceClient } from "@/lib/supabase/service";
import {
  ACCOUNT_REQUIRED_ATS,
  detectAts,
  dispatchAtsOf,
  normalizeJobUrl,
  tenantHostOf,
  type Ats
} from "@/lib/ats";
import { ensureApplicantAlias } from "@/lib/applicant-email";
import { ensureSiteAccount } from "@/lib/site-accounts";
import { getLinkedInCredentials } from "@/lib/linkedin";
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
  if (!job) return NextResponse.json({ error: "not_found" }, { status: 404 });
  // Normalize the same way create does, so a stored URL that was never
  // canonicalized (e.g. a LinkedIn search link on `linkedin.com` without `www`)
  // keys the session and vault on the same host the create path would.
  const jobUrl = normalizeJobUrl(job.url) ?? job.url;
  // Re-detect from the URL rather than trust the stored `jobs.ats`: the catalog
  // row is shared and may predate a detector (a LinkedIn posting ingested before
  // LinkedIn support still reads `unknown`), and the create route already routes
  // on the URL, so this keeps retry from silently dispatching the wrong adapter.
  const detected = detectAts(jobUrl);
  const dispatchAts = dispatchAtsOf(detected);

  const { data: latestRun } = await supabase
    .from("application_runs")
    .select("id, status, answers, created_at")
    .eq("application_id", id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  // A prior run is the evidence the user accepted the best-effort terms at
  // dispatch time (the create route enforces the acknowledgment). Without one
  // this is a first dispatch in disguise, so send it through the front door.
  if (dispatchAts === "generic" && !latestRun) {
    return NextResponse.json(
      {
        error: "best_effort_ack_required",
        hint: "This job board isn't one the arm is tuned for. Start the arm from the apply page, which explains what best-effort means."
      },
      { status: 422 }
    );
  }

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

  // Generic runs are review-gate only on any plan, same rule as the create route.
  const requestedAutonomy = (profile.arm_autonomy as "review_gate" | "full_auto") ?? "review_gate";
  const autonomy =
    dispatchAts === "generic" || !canFullAuto(plan) ? "review_gate" : requestedAutonomy;

  // Account-gated ATSes: reuse the stored tenant credentials (ensureSiteAccount
  // is idempotent, so a retry signs in to the SAME account rather than creating
  // a second candidate profile on the employer's tenant). Generic runs never
  // touch the account path.
  const tenantHost = tenantHostOf(jobUrl);
  let account: { email: string; password: string } | null = null;
  if (dispatchAts === "linkedin") {
    // Reuse the user's connected LinkedIn login. A disconnect between the
    // original run and this retry is a 409 pointing back at Settings.
    const creds = await getLinkedInCredentials(service, user.id);
    if (!creds || creds.status === "locked") {
      await service.rpc("release_arm_run", { p_user_id: user.id, p_month_key: mk });
      return NextResponse.json(
        {
          error: creds ? "ats_account_locked" : "linkedin_not_connected",
          hint: creds
            ? "LinkedIn kept rejecting the sign-in, so it is locked. Reconnect your account in Settings."
            : "Reconnect your LinkedIn account in Settings before retrying this job."
        },
        { status: creds ? 422 : 409 }
      );
    }
    account = { email: creds.email, password: creds.password };
  } else if (dispatchAts !== "generic" && ACCOUNT_REQUIRED_ATS.has(detected) && tenantHost) {
    const alias = await ensureApplicantAlias(service, user.id);
    const siteAccount = alias
      ? await ensureSiteAccount(service, { userId: user.id, tenantHost, ats: detected, email: alias })
      : null;
    if (!siteAccount) {
      await service.rpc("release_arm_run", { p_user_id: user.id, p_month_key: mk });
      return NextResponse.json(
        {
          error: "ats_account_unavailable",
          hint: "We couldn't reuse the account this employer requires. The job stays in your tracker."
        },
        { status: 422 }
      );
    }
    account = { email: siteAccount.email, password: siteAccount.password };
  }

  const { data: newRun, error: runError } = await service
    .from("application_runs")
    .insert({
      application_id: id,
      user_id: user.id,
      autonomy,
      month_key: mk,
      tenant_host: tenantHost
    })
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
    jobUrl,
    ats: dispatchAts,
    autonomy,
    jobTitle: job.title,
    jobCompany: job.company,
    jobDescription: job.description,
    profile: profile as Record<string, unknown>,
    resume,
    account
  });

  if (!dispatch.ok) {
    await service
      .from("application_runs")
      .update({ status: "failed", error: dispatch.reason })
      .eq("id", newRun.id);
    // Refund by run id so slot_refunded is set: a subsequent retry of this
    // failed run must not decrement the counter again (see the create route).
    await service.rpc("refund_arm_run", { p_run_id: newRun.id });
    return NextResponse.json(
      { error: dispatch.reason, hint: "The arm couldn't start. Try again shortly." },
      { status: 503 }
    );
  }

  await service.from("applications").update({ status: "applying" }).eq("id", id);
  return NextResponse.json({ ok: true, run_id: newRun.id });
}
