import Link from "next/link";
import { loadFleetSnapshot, RUN_WINDOW_DAYS } from "@/lib/admin/reads";
import {
  formatCents,
  ingestStale,
  pct,
  summarizeAiUsage,
  summarizeApplications,
  summarizeMrr,
  summarizePlans,
  summarizeUsers,
  AI_CALL_KINDS,
  type AdminProfileRow
} from "@/lib/admin/overview";
import { quotaPressure } from "@/lib/admin/overview";
import { needsAttention, summarizeRunErrors, summarizeRuns } from "@/lib/admin/run-stats";
import {
  APPLICATION_STATUSES,
  STATUS_LABELS,
  type ApplicationStatus
} from "@/lib/application-status";
import {
  BarChart,
  Badge,
  Card,
  Empty,
  MeterRow,
  PageHeading,
  runStatusTone,
  SectionTitle,
  Stat,
  Table,
  timeAgo,
  UserLink
} from "@/components/admin/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Admin overview", robots: { index: false, follow: false } };

const KIND_LABELS: Record<string, string> = {
  resume_parse: "Resume parses",
  tailor_resume: "Tailored resumes",
  cover_letter: "Cover letters"
};

export default async function AdminDashboardPage() {
  const now = new Date();
  const snapshot = await loadFleetSnapshot(now);

  const users = summarizeUsers(snapshot.profiles, now);
  const plans = summarizePlans(snapshot.profiles, snapshot.subscriptions);
  const mrr = summarizeMrr(snapshot.profiles, snapshot.subscriptions);
  const runs = summarizeRuns(snapshot.runs, now);
  const errors = summarizeRunErrors(snapshot.runs);
  const apps = summarizeApplications(snapshot.applications);
  const ai = summarizeAiUsage(snapshot.aiUsage);
  const attention = needsAttention(snapshot.runs, now).slice(0, 8);
  const pressure = quotaPressure({
    profiles: snapshot.profiles,
    subscriptions: snapshot.subscriptions,
    usageByUser: snapshot.quotaUsage
  }).slice(0, 8);

  const emailById = new Map<string, string>(
    snapshot.profiles.map((p: AdminProfileRow) => [p.id, p.email])
  );
  const catalogStale = ingestStale(snapshot.catalog.newestJobAt, now);
  const recentRuns = snapshot.runs.slice(0, 10);

  return (
    <div className="space-y-6">
      <PageHeading
        title="Platform overview"
        subtitle={`Every user, run, and dollar. Run figures cover the last ${RUN_WINDOW_DAYS} days.`}
      />

      {/* Headline numbers */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat
          label="Users"
          value={users.total}
          hint={`${users.new7d} new this week · ${users.onboardedPct}% onboarded`}
        />
        <Stat
          label="Paying"
          value={plans.paying}
          tone={plans.paying > 0 ? "good" : "neutral"}
          hint={`${plans.counts.premium} premium · ${plans.counts.max} max`}
        />
        <Stat
          label="Est. MRR"
          value={formatCents(mrr.totalCents)}
          hint={
            mrr.pendingChurnCents > 0
              ? `${formatCents(mrr.pendingChurnCents)} canceling at period end`
              : `${formatCents(mrr.arpuCents)} per paying user`
          }
        />
        <Stat
          label="Runs (30d)"
          value={runs.last30d}
          hint={`${runs.today} today · ${runs.submittedRatePct}% submitted`}
          tone={runs.failed > runs.submitted ? "warn" : "neutral"}
        />
      </div>

      {/* Signups + plan mix */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <SectionTitle>New signups, last 6 months</SectionTitle>
          <BarChart points={users.signupsByMonth} />
        </Card>
        <Card>
          <SectionTitle>Plan mix</SectionTitle>
          <div className="space-y-3">
            <MeterRow label="free" count={plans.counts.free} total={users.total} tone="info" />
            <MeterRow
              label="premium"
              count={plans.counts.premium}
              total={users.total}
              tone="good"
            />
            <MeterRow label="max" count={plans.counts.max} total={users.total} tone="warn" />
          </div>
          <div className="mt-5 space-y-2 border-t border-ink-800 pt-4">
            <SectionTitle>Subscription status</SectionTitle>
            {Object.entries(plans.statusCounts)
              .sort((a, b) => b[1] - a[1])
              .map(([status, count]) => (
                <div key={status} className="flex items-center justify-between text-xs">
                  <Badge
                    tone={
                      status === "active" || status === "trialing"
                        ? "good"
                        : status === "past_due"
                          ? "bad"
                          : "neutral"
                    }
                  >
                    {status.replaceAll("_", " ")}
                  </Badge>
                  <span className="font-medium text-slate-400">{count}</span>
                </div>
              ))}
            {plans.pendingCancellations > 0 && (
              <p className="pt-1 text-xs text-amber-300">
                {plans.pendingCancellations} canceling at period end
              </p>
            )}
          </div>
        </Card>
      </div>

      {/* Arm run health */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card>
          <SectionTitle>Arm run health</SectionTitle>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <p className="text-xs text-slate-500">Submitted</p>
              <p className="text-xl font-bold text-teal-300">{runs.submitted}</p>
            </div>
            <div>
              <p className="text-xs text-slate-500">Failed</p>
              <p className="text-xl font-bold text-red-300">{runs.failed}</p>
            </div>
            <div>
              <p className="text-xs text-slate-500">In flight</p>
              <p className="text-xl font-bold text-white">{runs.inFlight}</p>
            </div>
            <div>
              <p className="text-xs text-slate-500">Awaiting review</p>
              <p className="text-xl font-bold text-amber-300">{runs.needsReview}</p>
            </div>
          </div>
          <div className="mt-4 space-y-1.5 border-t border-ink-800 pt-4 text-xs text-slate-500">
            <p>
              Canceled {runs.canceled} ({runs.canceledByUser} by user, {runs.canceledBySystem} by
              system)
            </p>
            <p>
              Slots refunded {runs.refunded} ({runs.refundRatePct}% of finished runs)
            </p>
            <p>
              Full-auto {runs.fullAuto} · review gate {runs.reviewGate}
            </p>
            <p>{runs.activeUsers} users ran an arm in the window</p>
          </div>
        </Card>

        <Card>
          <SectionTitle>Why runs failed</SectionTitle>
          {errors.length === 0 ? (
            <Empty>No failures recorded in the window.</Empty>
          ) : (
            <ul className="space-y-2.5">
              {errors.map((bucket) => (
                <li key={bucket.code}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-[11px] text-slate-300">{bucket.code}</span>
                    <span className="text-xs font-medium text-slate-400">{bucket.count}</span>
                  </div>
                  <p className="text-xs text-slate-500">{bucket.meaning}</p>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <SectionTitle>Application pipeline</SectionTitle>
          <div className="space-y-1.5">
            {APPLICATION_STATUSES.filter(
              (status: ApplicationStatus) => (apps.byStatus[status] ?? 0) > 0
            ).map((status: ApplicationStatus) => (
              <div key={status} className="flex items-center justify-between text-xs">
                <span className="text-slate-300">{STATUS_LABELS[status]}</span>
                <span className="font-medium text-slate-400">{apps.byStatus[status]}</span>
              </div>
            ))}
            {apps.total === 0 && <Empty>No applications yet.</Empty>}
          </div>
          <div className="mt-4 space-y-1 border-t border-ink-800 pt-4 text-xs text-slate-500">
            <p>
              {apps.total} total · {apps.applied} applied
            </p>
            <p>
              {apps.fromArm} by arm · {apps.fromManual} tracked manually
            </p>
            <p>
              {apps.activatedUsers} of {users.total} users activated (
              {pct(apps.activatedUsers, users.total)}%)
            </p>
          </div>
        </Card>
      </div>

      {/* AI + catalog */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <SectionTitle right={<Badge tone="neutral">this month</Badge>}>AI calls</SectionTitle>
          <div className="space-y-1.5">
            {AI_CALL_KINDS.map((kind) => (
              <div key={kind} className="flex items-center justify-between text-xs">
                <span className="text-slate-300">{KIND_LABELS[kind]}</span>
                <span className="font-medium text-slate-400">{ai.byKind[kind]}</span>
              </div>
            ))}
          </div>
          <p className="mt-4 border-t border-ink-800 pt-4 text-xs text-slate-500">
            {ai.total} metered calls across {ai.users} users
          </p>
        </Card>

        <Card>
          <SectionTitle
            right={
              catalogStale ? <Badge tone="warn">sweep stale</Badge> : <Badge tone="good">fresh</Badge>
            }
          >
            Job catalog
          </SectionTitle>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <p className="text-xs text-slate-500">Jobs</p>
              <p className="text-xl font-bold text-white">
                {snapshot.catalog.jobs.toLocaleString("en-US")}
              </p>
            </div>
            <div>
              <p className="text-xs text-slate-500">Added 24h</p>
              <p className="text-xl font-bold text-white">{snapshot.catalog.jobsAdded24h}</p>
            </div>
            <div>
              <p className="text-xs text-slate-500">Companies</p>
              <p className="text-xl font-bold text-white">{snapshot.catalog.companies}</p>
            </div>
          </div>
          <p className="mt-4 border-t border-ink-800 pt-4 text-xs text-slate-500">
            Newest job ingested {timeAgo(snapshot.catalog.newestJobAt, now)}
          </p>
        </Card>
      </div>

      {/* Operator worklists */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <SectionTitle>Runs needing attention</SectionTitle>
          {attention.length === 0 ? (
            <Empty>Nothing stuck or aging.</Empty>
          ) : (
            <Table
              head={
                <tr>
                  <th className="pb-2">User</th>
                  <th className="pb-2">Status</th>
                  <th className="pb-2 text-right">Age</th>
                </tr>
              }
            >
              {attention.map((run) => (
                <tr key={run.id}>
                  <td className="py-2">
                    <UserLink id={run.user_id} email={emailById.get(run.user_id) ?? ""} />
                  </td>
                  <td className="py-2">
                    <Badge tone={run.status === "needs_review" ? "warn" : "bad"}>
                      {run.status.replaceAll("_", " ")}
                    </Badge>
                  </td>
                  <td className="py-2 text-right text-slate-500">
                    {timeAgo(run.created_at, now)}
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        <Card>
          <SectionTitle>Quota pressure</SectionTitle>
          {pressure.length === 0 ? (
            <Empty>Nobody is near their arm-run cap.</Empty>
          ) : (
            <Table
              head={
                <tr>
                  <th className="pb-2">User</th>
                  <th className="pb-2">Plan</th>
                  <th className="pb-2 text-right">Used</th>
                </tr>
              }
            >
              {pressure.map((row) => (
                <tr key={row.userId}>
                  <td className="py-2">
                    <UserLink id={row.userId} email={row.email} />
                  </td>
                  <td className="py-2">
                    <Badge tone={row.plan === "free" ? "info" : "good"}>{row.plan}</Badge>
                  </td>
                  <td className="py-2 text-right text-slate-300">
                    {row.used} / {row.limit}
                    <span className="text-slate-600"> per {row.window}</span>
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </div>

      {/* Recent runs */}
      <Card>
        <SectionTitle>Latest runs</SectionTitle>
        {recentRuns.length === 0 ? (
          <Empty>No runs in the window.</Empty>
        ) : (
          <Table
            head={
              <tr>
                <th className="pb-2">User</th>
                <th className="pb-2">Status</th>
                <th className="pb-2">Mode</th>
                <th className="pb-2">Error</th>
                <th className="pb-2 text-right">Started</th>
              </tr>
            }
          >
            {recentRuns.map((run) => (
              <tr key={run.id}>
                <td className="py-2">
                  <UserLink id={run.user_id} email={emailById.get(run.user_id) ?? ""} />
                </td>
                <td className="py-2">
                  <Link href={`/admin/runs/${run.id}`}>
                    <Badge tone={runStatusTone(run.status)}>
                      {run.status.replaceAll("_", " ")}
                    </Badge>
                  </Link>
                </td>
                <td className="py-2 text-slate-500">{run.autonomy.replaceAll("_", " ")}</td>
                <td className="max-w-xs truncate py-2 text-slate-500">{run.error ?? "-"}</td>
                <td className="py-2 text-right text-slate-500">{timeAgo(run.created_at, now)}</td>
              </tr>
            ))}
          </Table>
        )}
        <p className="mt-4 text-xs text-slate-600">
          Metering counts successful runs only, and the worker refunds the slot when a run dies of a
          system failure. See{" "}
          <Link href="/admin/system" className="text-arm-300 hover:underline">
            system
          </Link>{" "}
          for configuration and the operator audit log.
        </p>
      </Card>
    </div>
  );
}
