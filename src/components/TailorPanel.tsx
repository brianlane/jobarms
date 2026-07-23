"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

interface Keywords {
  incorporated: string[];
  missing: string[];
}

export function TailorPanel({
  applicationId,
  premium,
  hasCoverLetter
}: {
  applicationId: string;
  premium: boolean;
  hasCoverLetter: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<"resume" | "cover_letter" | null>(null);
  const [keywords, setKeywords] = useState<Keywords | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(kind: "resume" | "cover_letter") {
    setBusy(kind);
    setError(null);
    const res = await fetch(`/api/applications/${applicationId}/tailor`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind })
    });
    const body = await res.json().catch(() => ({}));
    setBusy(null);
    if (res.ok) {
      if (kind === "resume") {
        setKeywords(body.keywords ?? null);
        setDownloadUrl(body.download_url ?? null);
      }
      router.refresh();
    } else {
      setError(body.hint ?? body.error ?? "Generation failed.");
    }
  }

  return (
    <section className="mt-8 rounded-xl border border-slate-200 bg-white p-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-slate-900">AI tailoring</h2>
        {!premium && (
          <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-800">
            Premium
          </span>
        )}
      </div>
      <p className="mt-1 text-sm text-slate-500">
        Tailor your resume to this job&apos;s keywords, or draft a cover letter. Tailored resumes
        become the file the arm uploads.
      </p>

      {premium ? (
        <div className="mt-4 flex flex-wrap gap-3">
          <button
            onClick={() => run("resume")}
            disabled={busy !== null}
            className="rounded-lg bg-[--color-arm-600] px-5 py-2.5 text-sm font-semibold text-white hover:bg-[--color-arm-500] disabled:opacity-50"
          >
            {busy === "resume" ? "Tailoring…" : "Tailor resume"}
          </button>
          <button
            onClick={() => run("cover_letter")}
            disabled={busy !== null}
            className="rounded-lg border border-slate-300 px-5 py-2.5 text-sm font-semibold text-slate-700 hover:border-slate-400 disabled:opacity-50"
          >
            {busy === "cover_letter"
              ? "Writing…"
              : hasCoverLetter
                ? "Regenerate cover letter"
                : "Generate cover letter"}
          </button>
        </div>
      ) : (
        <Link
          href="/dashboard/billing"
          className="mt-4 inline-block rounded-lg bg-[--color-arm-600] px-5 py-2.5 text-sm font-semibold text-white hover:bg-[--color-arm-500]"
        >
          Upgrade to unlock
        </Link>
      )}

      {downloadUrl && (
        <p className="mt-4 text-sm">
          <a href={downloadUrl} className="font-semibold text-[--color-arm-600] hover:underline">
            Download tailored resume (PDF) ↓
          </a>
        </p>
      )}

      {keywords && (
        <div className="mt-4 grid gap-4 text-sm sm:grid-cols-2">
          <div>
            <p className="font-semibold text-slate-700">Keywords worked in</p>
            <p className="mt-1 text-slate-500">{keywords.incorporated.join(", ") || "—"}</p>
          </div>
          <div>
            <p className="font-semibold text-slate-700">Gaps to be aware of</p>
            <p className="mt-1 text-slate-500">{keywords.missing.join(", ") || "—"}</p>
          </div>
        </div>
      )}

      {error && <p className="mt-3 text-sm text-red-500">{error}</p>}
    </section>
  );
}
