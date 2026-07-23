"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export interface RunData {
  id: string;
  status: string;
  autonomy: string;
  steps: { at: string; step: string; detail?: string }[];
  answers: { name: string; label: string; value: string; skipped?: boolean }[] | null;
  form_fields: unknown;
  error: string | null;
  created_at: string;
}

/**
 * Latest arm run: step timeline, screenshots, and — when the run is parked at
 * the review gate — editable answers with the approve button.
 */
export function RunPanel({ run }: { run: RunData }) {
  const router = useRouter();
  const [answers, setAnswers] = useState(run.answers ?? []);
  const [screenshots, setScreenshots] = useState<{ path: string; url: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/runs/${run.id}/screenshots`)
      .then((r) => (r.ok ? r.json() : { screenshots: [] }))
      .then((b) => setScreenshots(b.screenshots ?? []))
      .catch(() => {});
  }, [run.id]);

  // While the arm works, poll for state changes.
  useEffect(() => {
    if (!["queued", "running", "approved", "submitting"].includes(run.status)) return;
    const t = setInterval(() => router.refresh(), 5000);
    return () => clearInterval(t);
  }, [run.status, router]);

  async function act(path: string, body?: unknown) {
    setBusy(true);
    setError(null);
    const res = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined
    });
    setBusy(false);
    if (res.ok) {
      router.refresh();
    } else {
      const b = await res.json().catch(() => ({}));
      setError(b.hint ?? b.error ?? "Action failed.");
    }
  }

  const reviewing = run.status === "needs_review";

  return (
    <section className="mt-8 rounded-xl border border-slate-200 bg-white p-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-slate-900">
          Arm run <span className="text-sm font-normal text-slate-400">({run.status})</span>
        </h2>
        {["queued", "running", "needs_review"].includes(run.status) && (
          <button
            onClick={() => act(`/api/runs/${run.id}/cancel`)}
            disabled={busy}
            className="text-sm text-red-500 hover:underline disabled:opacity-50"
          >
            Cancel run
          </button>
        )}
      </div>

      {run.error && (
        <p className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-700">{run.error}</p>
      )}

      {/* Step timeline */}
      {run.steps.length > 0 && (
        <ol className="mt-4 space-y-1 border-l-2 border-slate-100 pl-4 text-sm text-slate-600">
          {run.steps.map((s, i) => (
            <li key={i}>
              <span className="font-medium text-slate-800">{s.step}</span>
              {s.detail ? ` — ${s.detail}` : ""}
              <span className="ml-2 text-xs text-slate-400">
                {new Date(s.at).toLocaleTimeString()}
              </span>
            </li>
          ))}
        </ol>
      )}

      {/* Review gate */}
      {reviewing && answers.length > 0 && (
        <div className="mt-6">
          <h3 className="font-semibold text-amber-700">
            Review before it submits — edit anything, then approve.
          </h3>
          <div className="mt-3 space-y-3">
            {answers.map((a, i) => (
              <div key={a.name}>
                <label className="mb-0.5 block text-xs font-medium text-slate-500">
                  {a.label || a.name}
                  {a.skipped && <span className="ml-2 text-amber-600">(arm skipped — fill in)</span>}
                </label>
                <textarea
                  rows={a.value.length > 120 ? 4 : 1}
                  value={a.value}
                  onChange={(e) => {
                    const next = [...answers];
                    next[i] = { ...a, value: e.target.value, skipped: false };
                    setAnswers(next);
                  }}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-[--color-arm-500] focus:outline-none"
                />
              </div>
            ))}
          </div>
          <button
            onClick={() => act(`/api/runs/${run.id}/approve`, { answers })}
            disabled={busy}
            className="mt-4 rounded-lg bg-[--color-arm-600] px-6 py-3 font-semibold text-white hover:bg-[--color-arm-500] disabled:opacity-50"
          >
            {busy ? "Sending…" : "Approve & submit"}
          </button>
        </div>
      )}

      {/* Submitted answers (read-only after the gate) */}
      {!reviewing && run.answers && run.answers.length > 0 && (
        <details className="mt-4">
          <summary className="cursor-pointer text-sm font-medium text-slate-600">
            What the arm submitted ({run.answers.length} answers)
          </summary>
          <dl className="mt-3 space-y-2 text-sm">
            {run.answers.map((a) => (
              <div key={a.name}>
                <dt className="text-xs text-slate-400">{a.label || a.name}</dt>
                <dd className="text-slate-800">{a.skipped ? "(skipped)" : a.value || "—"}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}

      {/* Screenshots */}
      {screenshots.length > 0 && (
        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          {screenshots.map((s) => (
            <a key={s.path} href={s.url} target="_blank" rel="noreferrer">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={s.url}
                alt="Arm screenshot"
                className="rounded-lg border border-slate-200 hover:border-[--color-arm-500]"
              />
            </a>
          ))}
        </div>
      )}

      {error && <p className="mt-3 text-sm text-red-500">{error}</p>}
    </section>
  );
}
