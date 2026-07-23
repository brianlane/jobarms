/**
 * One-shot: register the Stripe webhook endpoint for subscription lifecycle
 * events. Idempotent — finds an existing endpoint with the same URL first.
 *
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/create-stripe-webhook.ts https://<app-domain>/api/webhooks/stripe
 *
 * Prints STRIPE_WEBHOOK_SECRET on creation (Stripe only reveals it once);
 * paste it into .env and Vercel env.
 */
import Stripe from "stripe";

const key = process.env.STRIPE_SECRET_KEY;
if (!key) throw new Error("STRIPE_SECRET_KEY not set (source .env first)");

const url = process.argv[2];
if (!url?.startsWith("https://")) {
  throw new Error("usage: create-stripe-webhook.ts https://<domain>/api/webhooks/stripe");
}

const stripe = new Stripe(key);

const EVENTS: Stripe.WebhookEndpointCreateParams.EnabledEvent[] = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted"
];

async function main() {
  const existing = await stripe.webhookEndpoints.list({ limit: 100 });
  const match = existing.data.find((e) => e.url === url);
  if (match) {
    console.log(`Webhook already registered: ${match.id} -> ${match.url}`);
    console.log("(secret was shown at creation time; roll it in the dashboard if lost)");
    return;
  }

  const endpoint = await stripe.webhookEndpoints.create({
    url,
    enabled_events: EVENTS,
    description: "JobArms subscription lifecycle"
  });

  console.log(`Created webhook ${endpoint.id} -> ${endpoint.url}`);
  console.log(`STRIPE_WEBHOOK_SECRET=${endpoint.secret}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
