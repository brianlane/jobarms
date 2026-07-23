"use client";

import { useState } from "react";
import type { Plan } from "@/lib/plans";

export function BillingActions({ plan }: { plan: Plan }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function go(path: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(path, { method: "POST" });
      const body = await res.json();
      if (res.ok && body.url) {
        window.location.href = body.url;
        return;
      }
      setError(body.error ?? "Something went wrong.");
    } catch {
      setError("Network error.");
    }
    setBusy(false);
  }

  return (
    <div className="mt-8">
      {plan === "free" ? (
        <button
          onClick={() => go("/api/billing/checkout")}
          disabled={busy}
          className="rounded-lg bg-arm-600 px-6 py-3 font-semibold text-white hover:bg-arm-500 disabled:opacity-50"
        >
          Upgrade to Premium
        </button>
      ) : (
        <button
          onClick={() => go("/api/billing/portal")}
          disabled={busy}
          className="rounded-lg border border-slate-300 px-6 py-3 font-semibold text-slate-700 hover:border-slate-400 disabled:opacity-50"
        >
          Manage subscription
        </button>
      )}
      {error && <p className="mt-3 text-sm text-red-500">{error}</p>}
    </div>
  );
}
