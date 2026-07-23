import Link from "next/link";
import { notFound } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getAuthUser } from "@/lib/supabase/auth";
import { STATUS_LABELS, STATUS_STYLES, type ApplicationStatus } from "@/lib/application-status";
import { StatusControls } from "@/components/StatusControls";
import { RunPanel, type RunData } from "@/components/RunPanel";
import { TailorPanel } from "@/components/TailorPanel";
import { effectivePlan, canTailor, type SubscriptionRow } from "@/lib/plans";

export const metadata = { title: "Application" };

export default async function ApplicationDetailPage(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const user = await getAuthUser();
  const supabase = await createSupabaseServerClient();

  const { data: app } = await supabase
    .from("applications")
    .select(
      "id, status, notes, cover_letter, applied_at, created_at, jobs(company, title, location, url, description)"
    )
    .eq("id", id)
    .maybeSingle();
  if (!app) notFound();

  const [{ data: runs }, { data: sub }] = await Promise.all([
    supabase
      .from("application_runs")
      .select("id, status, autonomy, steps, answers, form_fields, error, slot_refunded, created_at")
      .eq("application_id", id)
      .order("created_at", { ascending: false }),
    supabase
      .from("subscriptions")
      .select("plan, status, current_period_end, cancel_at_period_end")
      .eq("user_id", user!.id)
      .maybeSingle()
  ]);

  const job = app.jobs as unknown as {
    company: string;
    title: string;
    location: string;
    url: string;
    description: string;
  } | null;
  const status = app.status as ApplicationStatus;
  const latestRun = (runs?.[0] as RunData | undefined) ?? null;
  const premium = canTailor(effectivePlan(sub as SubscriptionRow | null));

  return (
    <div className="mx-auto max-w-4xl">
      <Link href="/dashboard/applications" className="text-sm text-slate-400 hover:text-slate-600">
        ← All applications
      </Link>

      <div className="mt-4 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">{job?.title || "Untitled role"}</h1>
          <p className="mt-1 text-slate-500">
            {job?.company}
            {job?.location ? ` · ${job.location}` : ""} ·{" "}
            <a href={job?.url} target="_blank" rel="noreferrer" className="text-arm-600 hover:underline">
              posting ↗
            </a>
          </p>
        </div>
        <span className={`rounded-full px-3 py-1.5 text-sm font-semibold ${STATUS_STYLES[status]}`}>
          {STATUS_LABELS[status]}
        </span>
      </div>

      {latestRun && (
        <RunPanel key={`${latestRun.id}:${latestRun.status}`} run={latestRun} applicationId={app.id} />
      )}

      <TailorPanel applicationId={app.id} premium={premium} hasCoverLetter={Boolean(app.cover_letter)} />

      {app.cover_letter && (
        <section className="mt-8 rounded-xl border border-slate-200 bg-white p-6">
          <h2 className="mb-2 text-lg font-semibold text-slate-900">Cover letter</h2>
          <p className="whitespace-pre-wrap text-sm text-slate-700">{app.cover_letter}</p>
        </section>
      )}

      <StatusControls applicationId={app.id} current={status} notes={app.notes ?? ""} />
    </div>
  );
}
