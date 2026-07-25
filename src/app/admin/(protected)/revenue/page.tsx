import { loadProfiles, loadSpendEvents, loadSubscriptions, SPEND_WINDOW_DAYS } from "@/lib/admin/reads";
import {
  conversionStats,
  mrrTrend,
  paymentProblems,
  revenueBreakdown
} from "@/lib/admin/revenue";
import { formatCents } from "@/lib/admin/overview";
import { formatMicros } from "@/lib/ai-cost";
import { totalSpend } from "@/lib/admin/spend";
import {
  Badge,
  BarChart,
  Card,
  Empty,
  MeterRow,
  PageHeading,
  SectionTitle,
  Stat,
  Table,
  timeAgo,
  UserLink
} from "@/components/admin/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Admin revenue", robots: { index: false, follow: false } };

export default async function AdminRevenuePage() {
  const now = new Date();
  const [profiles, subscriptions, spend] = await Promise.all([
    loadProfiles(),
    loadSubscriptions(),
    loadSpendEvents(SPEND_WINDOW_DAYS, now)
  ]);

  const revenue = revenueBreakdown(profiles, subscriptions);
  const conversion = conversionStats(profiles, subscriptions);
  const trend = mrrTrend(profiles, subscriptions, 6, now);
  const problems = paymentProblems(profiles, subscriptions);
  const modelSpend = totalSpend(spend);

  // Monthly revenue against the trailing 30 days of model spend. Not a P&L: it
  // ignores infrastructure, and the two windows are only approximately the same.
  const grossMarginCents = revenue.totalCents - Math.round(modelSpend.costMicros / 10_000);

  return (
    <div className="space-y-6">
      <PageHeading
        title="Revenue"
        subtitle="What the platform earns, who is paying, and what is going wrong with billing."
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat
          label="MRR"
          value={formatCents(revenue.totalCents)}
          hint={`${revenue.payingUsers} paying · ${formatCents(revenue.arpuCents)} each`}
        />
        <Stat
          label="Conversion"
          value={`${conversion.conversionRatePct}%`}
          hint={
            conversion.medianDaysToConvert === null
              ? `${conversion.converted} of ${conversion.signups} signups`
              : `median ${conversion.medianDaysToConvert}d to convert`
          }
        />
        <Stat
          label="Pending churn"
          value={formatCents(revenue.pendingChurnCents)}
          tone={revenue.pendingChurnCents > 0 ? "warn" : "neutral"}
          hint={`${revenue.pendingChurnUsers} canceling at period end`}
        />
        <Stat
          label="After model cost"
          value={formatCents(grossMarginCents)}
          tone={grossMarginCents >= 0 ? "good" : "bad"}
          hint={`${formatMicros(modelSpend.costMicros)} of AI in ${SPEND_WINDOW_DAYS}d`}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <SectionTitle>MRR by month, reconstructed</SectionTitle>
          <BarChart
            points={trend.map((point) => ({
              label: point.label,
              count: Math.round(point.cents / 100)
            }))}
          />
          <p className="mt-2 text-xs text-slate-600">
            Bars are dollars. This is reconstructed from when each paying subscription row was
            created, and the subscriptions table keeps one row per user, so a cancel-and-resubscribe
            or a plan change leaves no trace. Treat it as an operator health metric, not a billing
            report.
          </p>
        </Card>

        <Card>
          <SectionTitle>Where revenue comes from</SectionTitle>
          <div className="space-y-3">
            <MeterRow
              label="premium"
              count={revenue.byPlan.premium.cents}
              total={revenue.totalCents}
              tone="good"
            />
            <MeterRow
              label="max"
              count={revenue.byPlan.max.cents}
              total={revenue.totalCents}
              tone="warn"
            />
          </div>
          <div className="mt-5 space-y-2 border-t border-ink-800 pt-4 text-xs">
            <div className="flex justify-between">
              <span className="text-slate-400">Premium</span>
              <span className="text-slate-300">
                {revenue.byPlan.premium.users} · {formatCents(revenue.byPlan.premium.cents)}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">Max</span>
              <span className="text-slate-300">
                {revenue.byPlan.max.users} · {formatCents(revenue.byPlan.max.cents)}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">Free</span>
              <span className="text-slate-300">{revenue.byPlan.free.users} accounts</span>
            </div>
          </div>
        </Card>
      </div>

      <Card>
        <SectionTitle
          right={
            problems.length > 0 ? <Badge tone="bad">{problems.length} to fix</Badge> : undefined
          }
        >
          Billing problems
        </SectionTitle>
        {problems.length === 0 ? (
          <Empty>No failed or stuck payments.</Empty>
        ) : (
          <Table
            head={
              <tr>
                <th className="pb-2">User</th>
                <th className="pb-2">Status</th>
                <th className="pb-2">Row says</th>
                <th className="pb-2">Actually gets</th>
                <th className="pb-2 text-right">Since</th>
              </tr>
            }
          >
            {problems.map((problem) => (
              <tr key={problem.userId}>
                <td className="py-2">
                  <UserLink id={problem.userId} email={problem.email} />
                </td>
                <td className="py-2">
                  <Badge tone="bad">{problem.status.replaceAll("_", " ")}</Badge>
                </td>
                <td className="py-2 text-slate-500">{problem.recordedPlan}</td>
                <td className="py-2 text-slate-300">{problem.grantedPlan}</td>
                <td className="py-2 text-right text-slate-500">
                  {timeAgo(problem.updatedAt, now)}
                </td>
              </tr>
            ))}
          </Table>
        )}
        <p className="mt-3 text-xs text-slate-600">
          A past_due row still records the paid plan but the gate has already dropped the account to
          free, so these users are locked out right now. That is deliberate (no dunning grace) and
          resolves itself the moment Stripe collects, but it is also the support ticket you are
          about to get.
        </p>
      </Card>
    </div>
  );
}
