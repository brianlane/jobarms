"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

interface BatchRow {
  id: string;
  status: string;
  keywords: string;
  location: string;
  remote: boolean;
  requested: number;
  reserved: number;
  processed: number;
  applied: number;
  failed: number;
  error: string | null;
  created_at: string;
}

const BATCH_STATUS_COPY: Record<string, { label: string; tone: "working" | "action" | "good" | "bad" | "muted" }> = {
  queued: { label: "Getting started...", tone: "working" },
  searching: { label: "Searching LinkedIn...", tone: "working" },
  running: { label: "Applying...", tone: "working" },
  needs_login_code: { label: "Enter your LinkedIn code", tone: "action" },
  completed: { label: "Batch finished", tone: "good" },
  failed: { label: "This batch hit a problem", tone: "bad" },
  canceled: { label: "Batch canceled", tone: "muted" }
};

/** States where the batch is still doing (or waiting for) something. */
const LIVE = new Set(["queued", "searching", "running", "needs_login_code"]);

export function BatchPanel({
  linkedInConnected,
  paid
}: {
  linkedInConnected: boolean;
  paid: boolean;
}) {
  const [keywords, setKeywords] = useState("");
  const [location, setLocation] = useState("");
  const [remote, setRemote] = useState(false);
  const [count, setCount] = useState(10);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [batches, setBatches] = useState<BatchRow[]>([]);
  const [codes, setCodes] = useState<Record<string, string>>({});
  // Bumping this refetches the list (initial load, after actions, and polling).
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/batches")
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (!cancelled && body) setBatches((body.batches ?? []) as BatchRow[]);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [tick]);

  // Poll while anything is live, so progress and the PIN banner show up.
  useEffect(() => {
    if (!batches.some((b) => LIVE.has(b.status))) return;
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [batches, refresh]);

  async function act(path: string, body?: unknown): Promise<boolean> {
    setBusy(true);
    setError(null);
    const res = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined
    }).catch(() => null);
    setBusy(false);
    if (res?.ok) {
      refresh();
      return true;
    }
    const payload = res ? await res.json().catch(() => null) : null;
    setError(payload?.hint ?? "That didn't work. Try again shortly.");
    return false;
  }

  async function start() {
    const ok = await act("/api/batches", { keywords, location, remote, count });
    if (ok) setKeywords("");
  }

  const ready = paid && linkedInConnected;

  return (
    <div>
      {!paid && (
        <div className="rounded-xl border border-slate-200 bg-white p-6">
          <p className="text-sm text-slate-600">
            Batch apply submits applications without a review stop, which is a paid
            feature.{" "}
            <Link href="/dashboard/billing" className="font-semibold text-arm-600 hover:underline">
              Upgrade to run batches.
            </Link>
          </p>
        </div>
      )}
      {paid && !linkedInConnected && (
        <div className="rounded-xl border border-slate-200 bg-white p-6">
          <p className="text-sm text-slate-600">
            Batches run on LinkedIn with your own account.{" "}
            <Link href="/dashboard/settings" className="font-semibold text-arm-600 hover:underline">
              Connect LinkedIn in Settings
            </Link>{" "}
            to get started.
          </p>
        </div>
      )}

      {ready && (
        <section className="rounded-xl border border-slate-200 bg-white p-6">
          <h2 className="text-lg font-semibold text-slate-900">Start a batch</h2>
          <p className="mt-1 text-sm text-slate-500">
            Your arm searches LinkedIn for Easy Apply jobs matching this, then applies
            to each one with your profile and resume. Each application uses one arm run.
          </p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <input
              value={keywords}
              onChange={(e) => setKeywords(e.target.value)}
              placeholder="Keywords, e.g. Senior React Engineer"
              aria-label="Search keywords"
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-arm-500 focus:outline-none"
            />
            <input
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="Location (optional)"
              aria-label="Location"
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-arm-500 focus:outline-none"
            />
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 text-sm text-slate-600">
              <input
                type="checkbox"
                checked={remote}
                onChange={(e) => setRemote(e.target.checked)}
                className="h-4 w-4 rounded border-slate-300"
              />
              Remote only
            </label>
            <label className="flex items-center gap-2 text-sm text-slate-600">
              Apply to up to
              <input
                type="number"
                min={1}
                max={25}
                value={count}
                onChange={(e) => setCount(Math.max(1, Math.min(25, Number(e.target.value) || 1)))}
                aria-label="Number of jobs"
                className="w-16 rounded-lg border border-slate-300 px-2 py-1.5 text-sm text-slate-900 focus:border-arm-500 focus:outline-none"
              />
              jobs
            </label>
            <button
              onClick={() => void start()}
              disabled={busy || keywords.trim().length < 2}
              className="ml-auto rounded-lg bg-arm-500 px-4 py-2 text-sm font-semibold text-ink-950 hover:bg-arm-400 disabled:opacity-50"
            >
              {busy ? "Starting..." : "Start batch"}
            </button>
          </div>
          {error && <p className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
        </section>
      )}

      {batches.map((batch) => {
        const status = BATCH_STATUS_COPY[batch.status] ?? { label: batch.status, tone: "muted" as const };
        const working = status.tone === "working";
        const code = (codes[batch.id] ?? "").trim();
        const toneCls =
          status.tone === "good"
            ? "bg-teal-100 text-teal-800"
            : status.tone === "bad"
              ? "bg-red-100 text-red-700"
              : status.tone === "action"
                ? "bg-amber-100 text-amber-800"
                : status.tone === "working"
                  ? "bg-sky-100 text-sky-700"
                  : "bg-slate-100 text-slate-600";
        return (
          <section key={batch.id} className="mt-6 rounded-xl border border-slate-200 bg-white p-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <h3 className="text-base font-semibold text-slate-900">
                  {batch.keywords}
                  {batch.location ? ` · ${batch.location}` : ""}
                  {batch.remote ? " · Remote" : ""}
                </h3>
                <span className={`rounded-full px-3 py-1 text-sm font-semibold ${toneCls}`}>
                  {working && (
                    <span className="mr-1.5 inline-block h-2 w-2 animate-pulse rounded-full bg-current align-middle" />
                  )}
                  {status.label}
                </span>
              </div>
              {LIVE.has(batch.status) && (
                <button
                  onClick={() => void act(`/api/batches/${batch.id}/cancel`)}
                  disabled={busy}
                  className="text-sm text-slate-400 hover:text-red-500 disabled:opacity-50"
                >
                  Cancel this batch
                </button>
              )}
            </div>

            <p className="mt-3 text-sm text-slate-600">
              {batch.applied} applied · {batch.failed} failed · {batch.processed} of up to{" "}
              {batch.reserved} processed
            </p>
            {batch.reserved > 0 && (
              <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-slate-100">
                <div
                  className="h-full rounded-full bg-arm-500 transition-all"
                  style={{ width: `${Math.min(100, (batch.processed / batch.reserved) * 100)}%` }}
                />
              </div>
            )}

            {batch.error && (
              <p className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-700">{batch.error}</p>
            )}

            {batch.status === "needs_login_code" && (
              <div className="mt-4 rounded-xl border-2 border-amber-300 bg-amber-50 p-5">
                <h4 className="font-display text-base font-bold text-amber-900">
                  LinkedIn needs a verification code
                </h4>
                <p className="mt-1 text-sm text-amber-800">
                  To confirm this sign-in, LinkedIn sent a one-time code to your email or
                  phone. Enter it here and the batch will keep going.
                </p>
                <div className="mt-4 flex flex-wrap gap-3">
                  <input
                    value={codes[batch.id] ?? ""}
                    onChange={(e) => setCodes((c) => ({ ...c, [batch.id]: e.target.value }))}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    placeholder="Verification code"
                    aria-label="LinkedIn verification code"
                    className="w-40 rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-arm-500 focus:outline-none"
                  />
                  <button
                    onClick={() => void act(`/api/batches/${batch.id}/login-code`, { code })}
                    disabled={busy || code.length < 4}
                    className="rounded-lg bg-arm-500 px-4 py-2 text-sm font-semibold text-ink-950 hover:bg-arm-400 disabled:opacity-50"
                  >
                    Submit code
                  </button>
                </div>
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
