"use client";

import { useState } from "react";

const options = [
  {
    value: "review_gate" as const,
    title: "Review gate (recommended)",
    body: "The arm fills everything, then pauses. You review every answer and approve before it submits."
  },
  {
    value: "full_auto" as const,
    title: "Full auto",
    body: "The arm submits without waiting for you. You'll still see everything it submitted in the tracker. Requires Premium or Max; free plans always get the review gate."
  }
];

export function AutonomyToggle({ initial }: { initial: "review_gate" | "full_auto" }) {
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  async function choose(next: "review_gate" | "full_auto") {
    setValue(next);
    setBusy(true);
    setSaved(false);
    const res = await fetch("/api/profile", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ arm_autonomy: next })
    });
    setBusy(false);
    if (res.ok) setSaved(true);
  }

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold text-slate-900">Arm autonomy</h2>
      {options.map((opt) => (
        <button
          key={opt.value}
          onClick={() => choose(opt.value)}
          disabled={busy}
          className={`block w-full rounded-xl border p-5 text-left ${
            value === opt.value
              ? "border-arm-500 bg-teal-50"
              : "border-slate-200 bg-white hover:border-slate-300"
          }`}
        >
          <p className="font-semibold text-slate-900">{opt.title}</p>
          <p className="mt-1 text-sm text-slate-600">{opt.body}</p>
        </button>
      ))}
      {saved && <p className="text-sm text-arm-600">Saved ✓</p>}
    </div>
  );
}
