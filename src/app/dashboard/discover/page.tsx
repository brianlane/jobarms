import Link from "next/link";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getAuthUser } from "@/lib/supabase/auth";
import { scoreJob, type MatchProfile } from "@/lib/match";
import { SUPPORTED_ATS, type Ats } from "@/lib/ats";

export const metadata = { title: "Discover" };

interface JobRow {
  id: string;
  company: string;
  title: string;
  location: string;
  url: string;
  ats: Ats;
  description: string;
  created_at: string;
}

export default async function DiscoverPage() {
  const user = await getAuthUser();
  const supabase = await createSupabaseServerClient();

  const [{ data: profileRow }, { data: jobRows }, { data: applied }] = await Promise.all([
    supabase.from("profiles").select("headline, skills, preferences").eq("id", user!.id).single(),
    supabase
      .from("jobs")
      .select("id, company, title, location, url, ats, description, created_at")
      .like("source", "ingest:%")
      .order("created_at", { ascending: false })
      .limit(400),
    supabase.from("applications").select("job_id")
  ]);

  const profile: MatchProfile = {
    headline: profileRow?.headline ?? "",
    skills: profileRow?.skills ?? [],
    preferences: profileRow?.preferences ?? {}
  };
  const appliedIds = new Set((applied ?? []).map((a) => a.job_id as string));

  const scored = ((jobRows ?? []) as JobRow[])
    .filter((j) => !appliedIds.has(j.id))
    .map((job) => ({ job, match: scoreJob(job, profile) }))
    .filter(({ match }) => match.locationOk)
    .sort((a, b) => b.match.score - a.match.score)
    .slice(0, 50);

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="text-2xl font-bold text-slate-900">Discover</h1>
      <p className="mt-1 text-slate-500">
        Fresh postings from tracked companies, scored against your profile.
      </p>

      {scored.length === 0 ? (
        <div className="mt-8 rounded-xl border border-dashed border-slate-300 p-12 text-center text-slate-500">
          <p>No matches yet.</p>
          <p className="mt-2 text-sm">
            Fresh postings arrive every half hour. Richer profiles match better, so{" "}
            <Link href="/dashboard/profile" className="text-arm-600 hover:underline">
              add your skills
            </Link>
            .
          </p>
        </div>
      ) : (
        <ul className="mt-8 space-y-3">
          {scored.map(({ job, match }) => (
            <li
              key={job.id}
              className="flex items-center justify-between gap-4 rounded-xl border border-slate-200 bg-white p-5"
            >
              <div className="min-w-0">
                <p className="truncate font-semibold text-slate-900">{job.title}</p>
                <p className="mt-0.5 truncate text-sm text-slate-500">
                  {job.company}
                  {job.location ? ` · ${job.location}` : ""}
                </p>
                {match.matchedSkills.length > 0 && (
                  <p className="mt-1 truncate text-xs text-arm-600">
                    Matches: {match.matchedSkills.slice(0, 6).join(", ")}
                  </p>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <span className="rounded-full bg-slate-100 px-3 py-1 text-sm font-bold text-slate-700">
                  {match.score}
                </span>
                <Link
                  href={`/dashboard/applications/new?url=${encodeURIComponent(job.url)}`}
                  className="rounded-lg bg-arm-600 px-4 py-2 text-sm font-semibold text-white hover:bg-arm-500"
                >
                  {SUPPORTED_ATS.has(job.ats) ? "Send an arm" : "Track"}
                </Link>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
