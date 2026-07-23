/**
 * One-shot: wire the Vercel project for production.
 *   1. Register the Stripe webhook at https://jobarms.com/api/webhooks/stripe
 *      (idempotent; prints STRIPE_WEBHOOK_SECRET on first creation).
 *   2. Upsert every runtime env var to Vercel (production + preview).
 *   3. Attach jobarms.com + www.jobarms.com to the project.
 *
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/setup-vercel.ts
 */
import Stripe from "stripe";

const PROD_URL = "https://jobarms.com";

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} not set (source .env first)`);
  return v;
}

const VERCEL_TOKEN = need("VERCEL_TOKEN");
const PROJECT_ID = need("VERCEL_PROJECT_ID");
const TEAM_ID = need("VERCEL_ORG_ID");

async function vercel(path: string, init?: RequestInit): Promise<Response> {
  const sep = path.includes("?") ? "&" : "?";
  return fetch(`https://api.vercel.com${path}${sep}teamId=${TEAM_ID}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${VERCEL_TOKEN}`,
      "content-type": "application/json",
      ...(init?.headers ?? {})
    }
  });
}

async function ensureStripeWebhook(): Promise<string | null> {
  const stripe = new Stripe(need("STRIPE_SECRET_KEY"));
  const url = `${PROD_URL}/api/webhooks/stripe`;
  const existing = await stripe.webhookEndpoints.list({ limit: 100 });
  const match = existing.data.find((e) => e.url === url);
  if (match) {
    console.log(`Stripe webhook already registered: ${match.id}`);
    return process.env.STRIPE_WEBHOOK_SECRET ?? null;
  }
  const endpoint = await stripe.webhookEndpoints.create({
    url,
    enabled_events: [
      "checkout.session.completed",
      "customer.subscription.created",
      "customer.subscription.updated",
      "customer.subscription.deleted"
    ],
    description: "JobArms subscription lifecycle"
  });
  console.log(`Created Stripe webhook ${endpoint.id}`);
  console.log(`STRIPE_WEBHOOK_SECRET=${endpoint.secret}`);
  return endpoint.secret ?? null;
}

async function upsertEnv(key: string, value: string, targets = ["production", "preview"]) {
  const res = await vercel(`/v10/projects/${PROJECT_ID}/env?upsert=true`, {
    method: "POST",
    body: JSON.stringify([{ key, value, type: "encrypted", target: targets }])
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`env upsert ${key} failed: ${res.status} ${body.slice(0, 200)}`);
  }
  console.log(`env ✓ ${key}`);
}

async function addDomain(name: string) {
  const res = await vercel(`/v10/projects/${PROJECT_ID}/domains`, {
    method: "POST",
    body: JSON.stringify({ name })
  });
  if (res.ok) {
    console.log(`domain ✓ ${name}`);
  } else {
    const body = await res.text();
    if (body.includes("already") || res.status === 409) {
      console.log(`domain ✓ ${name} (already attached)`);
    } else {
      console.warn(`domain ✗ ${name}: ${res.status} ${body.slice(0, 200)}`);
    }
  }
}

async function main() {
  const webhookSecret = await ensureStripeWebhook();

  const passthrough = [
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    "SUPABASE_SECRET_KEY",
    "GEMINI_API_KEY",
    "STRIPE_SECRET_KEY",
    "STRIPE_PUBLISHABLE_KEY",
    "STRIPE_PRICE_PREMIUM_MONTHLY",
    "INTERNAL_CRON_SECRET",
    "ARM_WORKER_SHARED_SECRET"
  ];
  for (const key of passthrough) {
    await upsertEnv(key, need(key));
  }
  await upsertEnv("NEXT_PUBLIC_APP_URL", PROD_URL, ["production"]);
  if (webhookSecret) {
    await upsertEnv("STRIPE_WEBHOOK_SECRET", webhookSecret);
  } else {
    console.warn("STRIPE_WEBHOOK_SECRET unknown - set it in Vercel manually if the webhook predates this run.");
  }

  await addDomain("jobarms.com");
  await addDomain("www.jobarms.com");

  console.log(
    "\nDNS (Cloudflare, zone jobarms.com):\n" +
      "  A     @    76.76.21.21        (DNS only / grey cloud)\n" +
      "  CNAME www  cname.vercel-dns.com (DNS only / grey cloud)\n" +
      "Vercel will then issue certificates automatically."
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
