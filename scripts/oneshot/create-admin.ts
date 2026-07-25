/**
 * One-shot: create (or reset the password of) the admin's Supabase account.
 *
 * Admin access is an env allowlist: ADMIN_EMAIL decides who the console lets
 * in, and the account itself is an ordinary Supabase user. This script just
 * makes sure that user exists with a confirmed email and the password from
 * ADMIN_PASSWORD, so /admin/login works.
 *
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/create-admin.ts
 *
 * Idempotent: run it again after rotating ADMIN_PASSWORD.
 */
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY;
const email = process.env.ADMIN_EMAIL?.split(",")[0]?.trim();
const password = process.env.ADMIN_PASSWORD;

if (!url || !key) throw new Error("Supabase env not set (source .env first)");
if (!email || !email.includes("@")) throw new Error("ADMIN_EMAIL is not set to an address");
if (!password || password.length < 12) {
  throw new Error("ADMIN_PASSWORD must be set and at least 12 characters");
}

async function main() {
  const supabase = createClient(url!, key!, { auth: { persistSession: false } });

  let userId: string | null = null;
  for (let page = 1; page <= 10 && !userId; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    userId = data.users.find((u) => u.email?.toLowerCase() === email!.toLowerCase())?.id ?? null;
    if (data.users.length < 200) break;
  }

  if (userId) {
    const { error } = await supabase.auth.admin.updateUserById(userId, {
      password,
      email_confirm: true
    });
    if (error) throw error;
    console.log(`Reset the password for existing admin ${email} (${userId})`);
  } else {
    const { data, error } = await supabase.auth.admin.createUser({
      email: email!,
      password,
      email_confirm: true
    });
    if (error) throw error;
    console.log(`Created admin ${email} (${data.user?.id})`);
  }

  console.log("Sign in at /admin/login. ADMIN_EMAIL must carry this address in every environment.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
