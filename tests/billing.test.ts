import { describe, expect, it } from "vitest";
import { subscriptionUpdateFromStripe, SUBSCRIPTION_CLEARED } from "@/lib/billing";
import type Stripe from "stripe";

function fakeSub(overrides: {
  status: Stripe.Subscription.Status;
  cancel_at_period_end?: boolean;
  current_period_end?: number | null;
}) {
  return {
    id: "sub_123",
    status: overrides.status,
    cancel_at_period_end: overrides.cancel_at_period_end ?? false,
    items: {
      data: [
        {
          current_period_end: overrides.current_period_end ?? 1_790_000_000
        }
      ]
    }
  } as unknown as Stripe.Subscription;
}

describe("subscriptionUpdateFromStripe", () => {
  it("active subscription maps to premium with period end", () => {
    const update = subscriptionUpdateFromStripe(fakeSub({ status: "active" }));
    expect(update.plan).toBe("premium");
    expect(update.status).toBe("active");
    expect(update.stripe_subscription_id).toBe("sub_123");
    expect(update.current_period_end).toBe(new Date(1_790_000_000 * 1000).toISOString());
  });

  it("trialing and past_due keep premium access", () => {
    expect(subscriptionUpdateFromStripe(fakeSub({ status: "trialing" })).plan).toBe("premium");
    expect(subscriptionUpdateFromStripe(fakeSub({ status: "past_due" })).plan).toBe("premium");
  });

  it("canceled/unpaid map to free", () => {
    expect(subscriptionUpdateFromStripe(fakeSub({ status: "canceled" })).plan).toBe("free");
    expect(subscriptionUpdateFromStripe(fakeSub({ status: "unpaid" })).plan).toBe("free");
  });

  it("carries cancel_at_period_end through", () => {
    expect(
      subscriptionUpdateFromStripe(fakeSub({ status: "active", cancel_at_period_end: true }))
        .cancel_at_period_end
    ).toBe(true);
  });

  it("cleared state is free with no subscription", () => {
    expect(SUBSCRIPTION_CLEARED.plan).toBe("free");
    expect(SUBSCRIPTION_CLEARED.stripe_subscription_id).toBeNull();
  });
});
