import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { stripeClient } from "@/lib/stripe";
import { createSupabaseServiceClient } from "@/lib/supabase/service";
import { subscriptionUpdateFromStripe, SUBSCRIPTION_CLEARED } from "@/lib/billing";
import { requireEnv } from "@/lib/env";

/**
 * Stripe webhook: keeps the subscriptions table in lockstep with Stripe.
 * Signature-verified; unhandled event types are acknowledged and ignored.
 */
export async function POST(request: Request) {
  const stripe = stripeClient();
  const payload = await request.text();
  const signature = request.headers.get("stripe-signature") ?? "";

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(
      payload,
      signature,
      requireEnv("STRIPE_WEBHOOK_SECRET")
    );
  } catch {
    return NextResponse.json({ error: "bad_signature" }, { status: 400 });
  }

  const service = createSupabaseServiceClient();

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;
      const userId = session.client_reference_id;
      const customerId = typeof session.customer === "string" ? session.customer : null;
      const subscriptionId =
        typeof session.subscription === "string" ? session.subscription : null;
      if (userId && subscriptionId) {
        const sub = await stripe.subscriptions.retrieve(subscriptionId);
        await service
          .from("subscriptions")
          .upsert(
            {
              user_id: userId,
              stripe_customer_id: customerId,
              ...subscriptionUpdateFromStripe(sub)
            },
            { onConflict: "user_id" }
          );
      }
      break;
    }

    case "customer.subscription.updated":
    case "customer.subscription.created": {
      const sub = event.data.object;
      const customerId = typeof sub.customer === "string" ? sub.customer : null;
      if (customerId) {
        await service
          .from("subscriptions")
          .update(subscriptionUpdateFromStripe(sub))
          .eq("stripe_customer_id", customerId);
      }
      break;
    }

    case "customer.subscription.deleted": {
      const sub = event.data.object;
      const customerId = typeof sub.customer === "string" ? sub.customer : null;
      if (customerId) {
        await service
          .from("subscriptions")
          .update(SUBSCRIPTION_CLEARED)
          .eq("stripe_customer_id", customerId);
      }
      break;
    }

    default:
      break;
  }

  return NextResponse.json({ received: true });
}
