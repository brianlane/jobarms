/**
 * The user's own LinkedIn account, connected so the arm can drive Easy Apply.
 *
 * Unlike the Workday tenant accounts the arm creates and owns (see
 * `site-accounts.ts`), these credentials are the user's REAL professional
 * identity. So they are entered by the user, guarded by explicit consent
 * (`profiles.linkedin_consent_at`), and never generated here. Storage is the
 * same vault: `site_accounts`, service-role only, deny-all RLS, with the
 * password encrypted (AES-256-GCM) before it reaches Postgres.
 *
 * One row per user, keyed by the fixed LinkedIn host, so connecting again
 * simply replaces the credentials and resets the login state.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { encryptPassword } from "@/lib/site-accounts";
import type { SiteAccountStatus } from "@/lib/site-accounts";

/** The tenant host every LinkedIn account and session is keyed by. */
export const LINKEDIN_TENANT_HOST = "www.linkedin.com";

export interface LinkedInAccount {
  email: string;
  status: SiteAccountStatus;
}

/**
 * Store (or replace) the user's LinkedIn credentials.
 *
 * Reconnecting resets `status` and clears any failure lock, because new
 * credentials deserve a fresh attempt: the previous lock was about the old
 * password, not this one.
 */
export async function setLinkedInCredentials(
  service: SupabaseClient,
  userId: string,
  email: string,
  password: string
): Promise<void> {
  await service.from("site_accounts").upsert(
    {
      user_id: userId,
      tenant_host: LINKEDIN_TENANT_HOST,
      ats: "linkedin",
      email,
      password_encrypted: encryptPassword(password),
      status: "pending_verification",
      verified_at: null,
      login_failures: 0
    },
    { onConflict: "user_id,tenant_host" }
  );
}

/** The connected account's public shape (email + login state), or null. */
export async function getLinkedInAccount(
  service: SupabaseClient,
  userId: string
): Promise<LinkedInAccount | null> {
  const { data } = await service
    .from("site_accounts")
    .select("email, status")
    .eq("user_id", userId)
    .eq("tenant_host", LINKEDIN_TENANT_HOST)
    .maybeSingle();
  if (!data) return null;
  return {
    email: (data as { email: string }).email,
    status: (data as { status: SiteAccountStatus }).status
  };
}

/** Remove the connected account. The caller also clears consent + the session. */
export async function deleteLinkedInAccount(
  service: SupabaseClient,
  userId: string
): Promise<void> {
  await service
    .from("site_accounts")
    .delete()
    .eq("user_id", userId)
    .eq("tenant_host", LINKEDIN_TENANT_HOST);
}
