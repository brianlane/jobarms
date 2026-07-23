import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceClient } from "@/lib/supabase/service";
import { stripeClient } from "@/lib/stripe";
import { appUrl } from "@/lib/env";

/** Open the Stripe customer portal (manage/cancel subscription). */
export async function POST() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const service = createSupabaseServiceClient();
  const { data: subRow } = await service
    .from("subscriptions")
    .select("stripe_customer_id")
    .eq("user_id", user.id)
    .maybeSingle();

  if (!subRow?.stripe_customer_id) {
    return NextResponse.json({ error: "no_customer" }, { status: 400 });
  }

  const session = await stripeClient().billingPortal.sessions.create({
    customer: subRow.stripe_customer_id,
    return_url: `${appUrl()}/dashboard/billing`
  });

  return NextResponse.json({ url: session.url });
}
