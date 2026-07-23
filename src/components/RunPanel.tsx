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
  slot_refunded?: boolean;
  created_at: string;
}

/** Friendly status line for the run header. */
const RUN_STATUS_COPY: Record<string, { label: string; tone: "working" | "action" | "good" | "bad" | "muted" }> = {
  queued: { label: "Getting started...", tone: "working" },
  running: { label: "Your arm is working...", tone: "working" },
  needs_review: { label: "Waiting for your review", tone: "action" },
  approved: { label: "Approved, submitting...", tone: "working" },
  submitting: { label: "Submitting...", tone: "working" },
  submitted: { label: "Application submitted", tone: "good" },
  failed: { label: "This run hit a problem", tone: "bad" },
  canceled: { label: "Run canceled", tone: "muted" }
};

/** Human translation of the technical step log. */
function friendlyStep(step: { step: string; detail?: string }): string | null {
  switch (step.step) {
    case "navigate":
      return "Opened the job application";
    case "form_extracted": {
      const n = parseInt(step.detail ?? "", 10);
      return Number.isFinite(n)
        ? `Read the form: ${n} question${n === 1 ? "" : "s"}`
        : "Read the application form";
    }
    case "recovery_vision":
      return "Looked at the page and found the real application form";
    case "recovery_playbook":
      return "Used a known fix for this site";
    case "form_not_found":
      return "Couldn't find an application form on this page";
    case "answers_generated": {
      // A single junk answer isn't "drafting" (old dead-end runs); stay quiet.
      const n = parseInt(step.detail ?? "", 10);
      return Number.isFinite(n) && n <= 1 ? null : "Drafted your answers";
    }
    case "review_requested":
      return "Paused so you can review";
    case "approved":
      return "You approved the answers";
    case "submitted":
      return "Submitted and confirmed";
    case "submit_unconfirmed":
      return "Submitted, but confirmation was unclear";
    case "captcha_blocked":
      return "Filled everything, but an anti-bot check blocked the final submit";
    default:
      return null; // internal noise stays in the technical log
  }
}

/**
 * Latest arm run, presented for humans: a friendly status + progress story,
 * a clear review-and-approve flow when the arm is waiting, and the raw
 * technical log tucked behind a disclosure.
 */
export function RunPanel({ run, applicationId }: { run: RunData; applicationId: string }) {
  const router = useRouter();
  const [answers, setAnswers] = useState(run.answers ?? []);
  const [screenshots, setScreenshots] = useState<{ path: string; url: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // NOTE: the parent renders this panel with key={runId}:{status}, so a
  // status transition (running -> needs_review) REMOUNTS it and useState
  // re-reads fresh props. Without that key, the review form would never
  // appear while the page polls (useState ignores prop updates).

  useEffect(() => {
    fetch(`/api/runs/${run.id}/screenshots`)
      .then((r) => (r.ok ? r.json() : { screenshots: [] }))
      .then((b) => setScreenshots(b.screenshots ?? []))
      .catch(() => {});
  }, [run.id, run.status]);

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

  const status = RUN_STATUS_COPY[run.status] ?? { label: run.status, tone: "muted" as const };
  const reviewing = run.status === "needs_review";
  const working = ["queued", "running", "approved", "submitting"].includes(run.status);
  const ended = run.status === "failed" || run.status === "canceled";
  const reviewable = answers.filter((a) => (a.label || a.value || "").trim() !== "");
  const snag = reviewing && reviewable.length === 0;
  const retryable = snag || ended;

  const toneCls =
    status.tone === "action"
      ? "bg-amber-100 text-amber-800"
      : status.tone === "good"
        ? "bg-teal-100 text-teal-800"
        : status.tone === "bad"
          ? "bg-red-100 text-red-700"
          : "bg-slate-100 text-slate-600";

  const friendlySteps = run.steps
    .map((s) => ({ at: s.at, text: friendlyStep(s) }))
    .filter((s): s is { at: string; text: string } => s.text !== null);

  return (
    <section className="mt-8 rounded-xl border border-slate-200 bg-white p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold text-slate-900">Your arm</h2>
          <span className={`rounded-full px-3 py-1 text-sm font-semibold ${toneCls}`}>
            {working && (
              <span className="mr-1.5 inline-block h-2 w-2 animate-pulse rounded-full bg-current align-middle" />
            )}
            {status.label}
          </span>
        </div>
        {["queued", "running", "needs_review"].includes(run.status) && (
          <button
            onClick={() => act(`/api/runs/${run.id}/cancel`)}
            disabled={busy}
            className="text-sm text-slate-400 hover:text-red-500 disabled:opacity-50"
          >
            Cancel this run
          </button>
        )}
      </div>

      {run.error && (
        <div className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-700">
          <p>
            {run.error.includes("captcha_blocked")
              ? "This employer's anti-bot check blocked the automated submit. Your answers are saved; finish on the employer's site from the posting link. This run counted, since the arm did the full application."
              : run.error.includes("submit_unconfirmed")
                ? "The application was submitted, but the site never showed a confirmation. Check the screenshots below or verify on the employer's site."
                : run.error.includes("review_timeout")
                  ? "This review sat for 7 days without a decision, so the run ended on its own. Nothing was submitted."
                  : run.error.includes("form_not_found")
                    ? "Your arm looked at this page every way it knows and couldn't find a real application form (some career sites block automation or hide their forms)."
                    : "The arm ran into a problem it couldn't recover from. Your tracker entry is saved."}
          </p>
          {run.slot_refunded && (
            <p className="mt-1.5 font-medium text-red-800">
              This run did not count against your arm runs.
            </p>
          )}
        </div>
      )}

      {/* Terminal runs can go again: arms improve with every application */}
      {ended && (
        <button
          onClick={() => act(`/api/applications/${applicationId}/retry`)}
          disabled={busy}
          className="mt-4 rounded-lg bg-arm-600 px-5 py-2.5 font-semibold text-white hover:bg-arm-500 disabled:opacity-50"
        >
          {busy ? "Starting..." : "Retry with a fresh arm"}
        </button>
      )}

      {/* Friendly progress story (neutral dots when the journey ended badly) */}
      {friendlySteps.length > 0 && (
        <ol className="mt-5 space-y-2">
          {friendlySteps.map((s, i) => (
            <li key={i} className="flex items-center gap-3 text-sm">
              <span
                className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${
                  ended || snag ? "bg-slate-200 text-slate-500" : "bg-teal-100 text-teal-700"
                }`}
              >
                {ended || snag ? "·" : "✓"}
              </span>
              <span className={ended || snag ? "text-slate-500" : "text-slate-700"}>{s.text}</span>
              <span className="ml-auto shrink-0 text-xs text-slate-400">
                {new Date(s.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
              </span>
            </li>
          ))}
        </ol>
      )}

      {/* Dead-ended review: nothing to approve, offer the fix */}
      {snag && (
        <div className="mt-6 rounded-xl border-2 border-amber-300 bg-amber-50 p-5">
          <h3 className="font-display text-base font-bold text-amber-900">
            Your arm hit a snag on this one
          </h3>
          <p className="mt-1 text-sm text-amber-800">
            It reached the page but couldn&apos;t read a real application form, so there&apos;s
            nothing to review. Arms learn from every attempt; a fresh one may get through now.
          </p>
          <div className="mt-4 flex flex-wrap gap-3">
            <button
              onClick={() => act(`/api/applications/${applicationId}/retry`)}
              disabled={busy}
              className="rounded-lg bg-arm-600 px-5 py-2.5 font-semibold text-white hover:bg-arm-500 disabled:opacity-50"
            >
              {busy ? "Starting..." : "Retry with a fresh arm"}
            </button>
            <button
              onClick={() => act(`/api/runs/${run.id}/cancel`)}
              disabled={busy}
              className="rounded-lg border border-slate-300 px-5 py-2.5 font-semibold text-slate-700 hover:border-slate-400 disabled:opacity-50"
            >
              Cancel and apply manually
            </button>
          </div>
          <p className="mt-3 text-xs text-amber-700">
            Dead-ended runs like this one don&apos;t count against your arm runs.
          </p>
        </div>
      )}

      {/* Review gate: the one moment that needs the user */}
      {reviewing && !snag && (
        <div className="mt-6 rounded-xl border-2 border-amber-300 bg-amber-50 p-5">
          <h3 className="font-display text-base font-bold text-amber-900">
            Your arm needs you: review the answers below, then approve
          </h3>
          <p className="mt-1 text-sm text-amber-800">
            Nothing is sent until you approve. Edit anything that reads wrong; answers the arm
            couldn&apos;t figure out are highlighted for you to fill in.
          </p>
          <p className="mt-1 text-xs text-amber-700">
            Your resume is attached automatically, and anti-bot checks are handled for you.
          </p>
          <div className="mt-4 space-y-3">
            {answers.map((a, i) =>
              (a.label || a.value || "").trim() === "" ? null : (
                <div key={a.name}>
                  <label className="mb-0.5 block text-xs font-medium text-slate-600">
                    {a.label || a.name}
                    {a.skipped && (
                      <span className="ml-2 font-semibold text-amber-700">
                        needs your answer
                      </span>
                    )}
                  </label>
                  <textarea
                    rows={a.value.length > 120 ? 4 : 1}
                    value={a.value}
                    onChange={(e) => {
                      const next = [...answers];
                      next[i] = { ...a, value: e.target.value, skipped: false };
                      setAnswers(next);
                    }}
                    className={`w-full rounded-lg border px-3 py-2 text-sm text-slate-900 focus:border-arm-500 focus:outline-none ${
                      a.skipped ? "border-amber-400 bg-amber-50/50" : "border-slate-300 bg-white"
                    }`}
                  />
                </div>
              )
            )}
          </div>
          <button
            onClick={() => act(`/api/runs/${run.id}/approve`, { answers })}
            disabled={busy}
            className="mt-5 w-full rounded-lg bg-arm-600 px-6 py-3.5 font-semibold text-white hover:bg-arm-500 disabled:opacity-50 sm:w-auto"
          >
            {busy ? "Sending..." : "Approve and submit application"}
          </button>
        </div>
      )}

      {/* What was submitted (read-only after the gate) */}
      {!reviewing && run.answers && run.answers.length > 0 && (
        <details className="mt-5">
          <summary className="cursor-pointer text-sm font-medium text-slate-600">
            What your arm submitted ({run.answers.length} answers)
          </summary>
          <dl className="mt-3 space-y-2 text-sm">
            {run.answers.map((a) => (
              <div key={a.name}>
                <dt className="text-xs text-slate-400">{a.label || a.name}</dt>
                <dd className="text-slate-800">{a.skipped ? "(left blank)" : a.value || "-"}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}

      {/* Screenshots: proof of what the arm saw */}
      {screenshots.length > 0 && (
        <details className="mt-4" open={reviewing}>
          <summary className="cursor-pointer text-sm font-medium text-slate-600">
            Screenshots from the arm ({screenshots.length})
          </summary>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {screenshots.map((s) => (
              <a key={s.path} href={s.url} target="_blank" rel="noreferrer">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={s.url}
                  alt="What the arm saw"
                  className="rounded-lg border border-slate-200 hover:border-arm-500"
                />
              </a>
            ))}
          </div>
        </details>
      )}

      {/* Raw internals for the curious; never the primary view */}
      {run.steps.length > 0 && (
        <details className="mt-4">
          <summary className="cursor-pointer text-xs font-medium text-slate-400">
            Technical log
          </summary>
          <ol className="mt-2 space-y-1 border-l-2 border-slate-100 pl-4 font-mono text-xs text-slate-500">
            {run.steps.map((s, i) => (
              <li key={i}>
                {s.step}
                {s.detail ? `: ${s.detail}` : ""}
                <span className="ml-2 text-slate-300">{new Date(s.at).toLocaleTimeString()}</span>
              </li>
            ))}
          </ol>
        </details>
      )}

      {error && <p className="mt-3 text-sm text-red-500">{error}</p>}
    </section>
  );
}
