"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

export function AuthForm({ mode }: { mode: "login" | "signup" }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get("next") ?? "/dashboard";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submitPassword(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    const supabase = createSupabaseBrowserClient();

    if (mode === "signup") {
      const { error } = await supabase.auth.signUp({
        email,
        password,
        options: { emailRedirectTo: `${location.origin}/auth/callback?next=/onboarding` }
      });
      if (error) {
        setError(error.message);
      } else {
        setMessage("Check your email to confirm your account.");
      }
    } else {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) {
        setError(error.message);
      } else {
        router.push(next);
        router.refresh();
        return;
      }
    }
    setBusy(false);
  }

  async function sendMagicLink() {
    if (!email) {
      setError("Enter your email first.");
      return;
    }
    setBusy(true);
    setError(null);
    const supabase = createSupabaseBrowserClient();
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${location.origin}/auth/callback?next=${encodeURIComponent(next)}` }
    });
    if (error) setError(error.message);
    else setMessage("Magic link sent — check your email.");
    setBusy(false);
  }

  return (
    <div className="mx-auto w-full max-w-sm">
      <h1 className="mb-6 text-2xl font-bold text-white">
        {mode === "login" ? "Log in to JobArms" : "Create your JobArms account"}
      </h1>
      <form onSubmit={submitPassword} className="space-y-4">
        <input
          type="email"
          required
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full rounded-lg border border-slate-600 bg-[--color-ink-900] px-4 py-3 text-white placeholder:text-slate-500 focus:border-[--color-arm-400] focus:outline-none"
        />
        <input
          type="password"
          required
          minLength={8}
          placeholder="Password (8+ characters)"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full rounded-lg border border-slate-600 bg-[--color-ink-900] px-4 py-3 text-white placeholder:text-slate-500 focus:border-[--color-arm-400] focus:outline-none"
        />
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-lg bg-[--color-arm-500] px-4 py-3 font-semibold text-[--color-ink-950] hover:bg-[--color-arm-400] disabled:opacity-50"
        >
          {mode === "login" ? "Log in" : "Sign up"}
        </button>
      </form>
      <button
        onClick={sendMagicLink}
        disabled={busy}
        className="mt-3 w-full rounded-lg border border-slate-600 px-4 py-3 text-sm text-slate-300 hover:border-slate-400 disabled:opacity-50"
      >
        Email me a magic link instead
      </button>
      {message && <p className="mt-4 text-sm text-[--color-arm-400]">{message}</p>}
      {error && <p className="mt-4 text-sm text-red-400">{error}</p>}
      <p className="mt-6 text-sm text-slate-400">
        {mode === "login" ? (
          <>
            No account?{" "}
            <Link href="/signup" className="text-[--color-arm-400] hover:underline">
              Sign up
            </Link>
          </>
        ) : (
          <>
            Already have an account?{" "}
            <Link href="/login" className="text-[--color-arm-400] hover:underline">
              Log in
            </Link>
          </>
        )}
      </p>
    </div>
  );
}
