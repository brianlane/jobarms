import type Stripe from "stripe";
import type { Plan } from "@/lib/plans";

/**
 * Pure mapping from a Stripe subscription object to our subscriptions row
 * shape - kept side-effect-free so the webhook logic is unit-testable.
 */
export interface SubscriptionUpdate {
  plan: Plan;
  status: string;
  stripe_subscription_id: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
}

/**
 * Which paid tier does a Stripe price represent? Prefers the exact price id
 * from env (authoritative), falls back to the lookup key convention
 * (jobarms_max_* / jobarms_premium_*). Unknown live prices default to
 * premium so a mapping gap can never over-grant Max.
 */
export function tierFromPrice(
  price: { id?: string; lookup_key?: string | null } | null | undefined
): "premium" | "max" {
  if (!price) return "premium";
  const maxPriceId = process.env.STRIPE_PRICE_MAX_MONTHLY;
  if (maxPriceId && price.id === maxPriceId) return "max";
  if (price.lookup_key?.startsWith("jobarms_max")) return "max";
  return "premium";
}

export function subscriptionUpdateFromStripe(
  sub: Pick<Stripe.Subscription, "id" | "status" | "cancel_at_period_end" | "items">
): SubscriptionUpdate {
  const item = sub.items?.data?.[0];
  const periodEnd = item?.current_period_end
    ? new Date(item.current_period_end * 1000).toISOString()
    : null;
  // Record the true tier for any subscription Stripe still considers live,
  // INCLUDING past_due, so the row keeps the real tier through dunning and
  // access restores the instant Stripe flips back to active. Whether past_due
  // actually grants access is decided solely by effectivePlan (plans.ts),
  // which excludes past_due - this write path just mirrors Stripe's state.
  const live = sub.status === "active" || sub.status === "trialing" || sub.status === "past_due";

  return {
    plan: live ? tierFromPrice(item?.price) : "free",
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
