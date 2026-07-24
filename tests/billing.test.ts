import { describe, expect, it } from "vitest";
import { subscriptionUpdateFromStripe, SUBSCRIPTION_CLEARED, tierFromPrice } from "@/lib/billing";
import type Stripe from "stripe";

function fakeSub(overrides: {
  status: Stripe.Subscription.Status;
  cancel_at_period_end?: boolean;
  current_period_end?: number | null;
  lookup_key?: string;
}) {
  return {
    id: "sub_123",
    status: overrides.status,
    cancel_at_period_end: overrides.cancel_at_period_end ?? false,
    items: {
      data: [
        {
          current_period_end: overrides.current_period_end ?? 1_790_000_000,
          price: { id: "price_abc", lookup_key: overrides.lookup_key ?? "jobarms_premium_monthly_19" }
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

  it("trialing and past_due record the real tier (access is gated by effectivePlan)", () => {
    // The row mirrors Stripe: past_due keeps its tier so access restores the
    // instant Stripe flips back to active. effectivePlan (plans.ts) is what
    // actually denies paid features while past_due.
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

  it("a missing/zero current_period_end yields a null period end", () => {
    const update = subscriptionUpdateFromStripe(
      fakeSub({ status: "active", current_period_end: 0 })
    );
    expect(update.current_period_end).toBeNull();
  });

  it("cleared state is free with no subscription", () => {
    expect(SUBSCRIPTION_CLEARED.plan).toBe("free");
    expect(SUBSCRIPTION_CLEARED.stripe_subscription_id).toBeNull();
  });
});

describe("tierFromPrice", () => {
  it("maps by env price id when set", () => {
    process.env.STRIPE_PRICE_MAX_MONTHLY = "price_max_env";
    expect(tierFromPrice({ id: "price_max_env", lookup_key: null })).toBe("max");
    expect(tierFromPrice({ id: "price_other", lookup_key: null })).toBe("premium");
    delete process.env.STRIPE_PRICE_MAX_MONTHLY;
  });

  it("falls back to the lookup-key convention", () => {
    expect(tierFromPrice({ id: "x", lookup_key: "jobarms_max_monthly" })).toBe("max");
    expect(tierFromPrice({ id: "x", lookup_key: "jobarms_premium_monthly_19" })).toBe("premium");
  });

  it("unknown/missing price defaults to premium (never over-grants)", () => {
    expect(tierFromPrice(undefined)).toBe("premium");
    expect(tierFromPrice({ id: "x", lookup_key: null })).toBe("premium");
  });

  it("an active max subscription maps to the max plan", () => {
    const update = subscriptionUpdateFromStripe(
      fakeSub({ status: "active", lookup_key: "jobarms_max_monthly" })
    );
    expect(update.plan).toBe("max");
  });
});
