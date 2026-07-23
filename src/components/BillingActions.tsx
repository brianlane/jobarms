"use client";

import { useState } from "react";
import type { Plan } from "@/lib/plans";

export function BillingActions({ plan }: { plan: Plan }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function go(path: string, body?: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(path, {
        method: "POST",
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined
      });
      const payload = await res.json();
      if (res.ok && payload.url) {
        window.location.href = payload.url;
        return;
      }
      setError(payload.error ?? "Something went wrong.");
    } catch {
      setError("Network error.");
    }
    setBusy(false);
  }

  return (
    <div className="mt-8 flex flex-wrap gap-3">
      {plan === "free" && (
        <>
          <button
            onClick={() => go("/api/billing/checkout", { tier: "premium" })}
            disabled={busy}
            className="rounded-lg bg-arm-600 px-6 py-3 font-semibold text-white hover:bg-arm-500 disabled:opacity-50"
          >
            Upgrade to Premium
          </button>
          <button
            onClick={() => go("/api/billing/checkout", { tier: "max" })}
            disabled={busy}
            className="rounded-lg border border-arm-600 px-6 py-3 font-semibold text-arm-600 hover:bg-teal-50 disabled:opacity-50"
          >
            Go Max
          </button>
        </>
      )}
      {plan === "premium" && (
        <>
          <button
            onClick={() => go("/api/billing/checkout", { tier: "max" })}
            disabled={busy}
            className="rounded-lg bg-arm-600 px-6 py-3 font-semibold text-white hover:bg-arm-500 disabled:opacity-50"
          >
            Upgrade to Max
          </button>
          <button
            onClick={() => go("/api/billing/portal")}
            disabled={busy}
            className="rounded-lg border border-slate-300 px-6 py-3 font-semibold text-slate-700 hover:border-slate-400 disabled:opacity-50"
          >
            Manage subscription
          </button>
        </>
      )}
      {plan === "max" && (
        <button
          onClick={() => go("/api/billing/portal")}
          disabled={busy}
          className="rounded-lg border border-slate-300 px-6 py-3 font-semibold text-slate-700 hover:border-slate-400 disabled:opacity-50"
        >
          Manage subscription
        </button>
      )}
      {error && <p className="w-full text-sm text-red-500">{error}</p>}
    </div>
  );
}
