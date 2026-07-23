/**
 * One-shot: seed the tracked-company list for the ingestion worker.
 * Idempotent (upsert on ats+board_token). Edit the list and re-run any time.
 *
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/seed-companies.ts
 */
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY;
if (!url || !key) throw new Error("Supabase env not set (source .env first)");

// Starter list: well-known boards on each supported ATS. Board tokens are the
// public slugs from each company's careers URL.
const COMPANIES: Array<{ name: string; ats: string; board_token: string }> = [
  { name: "Stripe", ats: "greenhouse", board_token: "stripe" },
  { name: "Cloudflare", ats: "greenhouse", board_token: "cloudflare" },
  { name: "Figma", ats: "greenhouse", board_token: "figma" },
  { name: "Airbnb", ats: "greenhouse", board_token: "airbnb" },
  { name: "Databricks", ats: "greenhouse", board_token: "databricks" },
  { name: "Plaid", ats: "lever", board_token: "plaid" },
  { name: "Palantir", ats: "lever", board_token: "palantir" },
  { name: "Ramp", ats: "ashby", board_token: "ramp" },
  { name: "Linear", ats: "ashby", board_token: "linear" },
  { name: "Notion", ats: "ashby", board_token: "notion" }
];

async function main() {
  const supabase = createClient(url!, key!, { auth: { persistSession: false } });
  const { error } = await supabase
    .from("companies")
    .upsert(COMPANIES, { onConflict: "ats,board_token" });
  if (error) throw error;
  console.log(`Seeded ${COMPANIES.length} companies.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
