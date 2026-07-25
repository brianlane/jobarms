/**
 * Admin access control. One env var is the whole allowlist: ADMIN_EMAIL holds
 * the operator address (comma-separated for more than one). Nothing in the
 * database grants admin, so there is no row to compromise, and an unset
 * ADMIN_EMAIL disables the admin surface entirely rather than degrading open.
 *
 * ADMIN_PASSWORD is deliberately NOT read here. The admin signs in through
 * normal Supabase password auth like any other user; the password is the
 * operator's own credential for that account, and scripts/oneshot/create-admin.ts
 * is what puts it in Supabase.
 */

import { getAuthUser } from "@/lib/supabase/auth";

export interface AdminUser {
  id: string;
  email: string;
}

/** The configured allowlist, lowercased. Empty when ADMIN_EMAIL is unset. */
export function adminEmails(): string[] {
  return (process.env.ADMIN_EMAIL ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

/** Is admin access configured at all? Surfaced on the login page. */
export function adminConfigured(): boolean {
  return adminEmails().length > 0;
}

export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return adminEmails().includes(email.trim().toLowerCase());
}

/**
 * The signed-in admin, or null when nobody is signed in, the session is not on
 * the allowlist, or admin is unconfigured. Every admin page and API route
 * re-checks this server-side, so no cookie or client state can stand in for it.
 */
export async function getAdminUser(): Promise<AdminUser | null> {
  const user = await getAuthUser();
  if (!user || !isAdminEmail(user.email)) return null;
  return { id: user.id, email: user.email };
}
