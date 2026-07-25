import Link from "next/link";
import { loadAuthDirectory, loadFleetSnapshot, RUN_WINDOW_DAYS } from "@/lib/admin/reads";
import {
  buildUserRows,
  filterUserRows,
  isUserSort,
  sortUserRows,
  type AdminUserRow,
  type EngagementSegment
} from "@/lib/admin/users-table";
import { pct } from "@/lib/admin/overview";
import {
  Badge,
  Card,
  Empty,
  PageHeading,
  SectionTitle,
  Stat,
  Table,
  timeAgo,
  type BadgeTone
} from "@/components/admin/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Admin users", robots: { index: false, follow: false } };

const SEGMENT_TONE: Record<EngagementSegment, BadgeTone> = {
  active: "good",
  new: "info",
  cooling: "warn",
  quiet: "bad"
};

const SORTS: { key: string; label: string }[] = [
  { key: "newest", label: "Newest" },
  { key: "email", label: "Email" },
  { key: "plan", label: "Plan" },
  { key: "runs", label: "Runs" },
  { key: "applied", label: "Applied" },
  { key: "quota", label: "Quota" }
];

function planTone(plan: string): BadgeTone {
  if (plan === "max") return "warn";
  if (plan === "premium") return "good";
  return "info";
}

export default async function AdminUsersPage({
  searchParams
}: {
  searchParams: Promise<{ sort?: string; q?: string }>;
}) {
  const { sort: sortParam, q } = await searchParams;
  const sort = isUserSort(sortParam) ? sortParam : "newest";
  const term = (q ?? "").slice(0, 100);

  const now = new Date();
  const [snapshot, directory] = await Promise.all([loadFleetSnapshot(now), loadAuthDirectory()]);
  const all = buildUserRows(
    {
      profiles: snapshot.profiles,
      subscriptions: snapshot.subscriptions,
      applications: snapshot.applications,
      runs: snapshot.runs,
      aiUsage: snapshot.aiUsage,
      quotaUsage: snapshot.quotaUsage,
      authDirectory: directory.byId
    },
    now
  );
  const rows = sortUserRows(filterUserRows(all, term), sort);

  const paying = all.filter((row: AdminUserRow) => row.plan !== "free").length;
  const activated = all.filter((row: AdminUserRow) => row.applications > 0).length;
  const quiet = all.filter((row: AdminUserRow) => row.segment === "quiet").length;

  return (
    <div className="space-y-6">
      <PageHeading
        title="Users"
        subtitle={`${all.length} accounts. Run and application counts cover the last ${RUN_WINDOW_DAYS} days.`}
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Accounts" value={all.length} />
        <Stat
          label="Paying"
          value={paying}
          tone={paying > 0 ? "good" : "neutral"}
          hint={`${pct(paying, all.length)}% of accounts`}
        />
        <Stat
          label="Activated"
          value={activated}
          hint={`${pct(activated, all.length)}% have an application`}
        />
        <Stat
          label="Quiet"
          value={quiet}
          tone={quiet > 0 ? "warn" : "neutral"}
          hint="no sign-in in 45 days"
        />
      </div>

      <Card>
        <SectionTitle
          right={
            <div className="flex flex-wrap items-center gap-1">
              {SORTS.map((option) => (
                <Link
                  key={option.key}
                  href={`/admin/users?sort=${option.key}${term ? `&q=${encodeURIComponent(term)}` : ""}`}
                  className={`rounded-lg px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.1em] ${
                    option.key === sort
                      ? "bg-arm-500/15 text-arm-300"
                      : "text-slate-500 hover:text-slate-300"
                  }`}
                >
                  {option.label}
                </Link>
              ))}
            </div>
          }
        >
          All accounts
        </SectionTitle>

        {/* A plain GET form: filtering needs no client JavaScript, and the URL
            stays shareable between operators. */}
        <form method="get" className="mb-4 flex gap-2">
          <input type="hidden" name="sort" value={sort} />
          <input
            name="q"
            defaultValue={term}
            placeholder="Filter by email, id, plan, or segment"
            className="w-full max-w-sm rounded-lg border border-ink-700 bg-ink-950 px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:border-arm-400 focus:outline-none"
          />
          <button
            type="submit"
            className="rounded-lg border border-ink-700 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.12em] text-slate-300 hover:border-arm-500 hover:text-arm-300"
          >
            Filter
          </button>
          {term && (
            <Link
              href={`/admin/users?sort=${sort}`}
              className="rounded-lg px-3 py-2 font-mono text-[10px] uppercase tracking-[0.12em] text-slate-500 hover:text-slate-300"
            >
              Clear
            </Link>
          )}
        </form>

        {rows.length === 0 ? (
          <Empty>{term ? "No accounts match that filter." : "No accounts yet."}</Empty>
        ) : (
          <Table
            head={
              <tr>
                <th className="pb-2">User</th>
                <th className="pb-2">Plan</th>
                <th className="pb-2">Engagement</th>
                <th className="pb-2 text-right">Quota</th>
                <th className="pb-2 text-right">Runs</th>
                <th className="pb-2 text-right">Success</th>
                <th className="pb-2 text-right">Apps</th>
                <th className="pb-2 text-right">AI</th>
                <th className="pb-2 text-right">Joined</th>
              </tr>
            }
          >
            {rows.map((row) => (
              <tr key={row.id} className="hover:bg-ink-800/40">
                <td className="py-2">
                  <Link
                    href={`/admin/users/${row.id}`}
                    className="font-medium text-slate-200 hover:text-arm-300"
                  >
                    {row.email || row.id.slice(0, 8)}
                  </Link>
                  <div className="flex gap-1.5 pt-0.5 text-[10px] text-slate-600">
                    {!row.onboardingComplete && <span>onboarding incomplete</span>}
                    {row.autonomy === "full_auto" && <span>full-auto</span>}
                    {row.cancelAtPeriodEnd && <span className="text-amber-400">canceling</span>}
                  </div>
                </td>
                <td className="py-2">
                  <Badge tone={planTone(row.plan)}>{row.plan}</Badge>
                  <span className="pl-1.5 text-[10px] text-slate-600">
                    {row.subscriptionStatus.replaceAll("_", " ")}
                  </span>
                </td>
                <td className="py-2">
                  <Badge tone={SEGMENT_TONE[row.segment]}>{row.segment}</Badge>
                  <span className="pl-1.5 text-[10px] text-slate-600">
                    {timeAgo(row.lastSignInAt, now)}
                  </span>
                </td>
                <td className="py-2 text-right">
                  <span className={row.quotaPct >= 80 ? "text-amber-300" : "text-slate-300"}>
                    {row.quotaUsed}/{row.quotaLimit}
                  </span>
                </td>
                <td className="py-2 text-right text-slate-300">{row.runs}</td>
                <td className="py-2 text-right text-slate-300">
                  {row.successRatePct === null ? "-" : `${row.successRatePct}%`}
                </td>
                <td className="py-2 text-right text-slate-300">
                  {row.applications}
                  <span className="text-slate-600"> / {row.applied} applied</span>
                </td>
                <td className="py-2 text-right text-slate-300">{row.aiCalls}</td>
                <td className="py-2 text-right text-slate-500">{timeAgo(row.createdAt, now)}</td>
              </tr>
            ))}
          </Table>
        )}

        {directory.clipped && (
          <p className="mt-4 text-xs text-amber-300">
            The auth directory scan was truncated, so sign-in recency and engagement may be missing
            for some accounts.
          </p>
        )}
      </Card>
    </div>
  );
}
