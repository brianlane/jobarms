"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Step = "upload" | "review" | "preferences" | "done";

interface ProfileDraft {
  full_name: string;
  headline: string;
  location: string;
  phone: string;
  summary: string;
  skills: string[];
}

export function OnboardingWizard() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("upload");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<ProfileDraft>({
    full_name: "",
    headline: "",
    location: "",
    phone: "",
    summary: "",
    skills: []
  });
  const [prefs, setPrefs] = useState({
    salary_floor: "",
    locations: "",
    remote: true,
    visa_sponsorship: false
  });

  async function uploadResume(file: File) {
    setBusy(true);
    setError(null);
    const form = new FormData();
    form.append("file", file);
    const res = await fetch("/api/resumes", { method: "POST", body: form });
    const body = await res.json();
    setBusy(false);
    if (res.ok && body.parsed) {
      setDraft({
        full_name: body.parsed.full_name ?? "",
        headline: body.parsed.headline ?? "",
        location: body.parsed.location ?? "",
        phone: body.parsed.phone ?? "",
        summary: body.parsed.summary ?? "",
        skills: body.parsed.skills ?? []
      });
      setStep("review");
    } else if (res.status === 422) {
      setError("We stored your resume but couldn't parse it — fill in the basics below.");
      setStep("review");
    } else {
      setError(body.hint ?? body.error ?? "Upload failed.");
    }
  }

  async function saveReview() {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/profile", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(draft)
    });
    setBusy(false);
    if (res.ok) setStep("preferences");
    else setError("Could not save. Try again.");
  }

  async function savePreferences() {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/profile", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        preferences: {
          salary_floor: prefs.salary_floor ? Number(prefs.salary_floor) : null,
          locations: prefs.locations
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
          remote: prefs.remote,
          visa_sponsorship: prefs.visa_sponsorship
        },
        onboarding_complete: true
      })
    });
    setBusy(false);
    if (res.ok) {
      setStep("done");
      setTimeout(() => {
        router.push("/dashboard");
        router.refresh();
      }, 1200);
    } else {
      setError("Could not save. Try again.");
    }
  }

  const inputCls =
    "w-full rounded-lg border border-slate-300 px-4 py-3 text-slate-900 focus:border-[--color-arm-500] focus:outline-none";

  return (
    <div className="mx-auto max-w-xl">
      <div className="mb-8 flex gap-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
        {(["upload", "review", "preferences"] as const).map((s, i) => (
          <span key={s} className={step === s ? "text-[--color-arm-600]" : ""}>
            {i + 1}. {s}
            {i < 2 && <span className="mx-2 text-slate-300">→</span>}
          </span>
        ))}
      </div>

      {step === "upload" && (
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Upload your resume</h1>
          <p className="mt-2 text-slate-500">
            PDF or DOCX. Gemini reads it once and builds the profile your arms apply with.
          </p>
          <label className="mt-6 flex h-40 cursor-pointer items-center justify-center rounded-xl border-2 border-dashed border-slate-300 text-slate-500 hover:border-[--color-arm-500]">
            {busy ? "Parsing your resume…" : "Click to choose a file"}
            <input
              type="file"
              accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              className="hidden"
              disabled={busy}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void uploadResume(f);
              }}
            />
          </label>
          <button
            onClick={() => setStep("review")}
            className="mt-4 text-sm text-slate-400 hover:text-slate-600"
          >
            Skip — I&apos;ll fill my profile manually
          </button>
        </div>
      )}

      {step === "review" && (
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Review your profile</h1>
          <p className="mt-2 text-slate-500">This is what your arms will use. Fix anything off.</p>
          <div className="mt-6 space-y-4">
            <input className={inputCls} placeholder="Full name" value={draft.full_name} onChange={(e) => setDraft({ ...draft, full_name: e.target.value })} />
            <input className={inputCls} placeholder="Headline (e.g. Senior Software Engineer)" value={draft.headline} onChange={(e) => setDraft({ ...draft, headline: e.target.value })} />
            <input className={inputCls} placeholder="Location" value={draft.location} onChange={(e) => setDraft({ ...draft, location: e.target.value })} />
            <input className={inputCls} placeholder="Phone" value={draft.phone} onChange={(e) => setDraft({ ...draft, phone: e.target.value })} />
            <textarea className={inputCls} rows={4} placeholder="Professional summary" value={draft.summary} onChange={(e) => setDraft({ ...draft, summary: e.target.value })} />
          </div>
          <button
            onClick={saveReview}
            disabled={busy}
            className="mt-6 rounded-lg bg-[--color-arm-600] px-6 py-3 font-semibold text-white hover:bg-[--color-arm-500] disabled:opacity-50"
          >
            Looks right →
          </button>
        </div>
      )}

      {step === "preferences" && (
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Preferences &amp; dealbreakers</h1>
          <p className="mt-2 text-slate-500">
            Your arms respect these on every application and match.
          </p>
          <div className="mt-6 space-y-4">
            <input className={inputCls} type="number" placeholder="Minimum salary (USD/year)" value={prefs.salary_floor} onChange={(e) => setPrefs({ ...prefs, salary_floor: e.target.value })} />
            <input className={inputCls} placeholder="Preferred locations (comma-separated)" value={prefs.locations} onChange={(e) => setPrefs({ ...prefs, locations: e.target.value })} />
            <label className="flex items-center gap-3 text-slate-700">
              <input type="checkbox" checked={prefs.remote} onChange={(e) => setPrefs({ ...prefs, remote: e.target.checked })} />
              Open to remote
            </label>
            <label className="flex items-center gap-3 text-slate-700">
              <input type="checkbox" checked={prefs.visa_sponsorship} onChange={(e) => setPrefs({ ...prefs, visa_sponsorship: e.target.checked })} />
              I need visa sponsorship
            </label>
          </div>
          <button
            onClick={savePreferences}
            disabled={busy}
            className="mt-6 rounded-lg bg-[--color-arm-600] px-6 py-3 font-semibold text-white hover:bg-[--color-arm-500] disabled:opacity-50"
          >
            Finish setup
          </button>
        </div>
      )}

      {step === "done" && (
        <div className="text-center">
          <h1 className="text-2xl font-bold text-slate-900">You&apos;re set 🎉</h1>
          <p className="mt-2 text-slate-500">Taking you to your dashboard…</p>
        </div>
      )}

      {error && <p className="mt-4 text-sm text-red-500">{error}</p>}
    </div>
  );
}
