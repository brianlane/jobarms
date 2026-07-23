import type Stripe from "stripe";
import type { Plan } from "@/lib/plans";

/**
 * Pure mapping from a Stripe subscription object to our subscriptions row
 * shape — kept side-effect-free so the webhook logic is unit-testable.
 */
export interface SubscriptionUpdate {
  plan: Plan;
  status: string;
  stripe_subscription_id: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
}

export function subscriptionUpdateFromStripe(
  sub: Pick<Stripe.Subscription, "id" | "status" | "cancel_at_period_end" | "items">
): SubscriptionUpdate {
  const item = sub.items?.data?.[0];
  const periodEnd = item?.current_period_end
    ? new Date(item.current_period_end * 1000).toISOString()
    : null;
  const live = sub.status === "active" || sub.status === "trialing" || sub.status === "past_due";

  return {
    plan: live ? "premium" : "free",
    status: sub.status,
    stripe_subscription_id: sub.id,
    current_period_end: periodEnd,
    cancel_at_period_end: Boolean(sub.cancel_at_period_end)
  };
}

/** Row state after a subscription is fully gone. */
export const SUBSCRIPTION_CLEARED: SubscriptionUpdate = {
  plan: "free",
  status: "canceled",
  stripe_subscription_id: null,
  current_period_end: null,
  cancel_at_period_end: false
};
