import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceClient } from "@/lib/supabase/service";
import { getLinkedInCredentials } from "@/lib/linkedin";
import {
  armRunQuota,
  canFullAuto,
  effectivePlan,
  MAX_BATCH_APPLICATIONS,
  meterKey,
  type SubscriptionRow
} from "@/lib/plans";
import { buildAndDispatchBatch, createBatch, type BatchRow } from "@/lib/batch";

export const maxDuration = 60;

const bodySchema = z.object({
  keywords: z.string().trim().min(2).max(200),
  location: z.string().trim().max(200).default(""),
  remote: z.boolean().default(false),
  count: z.number().int().min(1).max(MAX_BATCH_APPLICATIONS)
});

/**
 * Start a search-driven LinkedIn Easy Apply batch: the arm searches LinkedIn
 * with the user's own account and applies to up to `count` matches, each one
 * metered as an ordinary arm run.
 *
 * Slots are bulk-reserved up front and the batch is capped at whatever metering
 * granted, so a user near their cap applies to fewer jobs instead of being
 * refused outright. Batches submit without a review gate, so they are paid-only.
 */
export async function POST(request: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });

  const service = createSupabaseServiceClient();

  const { data: sub } = await service
    .from("subscriptions")
    .select("plan, status, current_period_end, cancel_at_period_end")
    .eq("user_id", user.id)
    .maybeSingle();
  const plan = effectivePlan(sub as SubscriptionRow | null);
  if (!canFullAuto(plan)) {
    return NextResponse.json(
      {
        error: "upgrade_required",
        hint: "Batch apply submits applications without a review stop, which is a paid feature. Upgrade to run batches."
      },
      { status: 402 }
    );
  }

  const creds = await getLinkedInCredentials(service, user.id);
  if (!creds) {
    return NextResponse.json(
      {
        error: "linkedin_not_connected",
        hint: "Connect your LinkedIn account in Settings before starting a batch."
      },
      { status: 409 }
    );
  }
  if (creds.status === "locked") {
    return NextResponse.json(
      {
        error: "ats_account_locked",
        hint: "LinkedIn kept rejecting the sign-in, so it is locked. Reconnect your account in Settings to try again."
      },
      { status: 422 }
    );
  }

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

  // --- bulk-reserve the slots this batch may spend ---
  const quota = armRunQuota(plan);
  const mk = meterKey(quota.window);
  const { data: granted } = await service.rpc("try_reserve_arm_runs", {
    p_user_id: user.id,
    p_month_key: mk,
    p_limit: quota.limit,
    p_count: parsed.data.count
  });
  const reserved = typeof granted === "number" ? granted : 0;
  if (reserved <= 0) {
    const hint =
      plan === "premium"
        ? "You've hit this month's 200-run cap. Upgrade to Max for 100 runs every day, or wait for the monthly reset."
        : "You've used today's 100 runs. A fresh 100 unlocks tomorrow.";
    return NextResponse.json({ error: "run_limit_reached", hint }, { status: 402 });
  }

  const batchId = await createBatch(service, user.id, {
    keywords: parsed.data.keywords,
    location: parsed.data.location,
    remote: parsed.data.remote,
    requested: parsed.data.count,
    reserved,
    monthKey: mk
  });
  if (!batchId) {
    await service.rpc("release_arm_runs", {
      p_user_id: user.id,
      p_month_key: mk,
      p_count: reserved
    });
    return NextResponse.json({ error: "batch_insert_failed" }, { status: 500 });
  }

  const dispatch = await buildAndDispatchBatch(service, {
    batchId,
    userId: user.id,
    keywords: parsed.data.keywords,
    location: parsed.data.location,
    remote: parsed.data.remote,
    reserved,
    monthKey: mk,
    profile: profile as Record<string, unknown>,
    resume,
    account: { email: creds.email, password: creds.password }
  });
  if (!dispatch.ok) {
    await service
      .from("apply_batches")
      .update({ status: "failed", error: dispatch.reason })
      .eq("id", batchId);
    await service.rpc("release_arm_runs", {
      p_user_id: user.id,
      p_month_key: mk,
      p_count: reserved
    });
    const hint =
      dispatch.reason === "arm_unconfigured" || dispatch.reason === "arm_offline"
        ? "The arm isn't available right now. Nothing was charged; try again shortly."
        : "The batch couldn't start. Nothing was charged; try again shortly.";
    return NextResponse.json({ error: dispatch.reason, hint }, { status: 503 });
  }

  return NextResponse.json({ batch_id: batchId, reserved }, { status: 202 });
}

/** The user's recent batches, for the batch page (read under their own RLS). */
export async function GET() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { data } = await supabase
    .from("apply_batches")
    .select(
      "id, status, keywords, location, remote, requested, reserved, processed, applied, failed, error, created_at"
    )
    .order("created_at", { ascending: false })
    .limit(20);

  return NextResponse.json({ batches: (data ?? []) as BatchRow[] });
}
