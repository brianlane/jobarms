/**
 * One-shot: comp an account to Premium without Stripe (owner/test accounts).
 * Flips the user's subscriptions row to plan=premium, status=active - the
 * plan gate (src/lib/plans.ts effectivePlan) reads exactly these fields, so
 * every Premium feature unlocks: unlimited arm runs, tailoring, cover
 * letters, full-auto. No Stripe customer is created, so webhooks never
 * touch or downgrade the row.
 *
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/comp-premium.ts you@example.com          # comp
 *   npx tsx scripts/oneshot/comp-premium.ts you@example.com --revoke # back to free
 */
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY;
if (!url || !key) throw new Error("Supabase env not set (source .env first)");

const email = process.argv[2];
const revoke = process.argv.includes("--revoke");
const tierFlag = process.argv.indexOf("--tier");
const tier = tierFlag > -1 ? process.argv[tierFlag + 1] : "premium";
if (!email || !email.includes("@") || !["premium", "max"].includes(tier)) {
  throw new Error("usage: comp-premium.ts <email> [--tier premium|max] [--revoke]");
}

async function main() {
  const supabase = createClient(url!, key!, { auth: { persistSession: false } });

  // Find the auth user by email (paginate defensively).
  let userId: string | null = null;
  for (let page = 1; page <= 10 && !userId; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    userId = data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase())?.id ?? null;
    if (data.users.length < 200) break;
  }
  if (!userId) throw new Error(`No auth user found for ${email} - sign up on the site first.`);

  const patch = revoke
    ? { plan: "free", status: "none" }
    : { plan: tier, status: "active" };

  const { error } = await supabase
    .from("subscriptions")
    .upsert({ user_id: userId, ...patch }, { onConflict: "user_id" });
  if (error) throw error;

  console.log(`${revoke ? "Revoked" : "Comped"} ${email} (${userId}) -> ${patch.plan}/${patch.status}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
