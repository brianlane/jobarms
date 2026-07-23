/**
 * One-shot: create the JobArms Premium product + monthly price in Stripe.
 * Idempotent by lookup key - re-running finds the existing price.
 *
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/create-stripe-prices.ts
 *
 * Paste the printed price id into .env as STRIPE_PRICE_PREMIUM_MONTHLY and
 * into Vercel env.
 */
import Stripe from "stripe";

const key = process.env.STRIPE_SECRET_KEY;
if (!key) throw new Error("STRIPE_SECRET_KEY not set (source .env first)");

const stripe = new Stripe(key);
const LOOKUP_KEY = "jobarms_premium_monthly";
const PRICE_USD_CENTS = 2000;

async function main() {
  const existing = await stripe.prices.list({ lookup_keys: [LOOKUP_KEY], limit: 1 });
  if (existing.data.length > 0) {
    console.log(`Existing price found: ${existing.data[0].id}`);
    console.log(`STRIPE_PRICE_PREMIUM_MONTHLY=${existing.data[0].id}`);
    return;
  }

  const product = await stripe.products.create({
    name: "JobArms Premium",
    description:
      "Unlimited autonomous applications, AI resume tailoring, cover letters, full-auto mode."
  });

  const price = await stripe.prices.create({
    product: product.id,
    unit_amount: PRICE_USD_CENTS,
    currency: "usd",
    recurring: { interval: "month" },
    lookup_key: LOOKUP_KEY
  });

  console.log(`Created product ${product.id}, price ${price.id}`);
  console.log(`STRIPE_PRICE_PREMIUM_MONTHLY=${price.id}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
