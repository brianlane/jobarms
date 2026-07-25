import { loadFieldStats, loadPlaybooks, loadRunsWithJobs, RUN_WINDOW_DAYS } from "@/lib/admin/reads";
import {
  summarizeAtsHealth,
  viewFieldStats,
  viewPlaybooks,
  type AtsRunRow
} from "@/lib/admin/ats-health";
import { lessonsFromStats } from "@/lib/answer-memory";
import { RUN_ERROR_MEANING } from "@/lib/admin/run-stats";
import {
  Badge,
  Card,
  Empty,
  PageHeading,
  SectionTitle,
  Stat,
  Table,
  timeAgo
} from "@/components/admin/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Admin ATS health", robots: { index: false, follow: false } };

const FIELD_ROWS_SHOWN = 40;

export default async function AdminAtsPage() {
  const now = new Date();
  const [runs, playbooks, fieldStats] = await Promise.all([
    loadRunsWithJobs(RUN_WINDOW_DAYS, now),
    loadPlaybooks(),
    loadFieldStats()
  ]);

  const health = summarizeAtsHealth(
    runs.map(
      (run): AtsRunRow => ({
        status: run.status,
        error: run.error,
        autonomy: run.autonomy,
        ats: run.applications?.jobs?.ats ?? "unknown"
      })
    )
  );
  const books = viewPlaybooks(playbooks);
  const decaying = books.filter((book) => book.decaying);

  // The guidance set comes from the SAME function the dispatch path calls, so
  // this page shows what the arm is actually being told rather than a second
  // reading of the thresholds.
  const guidingKeys = new Set(lessonsFromStats(fieldStats, Number.MAX_SAFE_INTEGER).map((l) => l.question_key));
  const fields = viewFieldStats(fieldStats, guidingKeys);

  return (
    <div className="space-y-6">
      <PageHeading
        title="ATS health"
        subtitle={`How the arm performs per platform, what it has learned to do, and where it is losing. Runs cover the last ${RUN_WINDOW_DAYS} days.`}
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Platforms seen" value={health.length} />
        <Stat label="Playbooks" value={books.length} hint="learned per-domain fixes" />
        <Stat
          label="Decaying playbooks"
          value={decaying.length}
          tone={decaying.length > 0 ? "warn" : "good"}
          hint="failing more than working"
        />
        <Stat
          label="Guiding questions"
          value={guidingKeys.size}
          hint={`of ${fieldStats.length} tracked`}
        />
      </div>

      <Card>
        <SectionTitle>Per platform</SectionTitle>
        {health.length === 0 ? (
          <Empty>No runs in the window.</Empty>
        ) : (
          <Table
            head={
              <tr>
                <th className="pb-2">ATS</th>
                <th className="pb-2 text-right">Runs</th>
                <th className="pb-2 text-right">Submitted</th>
                <th className="pb-2 text-right">Failed</th>
                <th className="pb-2 text-right">Canceled</th>
                <th className="pb-2 text-right">Success</th>
                <th className="pb-2">Biggest problem</th>
              </tr>
            }
          >
            {health.map((row) => (
              <tr key={row.ats}>
                <td className="py-2 text-slate-300">{row.ats}</td>
                <td className="py-2 text-right text-slate-300">{row.runs}</td>
                <td className="py-2 text-right text-teal-300">{row.submitted}</td>
                <td className="py-2 text-right text-red-300">{row.failed}</td>
                <td className="py-2 text-right text-slate-500">{row.canceled}</td>
                <td className="py-2 text-right">
                  {row.successRatePct === null ? (
                    <span className="text-slate-600">-</span>
                  ) : (
                    <span
                      className={row.successRatePct >= 50 ? "text-teal-300" : "text-amber-300"}
                    >
                      {row.successRatePct}%
                    </span>
                  )}
                </td>
                <td className="py-2 text-slate-500">
                  {row.topFailure ? (
                    <>
                      <span className="font-mono text-[11px] text-slate-400">
                        {row.topFailure}
                      </span>
                      <span className="text-slate-600"> ({row.topFailureCount})</span>
                    </>
                  ) : (
                    "-"
                  )}
                </td>
              </tr>
            ))}
          </Table>
        )}
        <p className="mt-3 text-xs text-slate-600">
          Success is submitted over finished runs, so a parked review is not counted against a
          platform. Failure buckets:{" "}
          {Object.entries(RUN_ERROR_MEANING)
            .filter(([code]) => code !== "none")
            .map(([code, meaning]) => `${code} (${meaning})`)
            .join(", ")}
          .
        </p>
      </Card>

      <Card>
        <SectionTitle
          right={
            decaying.length > 0 ? (
              <Badge tone="warn">{decaying.length} decaying</Badge>
            ) : undefined
          }
        >
          Self-healing playbooks
        </SectionTitle>
        {books.length === 0 ? (
          <Empty>
            No playbooks yet. One is recorded the first time vision recovery finds a form the normal
            path missed.
          </Empty>
        ) : (
          <Table
            head={
              <tr>
                <th className="pb-2">Domain</th>
                <th className="pb-2">ATS</th>
                <th className="pb-2">Learned fix</th>
                <th className="pb-2 text-right">Worked</th>
                <th className="pb-2 text-right">Failed</th>
                <th className="pb-2 text-right">Rate</th>
                <th className="pb-2 text-right">Last win</th>
              </tr>
            }
          >
            {books.map((book) => (
              <tr key={`${book.domain}-${book.ats}`}>
                <td className="py-2 font-mono text-[11px] text-slate-300">{book.domain}</td>
                <td className="py-2 text-slate-500">{book.ats}</td>
                <td className="py-2 text-slate-400">
                  {book.summary}
                  {book.decaying && (
                    <span className="pl-1.5">
                      <Badge tone="warn">decaying</Badge>
                    </span>
                  )}
                </td>
                <td className="py-2 text-right text-teal-300">{book.success_count}</td>
                <td className="py-2 text-right text-red-300">{book.failure_count}</td>
                <td className="py-2 text-right text-slate-300">{book.successRatePct}%</td>
                <td className="py-2 text-right text-slate-500">
                  {timeAgo(book.last_success_at, now)}
                </td>
              </tr>
            ))}
          </Table>
        )}
        <p className="mt-3 text-xs text-slate-600">
          A decaying playbook now fails more often than it works, so it costs runs an extra recovery
          attempt instead of saving them one. Those rows are the ones worth deleting so the arm
          rediscovers a working strategy.
        </p>
      </Card>

      <Card>
        <SectionTitle
          right={
            <span className="text-xs text-slate-600">
              showing {Math.min(fields.length, FIELD_ROWS_SHOWN)} of {fields.length}
            </span>
          }
        >
          What the platform has learned
        </SectionTitle>
        {fields.length === 0 ? (
          <Empty>Nothing aggregated yet. Field stats accumulate on review-gate approvals.</Empty>
        ) : (
          <Table
            head={
              <tr>
                <th className="pb-2">Question</th>
                <th className="pb-2">ATS</th>
                <th className="pb-2">Type</th>
                <th className="pb-2 text-right">Seen</th>
                <th className="pb-2 text-right">Skipped</th>
                <th className="pb-2 text-right">Edited</th>
                <th className="pb-2">Majority answer</th>
              </tr>
            }
          >
            {fields.slice(0, FIELD_ROWS_SHOWN).map((field) => (
              <tr key={`${field.ats}-${field.question_key}`}>
                <td className="max-w-xs py-2 text-slate-300">
                  <span className="truncate">{field.label_example || field.question_key}</span>
                  {field.guiding && (
                    <span className="pl-1.5">
                      <Badge tone="good">guiding</Badge>
                    </span>
                  )}
                </td>
                <td className="py-2 text-slate-500">{field.ats}</td>
                <td className="py-2 text-slate-600">{field.field_type}</td>
                <td className="py-2 text-right text-slate-300">{field.times_seen}</td>
                <td className="py-2 text-right text-slate-400">
                  {field.skipRatePct}%
                </td>
                <td className="py-2 text-right text-slate-400">{field.editRatePct}%</td>
                <td className="max-w-[12rem] truncate py-2 text-slate-400">
                  {field.topOption
                    ? `${field.topOption.value} (${field.topOption.sharePct}%)`
                    : "-"}
                </td>
              </tr>
            ))}
          </Table>
        )}
        <p className="mt-3 text-xs text-slate-600">
          Aggregates are anonymous and per platform, never per user. Sensitive topics are blocklisted
          from aggregation entirely, and free text is never aggregated across users. A question marked
          guiding currently clears the bar to become prompt guidance on every run for that platform:
          an option chosen in at least 60% of approvals with at least 3 observations, or a skip rate
          of 50% or more.
        </p>
      </Card>
    </div>
  );
}
