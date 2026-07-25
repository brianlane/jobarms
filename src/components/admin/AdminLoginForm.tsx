"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { safeNextPath } from "@/lib/redirect";

/**
 * Admin sign-in. There is no separate credential store: the admin is an
 * ordinary Supabase account whose email is on the ADMIN_EMAIL allowlist, so
 * this is a password sign-in plus a bounce for anyone who is not on the list.
 *
 * A signed-in non-admin arriving here is signed OUT rather than left in a
 * half-state where the session looks valid but every admin page rejects it.
 */
export function AdminLoginForm({
  forceSignOut,
  adminConfigured
}: {
  forceSignOut: boolean;
  adminConfigured: boolean;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = safeNextPath(searchParams.get("next"), "/admin/dashboard");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!forceSignOut) return;
    const signOut = async () => {
      try {
        await createSupabaseBrowserClient().auth.signOut();
      } catch {
        // No session to clear, or the network blipped. The message below is
        // what matters; a failed sign-out cannot grant access either way.
      }
      setError("That account is not authorized for admin access.");
    };
    void signOut();
  }, [forceSignOut]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const supabase = createSupabaseBrowserClient();
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
    if (signInError) {
      setError(signInError.message);
      setBusy(false);
      return;
    }
    router.push(next);
    router.refresh();
  }

  return (
    <div className="mx-auto w-full max-w-sm">
      <h1 className="mb-2 text-2xl font-bold text-white">Admin sign in</h1>
      <p className="mb-6 font-mono text-[10px] uppercase tracking-[0.2em] text-slate-500">
        operator access only
      </p>

      {!adminConfigured && (
        <p className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-300">
          ADMIN_EMAIL is not configured, so admin access is disabled.
        </p>
      )}

      <form onSubmit={submit} className="space-y-4">
        <input
          type="email"
          required
          autoComplete="off"
          placeholder="admin@jobarms.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full rounded-lg border border-slate-600 bg-ink-900 px-4 py-3 text-white placeholder:text-slate-500 focus:border-arm-400 focus:outline-none"
        />
        <input
          type="password"
          required
          autoComplete="off"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full rounded-lg border border-slate-600 bg-ink-900 px-4 py-3 text-white placeholder:text-slate-500 focus:border-arm-400 focus:outline-none"
        />
        <button
          type="submit"
          disabled={busy || !adminConfigured}
          className="w-full rounded-lg bg-arm-500 px-4 py-3 font-semibold text-ink-950 hover:bg-arm-400 disabled:opacity-50"
        >
          Sign in
        </button>
      </form>

      {error && <p className="mt-4 text-sm text-red-400">{error}</p>}
    </div>
  );
}
