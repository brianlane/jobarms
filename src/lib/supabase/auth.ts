import { cache } from "react";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export interface AuthUser {
  id: string;
  email: string;
}

/**
 * Request-deduped auth check for server components.
 *
 * Uses getClaims(), which verifies the session JWT against the project's
 * public signing key LOCALLY (one cached JWKS fetch per runtime) instead of
 * getUser()'s network round trip to Supabase Auth on every page load -
 * layout + page used to each pay that round trip sequentially, which is
 * what made dashboard navigation feel slow. React cache() collapses the
 * layout's and page's calls into one per request.
 */
export const getAuthUser = cache(async (): Promise<AuthUser | null> => {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getClaims();
  if (error || !data?.claims?.sub) return null;
  return {
    id: data.claims.sub,
    email: (data.claims.email as string | undefined) ?? ""
  };
});
