import {
  CATALOG_WINDOW_DAYS,
  loadApplicationSources,
  loadCatalogSummary,
  loadCompanies,
  loadRecentJobs
} from "@/lib/admin/reads";
import {
  COMPANY_STALE_HOURS,
  discoveryAttribution,
  jobsPerDay,
  mixBy,
  sourceFreshness,
  viewCompanies
} from "@/lib/admin/catalog";
import { ingestStale } from "@/lib/admin/overview";
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
  timeAgo
} from "@/components/admin/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Admin catalog", robots: { index: false, follow: false } };

export default async function AdminCatalogPage() {
  const now = new Date();
  const [summary, companies, recentJobs, applications] = await Promise.all([
    loadCatalogSummary(now),
    loadCompanies(),
    loadRecentJobs(CATALOG_WINDOW_DAYS, now),
    loadApplicationSources()
  ]);

  const companyViews = viewCompanies(companies, recentJobs, now);
  const staleCompanies = companyViews.filter((company) => company.stale);
  const daily = jobsPerDay(recentJobs, CATALOG_WINDOW_DAYS, now);
  const atsMix = mixBy(recentJobs, "ats");
  const freshness = sourceFreshness(recentJobs, now);
  const attribution = discoveryAttribution(applications);
  const sweepStale = ingestStale(summary.newestJobAt, now);

  return (
    <div className="space-y-6">
      <PageHeading
        title="Job catalog"
        subtitle={`Ingestion health. Mix and per-company activity cover the last ${CATALOG_WINDOW_DAYS} days; totals are the whole catalog.`}
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat
          label="Jobs"
          value={summary.jobs.toLocaleString("en-US")}
          hint={`${summary.jobsAdded24h} added in 24h`}
        />
        <Stat
          label="Last sweep"
          value={timeAgo(summary.newestJobAt, now)}
          tone={sweepStale ? "warn" : "good"}
          hint={sweepStale ? "the cron may be stalled" : "cron is producing"}
        />
        <Stat
          label="Boards tracked"
          value={companies.length}
          hint={`${companies.filter((company) => company.active).length} active`}
        />
        <Stat
          label="Stale boards"
          value={staleCompanies.length}
          tone={staleCompanies.length > 0 ? "warn" : "good"}
          hint={`no sweep in ${COMPANY_STALE_HOURS}h`}
        />
      </div>

      <Card>
        <SectionTitle>Jobs added per day</SectionTitle>
        <BarChart points={daily} />
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <SectionTitle>Platform mix, this window</SectionTitle>
          {atsMix.length === 0 ? (
            <Empty>No jobs ingested in the window.</Empty>
          ) : (
            <div className="space-y-3">
              {atsMix.map((row) => (
                <MeterRow
                  key={row.key}
                  label={row.key}
                  count={row.count}
                  total={recentJobs.length}
                  tone="info"
                />
              ))}
            </div>
          )}
          <p className="mt-4 border-t border-ink-800 pt-4 text-xs text-slate-600">
            The arm can only apply where an adapter exists. A platform with a growing share of the
            catalog and no adapter is a signal about what to build next.
          </p>
        </Card>

        <Card>
          <SectionTitle>Source freshness</SectionTitle>
          <Table
            head={
              <tr>
                <th className="pb-2">Source</th>
                <th className="pb-2">Newest job</th>
                <th className="pb-2 text-right">State</th>
              </tr>
            }
          >
            {freshness.map((source) => (
              <tr key={source.source}>
                <td className="py-2 font-mono text-[11px] text-slate-300">{source.source}</td>
                <td className="py-2 text-slate-500">
                  {source.newestAt ? timeAgo(source.newestAt, now) : "nothing in the window"}
                </td>
                <td className="py-2 text-right">
                  <Badge tone={source.stale ? "warn" : "good"}>
                    {source.stale ? "quiet" : "producing"}
                  </Badge>
                </td>
              </tr>
            ))}
          </Table>
          <p className="mt-3 text-xs text-slate-600">
            Quiet is not automatically broken: `manual` only produces when a user pastes a link, and
            a board with no new postings is genuinely quiet.
          </p>
        </Card>
      </div>

      <Card>
        <SectionTitle
          right={
            <span className="text-xs text-slate-600">
              {attribution.catalogSharePct}% of applications came from the catalog
            </span>
          }
        >
          Is the catalog earning its keep?
        </SectionTitle>
        <div className="grid grid-cols-3 gap-4">
          <div>
            <p className="text-xs text-slate-500">From Discover</p>
            <p className="text-xl font-bold text-teal-300">{attribution.fromCatalog}</p>
          </div>
          <div>
            <p className="text-xs text-slate-500">Pasted by hand</p>
            <p className="text-xl font-bold text-white">{attribution.fromPasted}</p>
          </div>
          <div>
            <p className="text-xs text-slate-500">Applications</p>
            <p className="text-xl font-bold text-white">{attribution.total}</p>
          </div>
        </div>
        <p className="mt-4 border-t border-ink-800 pt-4 text-xs text-slate-600">
          An application counts as coming from the catalog when the job behind it was ingested rather
          than pasted. Thousands of ingested jobs that nobody applies to are a cost, not an asset.
        </p>
      </Card>

      <Card>
        <SectionTitle
          right={
            staleCompanies.length > 0 ? (
              <Badge tone="warn">{staleCompanies.length} stale</Badge>
            ) : undefined
          }
        >
          Tracked boards ({companies.length})
        </SectionTitle>
        {companyViews.length === 0 ? (
          <Empty>No companies seeded. Run scripts/oneshot/seed-companies.ts.</Empty>
        ) : (
          <Table
            head={
              <tr>
                <th className="pb-2">Company</th>
                <th className="pb-2">ATS</th>
                <th className="pb-2">Board token</th>
                <th className="pb-2 text-right">Jobs in window</th>
                <th className="pb-2 text-right">Last swept</th>
              </tr>
            }
          >
            {companyViews.map((company) => (
              <tr key={company.id}>
                <td className="py-2 text-slate-300">
                  {company.name}
                  {!company.active && (
                    <span className="pl-1.5">
                      <Badge tone="neutral">paused</Badge>
                    </span>
                  )}
                  {company.stale && (
                    <span className="pl-1.5">
                      <Badge tone="warn">stale</Badge>
                    </span>
                  )}
                </td>
                <td className="py-2 text-slate-500">{company.ats}</td>
                <td className="py-2 font-mono text-[10px] text-slate-600">
                  {company.board_token}
                </td>
                <td className="py-2 text-right text-slate-300">{company.jobsInWindow}</td>
                <td className="py-2 text-right text-slate-500">
                  {timeAgo(company.last_ingested_at, now)}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
