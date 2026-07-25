import { NextResponse } from "next/server";
import { getAdminUser } from "@/lib/admin/guard";
import { logAdminAction } from "@/lib/admin/audit";
import { createSupabaseServiceClient } from "@/lib/supabase/service";

const COMPABLE = new Set(["free", "premium", "max"]);

/**
 * Comp or revoke a plan without Stripe: the route version of
 * scripts/oneshot/comp-premium.ts, for owner and test accounts.
 *
 * Writes `plan` and `status` only, which is exactly what `effectivePlan` reads,
 * so every paid feature follows. No Stripe customer is involved, so webhooks
 * never contest the row.
 *
 * Refuses on an account with a live Stripe subscription: overwriting that row
 * would desynchronize us from Stripe, and the next webhook would silently undo
 * the change anyway. Cancel in Stripe first.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const admin = await getAdminUser();
  if (!admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { id } = await ctx.params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const plan = (body as { plan?: unknown })?.plan;
  if (typeof plan !== "string" || !COMPABLE.has(plan)) {
    return NextResponse.json({ error: "invalid_plan" }, { status: 400 });
  }

  const supabase = createSupabaseServiceClient();
  const { data: existing } = await supabase
    .from("subscriptions")
    .select("user_id, stripe_subscription_id, plan, status")
    .eq("user_id", id)
    .maybeSingle();

  if (existing?.stripe_subscription_id) {
    return NextResponse.json(
      {
        error: "stripe_managed",
        hint: "This account has a live Stripe subscription. Cancel it in Stripe first."
      },
      { status: 409 }
    );
  }

  const patch =
    plan === "free" ? { plan: "free", status: "none" } : { plan, status: "active" };
  const { error } = await supabase
    .from("subscriptions")
    .upsert({ user_id: id, ...patch }, { onConflict: "user_id" });
  if (error) return NextResponse.json({ error: "write_failed" }, { status: 500 });

  await logAdminAction({
    adminEmail: admin.email,
    action: plan === "free" ? "revoke_plan" : "comp_plan",
    targetUserId: id,
    detail: { plan, previousPlan: existing?.plan ?? "free" }
  });

  return NextResponse.json({ ok: true, plan: patch.plan, status: patch.status });
}
