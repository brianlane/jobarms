import Link from "next/link";
import { loadProfiles, loadRunsWithJobs, RUN_WINDOW_DAYS } from "@/lib/admin/reads";
import {
  formatDuration,
  phaseDurations,
  runFunnel,
  summarizeRunErrors,
  summarizeRuns,
  RUN_STATUSES,
  type AdminRunRow
} from "@/lib/admin/run-stats";
import type { AdminRunWithJob } from "@/lib/admin/reads";
import {
  Badge,
  Card,
  Empty,
  MeterRow,
  PageHeading,
  SectionTitle,
  Stat,
  runStatusTone,
  Table,
  timeAgo,
  UserLink
} from "@/components/admin/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Admin runs", robots: { index: false, follow: false } };

const ROWS_SHOWN = 60;

function FilterLink({ href, label, active }: { href: string; label: string; active: boolean }) {
  return (
    <Link
      href={href}
      className={`rounded-lg px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.1em] ${
        active ? "bg-arm-500/15 text-arm-300" : "text-slate-500 hover:text-slate-300"
      }`}
    >
      {label}
    </Link>
  );
}

export default async function AdminRunsPage({
  searchParams
}: {
  searchParams: Promise<{ status?: string; ats?: string; autonomy?: string }>;
}) {
  const { status, ats, autonomy } = await searchParams;
  const now = new Date();

  const [runs, profiles] = await Promise.all([loadRunsWithJobs(RUN_WINDOW_DAYS, now), loadProfiles()]);
  const emailById = new Map(profiles.map((p) => [p.id, p.email]));

  const atsOf = (run: AdminRunWithJob) => run.applications?.jobs?.ats ?? "unknown";
  const filtered = runs.filter((run) => {
    if (status && run.status !== status) return false;
    if (ats && atsOf(run) !== ats) return false;
    if (autonomy && run.autonomy !== autonomy) return false;
    return true;
  });

  // Aggregates describe the FILTERED set, so narrowing to one ATS gives that
  // ATS's funnel rather than the fleet's.
  const summary = summarizeRuns(filtered as AdminRunRow[], now);
  const funnel = runFunnel(filtered);
  const durations = phaseDurations(filtered);
  const errors = summarizeRunErrors(filtered as AdminRunRow[]);
  const atsOptions = [...new Set(runs.map(atsOf))].sort();

  const params = (over: Record<string, string | undefined>) => {
    const next = new URLSearchParams();
    const merged = { status, ats, autonomy, ...over };
    for (const [key, value] of Object.entries(merged)) {
      if (value) next.set(key, value);
    }
    const query = next.toString();
    return `/admin/runs${query ? `?${query}` : ""}`;
  };

  return (
    <div className="space-y-6">
      <PageHeading
        title="Arm runs"
        subtitle={`Every run in the last ${RUN_WINDOW_DAYS} days. Figures below follow the filters.`}
      />

      <Card>
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-1">
            <span className="pr-2 font-mono text-[10px] uppercase tracking-[0.16em] text-slate-600">
              status
            </span>
            <FilterLink href={params({ status: undefined })} label="any" active={!status} />
            {RUN_STATUSES.map((option) => (
              <FilterLink
                key={option}
                href={params({ status: option })}
                label={option.replaceAll("_", " ")}
                active={status === option}
              />
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-1">
            <span className="pr-2 font-mono text-[10px] uppercase tracking-[0.16em] text-slate-600">
              ats
            </span>
            <FilterLink href={params({ ats: undefined })} label="any" active={!ats} />
            {atsOptions.map((option) => (
              <FilterLink
                key={option}
                href={params({ ats: option })}
                label={option}
                active={ats === option}
              />
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-1">
            <span className="pr-2 font-mono text-[10px] uppercase tracking-[0.16em] text-slate-600">
              mode
            </span>
            <FilterLink href={params({ autonomy: undefined })} label="any" active={!autonomy} />
            <FilterLink
              href={params({ autonomy: "review_gate" })}
              label="review gate"
              active={autonomy === "review_gate"}
            />
            <FilterLink
              href={params({ autonomy: "full_auto" })}
              label="full auto"
              active={autonomy === "full_auto"}
            />
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Runs" value={summary.total} hint={`${summary.today} today`} />
        <Stat
          label="Submitted"
          value={`${summary.submittedRatePct}%`}
          tone={summary.submittedRatePct >= 50 ? "good" : "warn"}
          hint={`${summary.submitted} of ${summary.terminal} finished`}
        />
        <Stat
          label="Failed"
          value={summary.failed}
          tone={summary.failed > 0 ? "bad" : "neutral"}
          hint={`${summary.failureRatePct}% of finished runs`}
        />
        <Stat
          label="Slots refunded"
          value={summary.refunded}
          hint={`${summary.refundRatePct}% of finished runs`}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <SectionTitle>How far runs get</SectionTitle>
          {summary.total === 0 ? (
            <Empty>No runs match these filters.</Empty>
          ) : (
            <div className="space-y-3">
              {funnel.map((stage) => (
                <div key={stage.step}>
                  <MeterRow
                    label={stage.label}
                    count={stage.reached}
                    total={summary.total}
                    tone={stage.step === "submitted" ? "good" : "info"}
                  />
                  {stage.droppedHere > 0 && (
                    <p className="pt-0.5 text-[10px] text-slate-600">
                      {stage.droppedHere} stopped before this step
                    </p>
                  )}
                </div>
              ))}
              <p className="pt-1 text-xs text-slate-600">
                The review stages count review-gate runs only, since full-auto runs never park.
              </p>
            </div>
          )}
        </Card>

        <Card>
          <SectionTitle>Time per phase</SectionTitle>
          <Table
            head={
              <tr>
                <th className="pb-2">Phase</th>
                <th className="pb-2 text-right">Median</th>
                <th className="pb-2 text-right">p95</th>
                <th className="pb-2 text-right">Runs</th>
              </tr>
            }
          >
            {durations.map((phase) => (
              <tr key={phase.label}>
                <td className="py-2 text-slate-300">{phase.label}</td>
                <td className="py-2 text-right text-slate-300">
                  {formatDuration(phase.medianSeconds)}
                </td>
                <td className="py-2 text-right text-slate-500">
                  {formatDuration(phase.p95Seconds)}
                </td>
                <td className="py-2 text-right text-slate-600">{phase.samples}</td>
              </tr>
            ))}
          </Table>
          <p className="mt-3 text-xs text-slate-600">
            Review gate to approval is human time, not machine time. Everything else is the arm.
          </p>
        </Card>
      </div>

      <Card>
        <SectionTitle>Why runs failed</SectionTitle>
        {errors.length === 0 ? (
          <Empty>No failures in this slice.</Empty>
        ) : (
          <Table
            head={
              <tr>
                <th className="pb-2">Bucket</th>
                <th className="pb-2">What it means</th>
                <th className="pb-2">Example</th>
                <th className="pb-2 text-right">Count</th>
              </tr>
            }
          >
            {errors.map((bucket) => (
              <tr key={bucket.code}>
                <td className="py-2 font-mono text-[11px] text-slate-300">{bucket.code}</td>
                <td className="py-2 text-slate-500">{bucket.meaning}</td>
                <td className="max-w-sm truncate py-2 text-slate-600">{bucket.sample}</td>
                <td className="py-2 text-right text-slate-300">{bucket.count}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Card>
        <SectionTitle
          right={
            <span className="text-xs text-slate-600">
              showing {Math.min(filtered.length, ROWS_SHOWN)} of {filtered.length}
            </span>
          }
        >
          Runs
        </SectionTitle>
        {filtered.length === 0 ? (
          <Empty>No runs match these filters.</Empty>
        ) : (
          <Table
            head={
              <tr>
                <th className="pb-2">User</th>
                <th className="pb-2">Role</th>
                <th className="pb-2">ATS</th>
                <th className="pb-2">Status</th>
                <th className="pb-2">Mode</th>
                <th className="pb-2">Slot</th>
                <th className="pb-2 text-right">Started</th>
              </tr>
            }
          >
            {filtered.slice(0, ROWS_SHOWN).map((run) => (
              <tr key={run.id} className="hover:bg-ink-800/40">
                <td className="py-2">
                  <UserLink id={run.user_id} email={emailById.get(run.user_id) ?? ""} />
                </td>
                <td className="py-2">
                  <Link
                    href={`/admin/runs/${run.id}`}
                    className="text-slate-300 hover:text-arm-300"
                  >
                    {run.applications?.jobs?.title || "Untitled role"}
                    <span className="text-slate-600">
                      {" "}
                      · {run.applications?.jobs?.company || "unknown company"}
                    </span>
                  </Link>
                </td>
                <td className="py-2 text-slate-500">{atsOf(run)}</td>
                <td className="py-2">
                  <Badge tone={runStatusTone(run.status)}>
                    {run.status.replaceAll("_", " ")}
                  </Badge>
                </td>
                <td className="py-2 text-slate-500">{run.autonomy.replaceAll("_", " ")}</td>
                <td className="py-2 text-slate-500">
                  {run.slot_refunded ? "refunded" : "consumed"}
                  {run.canceled_by ? ` (${run.canceled_by})` : ""}
                </td>
                <td className="py-2 text-right text-slate-500">{timeAgo(run.created_at, now)}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
