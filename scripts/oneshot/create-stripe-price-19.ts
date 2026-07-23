/**
 * One-shot: move Premium to $19/mo (price values ending in 9, per owner
 * preference). Creates a new price on the existing product (prices are
 * immutable in Stripe), idempotent by lookup key.
 *
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/create-stripe-price-19.ts
 */
import Stripe from "stripe";

const key = process.env.STRIPE_SECRET_KEY;
if (!key) throw new Error("STRIPE_SECRET_KEY not set (source .env first)");

const stripe = new Stripe(key);
const LOOKUP_KEY = "jobarms_premium_monthly_19";

async function main() {
  const existing = await stripe.prices.list({ lookup_keys: [LOOKUP_KEY], limit: 1 });
  if (existing.data.length > 0) {
    console.log(`STRIPE_PRICE_PREMIUM_MONTHLY=${existing.data[0].id}`);
    return;
  }

  const old = await stripe.prices.list({ lookup_keys: ["jobarms_premium_monthly"], limit: 1 });
  const productId = old.data[0]?.product;
  if (!productId || typeof productId !== "string") {
    throw new Error("original premium product not found");
  }

  const price = await stripe.prices.create({
    product: productId,
    unit_amount: 1900,
    currency: "usd",
    recurring: { interval: "month" },
    lookup_key: LOOKUP_KEY
  });

  console.log(`Created $19 price on ${productId}`);
  console.log(`STRIPE_PRICE_PREMIUM_MONTHLY=${price.id}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
