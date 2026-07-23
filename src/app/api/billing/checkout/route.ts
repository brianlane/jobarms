import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceClient } from "@/lib/supabase/service";
import { stripeClient } from "@/lib/stripe";
import { appUrl, requireEnv } from "@/lib/env";

const bodySchema = z.object({ tier: z.enum(["premium", "max"]).default("premium") });

/** Start a Stripe Checkout session for a paid tier (premium or max). */
export async function POST(request: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  const priceEnv =
    parsed.data.tier === "max" ? "STRIPE_PRICE_MAX_MONTHLY" : "STRIPE_PRICE_PREMIUM_MONTHLY";

  const stripe = stripeClient();
  const service = createSupabaseServiceClient();

  // Reuse the Stripe customer if we have one; create + persist otherwise.
  const { data: subRow } = await service
    .from("subscriptions")
    .select("stripe_customer_id")
    .eq("user_id", user.id)
    .maybeSingle();

  let customerId = subRow?.stripe_customer_id as string | null;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: user.email ?? undefined,
      metadata: { user_id: user.id }
    });
    customerId = customer.id;
    await service
      .from("subscriptions")
      .upsert({ user_id: user.id, stripe_customer_id: customerId }, { onConflict: "user_id" });
  }

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    client_reference_id: user.id,
    line_items: [{ price: requireEnv(priceEnv), quantity: 1 }],
    allow_promotion_codes: true,
    success_url: `${appUrl()}/dashboard/billing?success=1`,
    cancel_url: `${appUrl()}/dashboard/billing?canceled=1`
  });

  return NextResponse.json({ url: session.url });
}
