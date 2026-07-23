"use client";

import { useState } from "react";

interface WorkEntry {
  company: string;
  title: string;
  start: string;
  end: string;
  bullets: string[];
}

interface EducationEntry {
  school: string;
  degree: string;
  field: string;
  start: string;
  end: string;
}

export interface ProfileData {
  full_name: string;
  headline: string;
  location: string;
  phone: string;
  summary: string;
  links: Record<string, string>;
  work_history: WorkEntry[];
  education: EducationEntry[];
  skills: string[];
}

const inputCls =
  "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-arm-500 focus:outline-none";

export function ProfileEditor({ initial }: { initial: ProfileData }) {
  const [data, setData] = useState<ProfileData>(initial);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setSaved(false);
    setError(null);
    const res = await fetch("/api/profile", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data)
    });
    setBusy(false);
    if (res.ok) setSaved(true);
    else setError("Save failed. Try again.");
  }

  function updateWork(i: number, patch: Partial<WorkEntry>) {
    const next = [...data.work_history];
    next[i] = { ...next[i], ...patch };
    setData({ ...data, work_history: next });
  }

  function updateEdu(i: number, patch: Partial<EducationEntry>) {
    const next = [...data.education];
    next[i] = { ...next[i], ...patch };
    setData({ ...data, education: next });
  }

  return (
    <div className="space-y-10">
      <section>
        <h2 className="mb-3 text-lg font-semibold text-slate-900">Basics</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <input className={inputCls} placeholder="Full name" value={data.full_name} onChange={(e) => setData({ ...data, full_name: e.target.value })} />
          <input className={inputCls} placeholder="Headline" value={data.headline} onChange={(e) => setData({ ...data, headline: e.target.value })} />
          <input className={inputCls} placeholder="Location" value={data.location} onChange={(e) => setData({ ...data, location: e.target.value })} />
          <input className={inputCls} placeholder="Phone" value={data.phone} onChange={(e) => setData({ ...data, phone: e.target.value })} />
        </div>
        <textarea className={`${inputCls} mt-3`} rows={4} placeholder="Professional summary" value={data.summary} onChange={(e) => setData({ ...data, summary: e.target.value })} />
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold text-slate-900">Links</h2>
        <div className="space-y-2">
          {Object.entries(data.links).map(([label, url]) => (
            <div key={label} className="flex gap-2">
              <span className="w-28 shrink-0 rounded-lg bg-slate-100 px-3 py-2 text-sm text-slate-600">{label}</span>
              <input
                className={inputCls}
                value={url}
                onChange={(e) => setData({ ...data, links: { ...data.links, [label]: e.target.value } })}
              />
            </div>
          ))}
          <button
            onClick={() => {
              const label = prompt("Link label (e.g. linkedin, github, portfolio):");
              if (label) setData({ ...data, links: { ...data.links, [label]: "" } });
            }}
            className="text-sm text-arm-600 hover:underline"
          >
            + Add link
          </button>
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold text-slate-900">Work history</h2>
        <div className="space-y-6">
          {data.work_history.map((w, i) => (
            <div key={i} className="rounded-xl border border-slate-200 bg-white p-4">
              <div className="grid gap-2 sm:grid-cols-2">
                <input className={inputCls} placeholder="Company" value={w.company} onChange={(e) => updateWork(i, { company: e.target.value })} />
                <input className={inputCls} placeholder="Title" value={w.title} onChange={(e) => updateWork(i, { title: e.target.value })} />
                <input className={inputCls} placeholder="Start (MMM YYYY)" value={w.start} onChange={(e) => updateWork(i, { start: e.target.value })} />
                <input className={inputCls} placeholder="End (or Present)" value={w.end} onChange={(e) => updateWork(i, { end: e.target.value })} />
              </div>
              <textarea
                className={`${inputCls} mt-2`}
                rows={3}
                placeholder="Achievements, one per line"
                value={w.bullets.join("\n")}
                onChange={(e) => updateWork(i, { bullets: e.target.value.split("\n") })}
              />
              <button
                onClick={() => setData({ ...data, work_history: data.work_history.filter((_, j) => j !== i) })}
                className="mt-2 text-xs text-red-500 hover:underline"
              >
                Remove role
              </button>
            </div>
          ))}
          <button
            onClick={() =>
              setData({
                ...data,
                work_history: [...data.work_history, { company: "", title: "", start: "", end: "", bullets: [] }]
              })
            }
            className="text-sm text-arm-600 hover:underline"
          >
            + Add role
          </button>
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold text-slate-900">Education</h2>
        <div className="space-y-4">
          {data.education.map((ed, i) => (
            <div key={i} className="grid gap-2 rounded-xl border border-slate-200 bg-white p-4 sm:grid-cols-2">
              <input className={inputCls} placeholder="School" value={ed.school} onChange={(e) => updateEdu(i, { school: e.target.value })} />
              <input className={inputCls} placeholder="Degree" value={ed.degree} onChange={(e) => updateEdu(i, { degree: e.target.value })} />
              <input className={inputCls} placeholder="Field" value={ed.field} onChange={(e) => updateEdu(i, { field: e.target.value })} />
              <div className="flex gap-2">
                <input className={inputCls} placeholder="Start" value={ed.start} onChange={(e) => updateEdu(i, { start: e.target.value })} />
                <input className={inputCls} placeholder="End" value={ed.end} onChange={(e) => updateEdu(i, { end: e.target.value })} />
              </div>
            </div>
          ))}
          <button
            onClick={() =>
              setData({
                ...data,
                education: [...data.education, { school: "", degree: "", field: "", start: "", end: "" }]
              })
            }
            className="text-sm text-arm-600 hover:underline"
          >
            + Add education
          </button>
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold text-slate-900">Skills</h2>
        <textarea
          className={inputCls}
          rows={2}
          placeholder="Comma-separated skills"
          value={data.skills.join(", ")}
          onChange={(e) =>
            setData({ ...data, skills: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })
          }
        />
      </section>

      <div className="flex items-center gap-4">
        <button
          onClick={save}
          disabled={busy}
          className="rounded-lg bg-arm-600 px-6 py-3 font-semibold text-white hover:bg-arm-500 disabled:opacity-50"
        >
          Save profile
        </button>
        {saved && <span className="text-sm text-arm-600">Saved ✓</span>}
        {error && <span className="text-sm text-red-500">{error}</span>}
      </div>
    </div>
  );
}
