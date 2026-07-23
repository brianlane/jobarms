/**
 * Server-side mirror of POST /api/applications/[id]/retry for live
 * verification (the route itself needs a browser session). Uses the SAME
 * policy + dispatch code paths (run-outcome, arm-dispatch), and prints the
 * metering math before/after.
 *
 *   set -a && source .env && set +a
 *   npx tsx debug/retry-application.ts <application-id> [--submit]
 *
 * Without --submit the run parks at the review gate (safe: never submits).
 * With --submit it dispatches full_auto and carries through to a REAL submit
 * on the posting, exercising Layer-1 realism + Layer-2 captcha vision, and
 * prints the real outcome (submitted | captcha_blocked | submit_unconfirmed).
 * Only point --submit at a low-stakes posting you're willing to actually apply to.
 */
import { createClient } from "@supabase/supabase-js";
import { retryDecision } from "../src/lib/run-outcome";
import { buildAndDispatchRun } from "../src/lib/arm-dispatch";
import { cancelRun } from "../src/lib/arm";
import { armRunQuota, canFullAuto, effectivePlan, meterKey } from "../src/lib/plans";
import type { SubscriptionRow } from "../src/lib/plans";

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} not set`);
  return v;
}

const appId = process.argv[2];
if (!appId) throw new Error("usage: retry-application.ts <application-id> [--submit]");
const doSubmit = process.argv.includes("--submit");

const service = createClient(need("NEXT_PUBLIC_SUPABASE_URL"), need("SUPABASE_SECRET_KEY"), {
  auth: { persistSession: false }
});

async function usage(userId: string): Promise<Record<string, number>> {
  const { data } = await service
    .from("arm_run_usage")
    .select("month_key, runs_used")
    .eq("user_id", userId);
  return Object.fromEntries((data ?? []).map((r) => [r.month_key, r.runs_used]));
}

async function main() {
  const { data: app } = await service
    .from("applications")
    .select("id, user_id, resume_id, jobs(url, ats, title, company, description)")
    .eq("id", appId)
    .single();
  if (!app) throw new Error("application not found");
  const job = app.jobs as unknown as {
    url: string;
    ats: "greenhouse" | "lever";
    title: string;
    company: string;
    description: string;
  };
  console.log(`app: ${job.title} @ ${job.company} (${job.ats})`);
  console.log("usage before:", await usage(app.user_id));

  const { data: latestRun } = await service
    .from("application_runs")
    .select("id, status, answers, created_at, slot_refunded")
    .eq("application_id", appId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  console.log(`latest run: ${latestRun?.id} status=${latestRun?.status} refunded=${latestRun?.slot_refunded}`);

  const decision = retryDecision(latestRun ?? null);
  console.log("decision:", decision);
  if (!decision.eligible) throw new Error("not retryable");

  if (latestRun && decision.cancelStale) {
    await cancelRun(latestRun.id);
    await service
      .from("application_runs")
      .update({ status: "canceled", canceled_by: "system" })
      .eq("id", latestRun.id);
    console.log("stale run canceled");
  }
  if (latestRun && decision.refundStale) {
    const { data: refunded } = await service.rpc("refund_arm_run", { p_run_id: latestRun.id });
    console.log("stale refund:", refunded);
    // Idempotency check: second call must be a no-op.
    const { data: again } = await service.rpc("refund_arm_run", { p_run_id: latestRun.id });
    console.log("second refund call (must be false):", again);
  }
  console.log("usage after settle:", await usage(app.user_id));

  const { data: profile } = await service
    .from("profiles")
    .select(
      "full_name, email, phone, location, headline, summary, links, work_history, education, skills, eeo, preferences, arm_autonomy"
    )
    .eq("id", app.user_id)
    .single();
  const { data: resume } = await service
    .from("resumes")
    .select("file_name, storage_path, mime_type")
    .eq("user_id", app.user_id)
    .eq("kind", "base")
    .eq("parse_status", "parsed")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data: sub } = await service
    .from("subscriptions")
    .select("plan, status, current_period_end, cancel_at_period_end")
    .eq("user_id", app.user_id)
    .maybeSingle();
  const plan = effectivePlan(sub as SubscriptionRow | null);
  const quota = armRunQuota(plan);
  const mk = meterKey(quota.window);
  const { data: reserved } = await service.rpc("try_reserve_arm_run", {
    p_user_id: app.user_id,
    p_month_key: mk,
    p_limit: quota.limit
  });
  if (!reserved) throw new Error("run_limit_reached");

  const profileAutonomy = canFullAuto(plan)
    ? ((profile!.arm_autonomy as "review_gate" | "full_auto") ?? "review_gate")
    : "review_gate";
  // --submit forces full_auto so the workflow carries through to the real
  // submit (proving Layers 1-2); otherwise park at review.
  const autonomy: "review_gate" | "full_auto" = doSubmit ? "full_auto" : "review_gate";

  const { data: newRun } = await service
    .from("application_runs")
    .insert({ application_id: appId, user_id: app.user_id, autonomy, month_key: mk })
    .select("id")
    .single();
  if (!newRun) throw new Error("run insert failed");
  console.log(
    `new run: ${newRun.id} (autonomy=${autonomy}${doSubmit ? " - WILL SUBMIT" : " for smoke"}; profile wanted ${profileAutonomy})`
  );

  const dispatch = await buildAndDispatchRun(service, {
    runId: newRun.id,
    applicationId: appId,
    userId: app.user_id,
    jobUrl: job.url,
    ats: job.ats,
    autonomy,
    jobTitle: job.title,
    jobCompany: job.company,
    jobDescription: job.description,
    profile: profile as Record<string, unknown>,
    resume: resume ?? null
  });
  console.log("dispatch:", dispatch);
  if (!dispatch.ok) throw new Error("dispatch failed");
  await service.from("applications").update({ status: "applying" }).eq("id", appId);

  // Poll to a terminal-or-review state.
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10_000));
    const { data } = await service
      .from("application_runs")
      .select("status, steps, answers, error, slot_refunded")
      .eq("id", newRun.id)
      .single();
    if (!data) continue;
    console.log(`  status: ${data.status}`);
    if (["needs_review", "failed", "submitted"].includes(data.status)) {
      const steps = (data.steps as Array<{ step: string; detail?: string }>).map(
        (s) => `${s.step}${s.detail ? `(${s.detail})` : ""}`
      );
      console.log("steps:", steps.join(" -> "));
      console.log(`answers: ${(data.answers as unknown[])?.length ?? 0}`);
      console.log("error:", data.error ?? "none");
      break;
    }
  }
  console.log("usage final:", await usage(app.user_id));
  console.log(
    doSubmit
      ? "\nDone. Full-auto submit path exercised; see the outcome in error/status above."
      : "\nDone. The run is parked at review (never submits in this smoke)."
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
