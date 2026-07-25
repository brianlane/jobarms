import {
  loadProfiles,
  loadRecentRuns,
  loadSpendEvents,
  loadSubscriptions,
  SPEND_WINDOW_DAYS
} from "@/lib/admin/reads";
import {
  spendByDay,
  spendByKind,
  spendByModel,
  spendByUser,
  totalSpend,
  unitEconomics
} from "@/lib/admin/spend";
import { CONFIGURED_MODELS, formatMicros } from "@/lib/ai-cost";
import { summarizeRuns } from "@/lib/admin/run-stats";
import {
  Badge,
  BarChart,
  Card,
  Empty,
  PageHeading,
  SectionTitle,
  Stat,
  Table,
  UserLink
} from "@/components/admin/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Admin AI spend", robots: { index: false, follow: false } };

const KIND_LABELS: Record<string, string> = {
  resume_parse: "Resume parses",
  tailor_resume: "Tailored resumes",
  cover_letter: "Cover letters",
  arm_answers: "Application answers",
  vision_recovery: "Vision recovery",
  captcha_vision: "Captcha solving"
};

const CHART_DAYS = 14;

export default async function AdminAiPage() {
  const now = new Date();
  const [events, profiles, subscriptions, runs] = await Promise.all([
    loadSpendEvents(SPEND_WINDOW_DAYS, now),
    loadProfiles(),
    loadSubscriptions(),
    loadRecentRuns(SPEND_WINDOW_DAYS, now)
  ]);

  const totals = totalSpend(events);
  const runSummary = summarizeRuns(runs, now);
  const economics = unitEconomics({ rows: events, submittedRuns: runSummary.submitted });
  const emailById = new Map(profiles.map((profile) => [profile.id, profile.email]));
  const byUser = spendByUser({ rows: events, emailById, subscriptions });
  const underwaterPaying = byUser.filter((row) => row.underwater && row.plan !== "free");
  const daily = spendByDay(events, CHART_DAYS, now);

  return (
    <div className="space-y-6">
      <PageHeading
        title="AI spend"
        subtitle={`Every model call in the last ${SPEND_WINDOW_DAYS} days, and what it cost.`}
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat
          label="Model spend"
          value={formatMicros(totals.costMicros)}
          hint={`${totals.calls.toLocaleString("en-US")} calls`}
        />
        <Stat
          label="Per application"
          value={
            economics.costPerSubmittedMicros === null
              ? "-"
              : formatMicros(economics.costPerSubmittedMicros)
          }
          hint={`${economics.submittedRuns} submitted`}
        />
        <Stat
          label="Per active user"
          value={
            economics.costPerActiveUserMicros === null
              ? "-"
              : formatMicros(economics.costPerActiveUserMicros)
          }
          hint={`${economics.activeUsers} users spent anything`}
        />
        <Stat
          label="Paying and underwater"
          value={underwaterPaying.length}
          tone={underwaterPaying.length > 0 ? "bad" : "good"}
          hint="cost exceeds what they pay"
        />
      </div>

      <Card>
        <SectionTitle
          right={
            <span className="text-xs text-slate-600">
              {totals.inputTokens.toLocaleString("en-US")} in ·{" "}
              {totals.outputTokens.toLocaleString("en-US")} out
            </span>
          }
        >
          Daily spend, last {CHART_DAYS} days
        </SectionTitle>
        <BarChart
          points={daily.map((day) => ({
            label: day.key.slice(5),
            count: Math.round(day.costMicros / 10_000)
          }))}
        />
        <p className="mt-2 text-xs text-slate-600">Bars are cents per day.</p>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <SectionTitle>By surface</SectionTitle>
          {events.length === 0 ? (
            <Empty>Nothing in the ledger yet.</Empty>
          ) : (
            <Table
              head={
                <tr>
                  <th className="pb-2">Surface</th>
                  <th className="pb-2 text-right">Calls</th>
                  <th className="pb-2 text-right">Tokens</th>
                  <th className="pb-2 text-right">Cost</th>
                </tr>
              }
            >
              {spendByKind(events).map((group) => (
                <tr key={group.key}>
                  <td className="py-2 text-slate-300">{KIND_LABELS[group.key] ?? group.key}</td>
                  <td className="py-2 text-right text-slate-400">{group.calls}</td>
                  <td className="py-2 text-right text-slate-500">
                    {(group.inputTokens + group.outputTokens).toLocaleString("en-US")}
                  </td>
                  <td className="py-2 text-right text-slate-300">
                    {formatMicros(group.costMicros)}
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        <Card>
          <SectionTitle
            right={
              totals.fallbackRatePct > 0 ? (
                <Badge tone="warn">{totals.fallbackRatePct}% fallback</Badge>
              ) : (
                <Badge tone="good">no fallback</Badge>
              )
            }
          >
            By model
          </SectionTitle>
          {events.length === 0 ? (
            <Empty>Nothing in the ledger yet.</Empty>
          ) : (
            <Table
              head={
                <tr>
                  <th className="pb-2">Model</th>
                  <th className="pb-2 text-right">Calls</th>
                  <th className="pb-2 text-right">Cost</th>
                </tr>
              }
            >
              {spendByModel(events).map((group) => (
                <tr key={group.key}>
                  <td className="py-2 font-mono text-[11px] text-slate-300">{group.key}</td>
                  <td className="py-2 text-right text-slate-400">{group.calls}</td>
                  <td className="py-2 text-right text-slate-300">
                    {formatMicros(group.costMicros)}
                  </td>
                </tr>
              ))}
            </Table>
          )}
          <p className="mt-3 text-xs text-slate-600">
            Configured primary is {CONFIGURED_MODELS.primary} with {CONFIGURED_MODELS.fallback} as
            the capacity fallback. A rising fallback share means the primary pool is congested, not
            that anything is broken.
          </p>
        </Card>
      </div>

      <Card>
        <SectionTitle
          right={
            underwaterPaying.length > 0 ? (
              <Badge tone="bad">{underwaterPaying.length} paying underwater</Badge>
            ) : undefined
          }
        >
          Cost by user
        </SectionTitle>
        {byUser.length === 0 ? (
          <Empty>No user-attributed spend in the window.</Empty>
        ) : (
          <Table
            head={
              <tr>
                <th className="pb-2">User</th>
                <th className="pb-2">Plan</th>
                <th className="pb-2 text-right">Calls</th>
                <th className="pb-2 text-right">Cost</th>
                <th className="pb-2 text-right">Pays</th>
                <th className="pb-2 text-right">Margin</th>
              </tr>
            }
          >
            {byUser.slice(0, 25).map((row) => (
              <tr key={row.userId}>
                <td className="py-2">
                  <UserLink id={row.userId} email={row.email} />
                </td>
                <td className="py-2">
                  <Badge tone={row.plan === "free" ? "info" : "good"}>{row.plan}</Badge>
                </td>
                <td className="py-2 text-right text-slate-400">{row.calls}</td>
                <td className="py-2 text-right text-slate-300">{formatMicros(row.costMicros)}</td>
                <td className="py-2 text-right text-slate-500">
                  {formatMicros(row.revenueMicros)}
                </td>
                <td className="py-2 text-right">
                  <span className={row.marginMicros >= 0 ? "text-teal-300" : "text-red-300"}>
                    {row.marginMicros < 0 ? "-" : ""}
                    {formatMicros(Math.abs(row.marginMicros))}
                  </span>
                </td>
              </tr>
            ))}
          </Table>
        )}
        <p className="mt-3 text-xs text-slate-600">
          A free user is underwater the moment they cost anything, which is what the free tier is
          for. A PAYING user underwater is the number worth watching.
          {totals.hasEstimatedPricing
            ? " Some calls were priced at the primary model rate because that model has no published rate here, which overestimates rather than flatters."
            : ""}
        </p>
      </Card>
    </div>
  );
}
