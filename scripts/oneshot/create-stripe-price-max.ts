/**
 * One-shot: create the Max tier price ($199/mo, 100 successful arm runs per
 * day). Reuses the existing JobArms product family; idempotent by lookup key.
 *
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/create-stripe-price-max.ts
 */
import Stripe from "stripe";

const key = process.env.STRIPE_SECRET_KEY;
if (!key) throw new Error("STRIPE_SECRET_KEY not set (source .env first)");

const stripe = new Stripe(key);
const LOOKUP_KEY = "jobarms_max_monthly";

async function main() {
  const existing = await stripe.prices.list({ lookup_keys: [LOOKUP_KEY], limit: 1 });
  if (existing.data.length > 0) {
    console.log(`STRIPE_PRICE_MAX_MONTHLY=${existing.data[0].id}`);
    return;
  }

  const product = await stripe.products.create({
    name: "JobArms Max",
    description:
      "100 autonomous applications every day (only successful submissions count), 300 tailored resumes and cover letters a month, full-auto mode at volume."
  });

  const price = await stripe.prices.create({
    product: product.id,
    unit_amount: 19900,
    currency: "usd",
    recurring: { interval: "month" },
    lookup_key: LOOKUP_KEY
  });

  console.log(`Created product ${product.id}`);
  console.log(`STRIPE_PRICE_MAX_MONTHLY=${price.id}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
