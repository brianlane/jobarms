// Strip live credentials from the unit-test process so no test can reach a
// real external service. Unit tests must be hermetic; anything that needs a
// credential must mock at the transport seam.
const LIVE_ENV_KEYS = [
  "SUPABASE_DB_PASSWORD",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_SECRET",
  "SUPABASE_SECRET_KEY",
  "SUPABASE_ACCESS_TOKEN",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "STRIPE_PUBLISHABLE_KEY",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "GEMINI_API_KEY",
  "VERCEL_TOKEN",
  "RESEND_API_KEY",
  "ARM_WORKER_SHARED_SECRET",
  "INTERNAL_CRON_SECRET"
];

for (const key of LIVE_ENV_KEYS) {
  delete process.env[key];
}
