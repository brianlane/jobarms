import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { requireEnv } from "@/lib/env";

/**
 * Service-role Supabase client — bypasses RLS. Server-only: import from API
 * routes / server actions after the caller's own auth check. NEVER expose to
 * the browser.
 */
export function createSupabaseServiceClient(): SupabaseClient {
  return createClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("SUPABASE_SECRET_KEY"),
    {
      auth: { persistSession: false, autoRefreshToken: false }
    }
  );
}
