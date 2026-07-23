"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { MANUAL_STATUSES, STATUS_LABELS, type ApplicationStatus } from "@/lib/application-status";

export function StatusControls({
  applicationId,
  current,
  notes
}: {
  applicationId: string;
  current: ApplicationStatus;
  notes: string;
}) {
  const router = useRouter();
  const [noteText, setNoteText] = useState(notes);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  async function patch(body: Record<string, unknown>) {
    setBusy(true);
    setSaved(false);
    const res = await fetch(`/api/applications/${applicationId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    setBusy(false);
    if (res.ok) {
      setSaved(true);
      router.refresh();
    }
  }

  return (
    <section className="mt-8 rounded-xl border border-slate-200 bg-white p-6">
      <h2 className="text-lg font-semibold text-slate-900">Tracker</h2>

      <div className="mt-4 flex flex-wrap gap-2">
        {MANUAL_STATUSES.map((s) => (
          <button
            key={s}
            onClick={() => patch({ status: s })}
            disabled={busy || s === current}
            className={`rounded-full px-4 py-2 text-sm font-medium ${
              s === current
                ? "bg-[--color-arm-600] text-white"
                : "border border-slate-300 text-slate-600 hover:border-slate-400"
            } disabled:opacity-60`}
          >
            {STATUS_LABELS[s]}
          </button>
        ))}
      </div>

      <textarea
        rows={3}
        placeholder="Notes (interview dates, contacts, comp discussed…)"
        value={noteText}
        onChange={(e) => setNoteText(e.target.value)}
        className="mt-4 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-[--color-arm-500] focus:outline-none"
      />
      <div className="mt-2 flex items-center gap-3">
        <button
          onClick={() => patch({ notes: noteText })}
          disabled={busy}
          className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:border-slate-400 disabled:opacity-50"
        >
          Save notes
        </button>
        {saved && <span className="text-sm text-[--color-arm-600]">Saved ✓</span>}
      </div>
    </section>
  );
}
