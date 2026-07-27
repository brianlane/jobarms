import type { SupabaseClient, User } from "@supabase/supabase-js";

/**
 * Find an auth user by email, walking every page.
 *
 * `listUsers` defaults to one page, so the obvious one-liner only searches the
 * first few hundred accounts and reports everyone created after them as
 * missing. That reads identically to a typo in the email, and in the smoke
 * script it caused a duplicate `createUser` for a user that already existed.
 * Both debug scripts share this so the mistake has one place to live.
 */
const PAGE_SIZE = 200;

export async function findAuthUserByEmail(
  supabase: SupabaseClient,
  email: string
): Promise<User | null> {
  const wanted = email.trim().toLowerCase();
  for (let page = 1; ; page += 1) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: PAGE_SIZE });
    // A failed page is not an empty page. Swallowing the error would report
    // an existing account as missing, and the smoke script would then try to
    // create it again and fail on the duplicate email.
    if (error) {
      throw new Error(`listUsers failed on page ${page}: ${error.message}`);
    }
    const users = data?.users ?? [];
    const match = users.find((u) => u.email?.toLowerCase() === wanted);
    if (match) return match;
    // A short page is the last page.
    if (users.length < PAGE_SIZE) return null;
  }
}
