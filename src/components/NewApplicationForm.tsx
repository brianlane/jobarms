"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

export function NewApplicationForm({ premium = false }: { premium?: boolean }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [url, setUrl] = useState(searchParams.get("url") ?? "");
  const [mode, setMode] = useState<"arm" | "track_only">("arm");
  const [tailor, setTailor] = useState(premium);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);

    const res = await fetch("/api/applications", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url, mode, tailor: premium && mode === "arm" && tailor })
    });
    const body = await res.json();
    setBusy(false);

    if (res.ok) {
      router.push(`/dashboard/applications/${body.application_id}`);
      router.refresh();
      return;
    }
    if (body.application_id) {
      // Saved to tracker but the arm couldn't run (unsupported ATS / offline).
      setNotice(body.hint ?? "Saved to your tracker.");
      setTimeout(() => {
        router.push(`/dashboard/applications/${body.application_id}`);
        router.refresh();
      }, 1800);
      return;
    }
    setError(body.hint ?? body.error ?? "Something went wrong.");
  }

  return (
    <form onSubmit={submit} className="max-w-xl space-y-5">
      <div>
        <label className="mb-1 block text-sm font-medium text-slate-700">Job posting URL</label>
        <input
          type="url"
          required
          placeholder="https://boards.greenhouse.io/company/jobs/123456"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          className="w-full rounded-lg border border-slate-300 px-4 py-3 text-slate-900 focus:border-arm-500 focus:outline-none"
        />
        <p className="mt-1 text-xs text-slate-400">
          The arm currently drives Greenhouse and Lever postings. Anything else is saved to your tracker.
        </p>
      </div>

      <div className="flex gap-3">
        <button
          type="button"
          onClick={() => setMode("arm")}
          className={`flex-1 rounded-xl border p-4 text-left ${
            mode === "arm" ? "border-arm-500 bg-teal-50" : "border-slate-200 bg-white"
          }`}
        >
          <p className="font-semibold text-slate-900">Send an arm 🦾</p>
          <p className="mt-1 text-xs text-slate-500">AI fills out and submits the application</p>
        </button>
        <button
          type="button"
          onClick={() => setMode("track_only")}
          className={`flex-1 rounded-xl border p-4 text-left ${
            mode === "track_only" ? "border-arm-500 bg-teal-50" : "border-slate-200 bg-white"
          }`}
        >
          <p className="font-semibold text-slate-900">Track only</p>
          <p className="mt-1 text-xs text-slate-500">I&apos;ll apply myself, just track it</p>
        </button>
      </div>

      {premium && mode === "arm" && (
        <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-slate-200 bg-white p-4">
          <input
            type="checkbox"
            checked={tailor}
            onChange={(e) => setTailor(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            <span className="block text-sm font-semibold text-slate-900">
              Tailor my resume for this job first
            </span>
            <span className="mt-0.5 block text-xs text-slate-500">
              Rewrites your resume around this job&apos;s keywords before applying; the tailored
              PDF is the file the arm uploads. Adds about 20 seconds.
            </span>
          </span>
        </label>
      )}

      <button
        type="submit"
        disabled={busy}
        className="rounded-lg bg-arm-600 px-6 py-3 font-semibold text-white hover:bg-arm-500 disabled:opacity-50"
      >
        {busy
          ? tailor && mode === "arm"
            ? "Tailoring resume and starting the arm..."
            : "Working..."
          : mode === "arm"
            ? "Start the arm"
            : "Save to tracker"}
      </button>

      {notice && <p className="text-sm text-amber-600">{notice}</p>}
      {error && <p className="text-sm text-red-500">{error}</p>}
    </form>
  );
}
