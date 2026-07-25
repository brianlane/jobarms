/**
 * Job-catalog and ingestion health. Pure: rows in, numbers out.
 *
 * The catalog is the top of the funnel: if the cron stops sweeping or a board
 * quietly starts returning nothing, Discover goes stale and nobody notices from
 * the product side, because the jobs that ARE there still look fine.
 */

/** Every ATS the catalog can hold (the jobs table check constraint). */
import { pct } from "@/lib/admin/overview";

export const CATALOG_ATS = ["greenhouse", "lever", "ashby", "workable", "workday", "unknown"] as const;

/** Where a job came from. `manual` means a user pasted the link themselves. */
export const CATALOG_SOURCES = [
  "manual",
  "ingest:greenhouse",
  "ingest:lever",
  "ingest:ashby",
  "ingest:workable",
  "ingest:workday"
] as const;

export interface CatalogJobRow {
  ats: string;
  source: string;
  company: string;
  created_at: string;
}

export interface CompanyRow {
  id: string;
  name: string;
  ats: string;
  board_token: string;
  active: boolean;
  last_ingested_at: string | null;
  created_at: string;
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * A board is stale when the cron has not touched it recently. The sweep runs
 * twice an hour, so a whole day of silence on an ACTIVE company means the board
 * is failing rather than quiet.
 */
export const COMPANY_STALE_HOURS = 24;

export interface CompanyView extends CompanyRow {
  stale: boolean;
  /** Jobs this company contributed inside the read window. */
  jobsInWindow: number;
}

export function viewCompanies(
  companies: CompanyRow[],
  recentJobs: CatalogJobRow[],
  now: Date = new Date()
): CompanyView[] {
  const jobsByCompany = new Map<string, number>();
  for (const job of recentJobs) {
    const key = job.company.trim().toLowerCase();
    if (!key) continue;
    jobsByCompany.set(key, (jobsByCompany.get(key) ?? 0) + 1);
  }

  return companies
    .map((company) => {
      const at = company.last_ingested_at ? Date.parse(company.last_ingested_at) : NaN;
      const stale =
        company.active && (!Number.isFinite(at) || now.getTime() - at > COMPANY_STALE_HOURS * HOUR_MS);
      return {
        ...company,
        stale,
        jobsInWindow: jobsByCompany.get(company.name.trim().toLowerCase()) ?? 0
      };
    })
    .sort((a, b) => {
      if (a.stale !== b.stale) return a.stale ? -1 : 1;
      return b.jobsInWindow - a.jobsInWindow;
    });
}

export interface DayPoint {
  label: string;
  count: number;
}

/** Jobs added per day, oldest first, with empty days included. */
export function jobsPerDay(
  jobs: CatalogJobRow[],
  days: number,
  now: Date = new Date()
): DayPoint[] {
  const counts = new Map<string, number>();
  for (const job of jobs) {
    const at = Date.parse(job.created_at);
    if (!Number.isFinite(at)) continue;
    const key = new Date(at).toISOString().slice(0, 10);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const series: DayPoint[] = [];
  for (let back = days - 1; back >= 0; back -= 1) {
    const key = new Date(now.getTime() - back * 24 * HOUR_MS).toISOString().slice(0, 10);
    series.push({ label: key.slice(5), count: counts.get(key) ?? 0 });
  }
  return series;
}

export interface MixRow {
  key: string;
  count: number;
  sharePct: number;
}

export function mixBy(
  jobs: CatalogJobRow[],
  field: "ats" | "source"
): MixRow[] {
  const counts = new Map<string, number>();
  for (const job of jobs) {
    const key = job[field] || "unknown";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const total = jobs.length;
  return [...counts.entries()]
    .map(([key, count]) => ({
      key,
      count,
      sharePct: pct(count, total)
    }))
    .sort((a, b) => b.count - a.count);
}

export interface SourceFreshness {
  source: string;
  newestAt: string | null;
  stale: boolean;
}

/**
 * When each source last produced a job. A source that has never produced one in
 * the window reports null, which is different from "produced one an hour ago"
 * and different again from a source we do not sweep at all.
 */
export function sourceFreshness(
  jobs: CatalogJobRow[],
  now: Date = new Date(),
  staleHours = COMPANY_STALE_HOURS
): SourceFreshness[] {
  const newest = new Map<string, number>();
  for (const job of jobs) {
    const at = Date.parse(job.created_at);
    if (!Number.isFinite(at)) continue;
    const current = newest.get(job.source) ?? 0;
    if (at > current) newest.set(job.source, at);
  }

  return [...new Set([...CATALOG_SOURCES, ...newest.keys()])].map((source) => {
    const at = newest.get(source);
    return {
      source,
      newestAt: at ? new Date(at).toISOString() : null,
      stale: !at || now.getTime() - at > staleHours * HOUR_MS
    };
  });
}

export interface DiscoveryAttribution {
  total: number;
  fromCatalog: number;
  fromPasted: number;
  catalogSharePct: number;
}

/**
 * Is the catalog earning its keep? An application against a job whose source
 * starts with `ingest:` came from Discover; a `manual` job is one the user
 * pasted. That distinction is what says whether ingestion drives applications or
 * just fills a table.
 */
export function discoveryAttribution(
  applications: { jobs: { source: string } | null }[]
): DiscoveryAttribution {
  let fromCatalog = 0;
  let fromPasted = 0;
  for (const app of applications) {
    if ((app.jobs?.source ?? "manual").startsWith("ingest:")) fromCatalog += 1;
    else fromPasted += 1;
  }
  const total = fromCatalog + fromPasted;
  return {
    total,
    fromCatalog,
    fromPasted,
    catalogSharePct: total > 0 ? Math.round((fromCatalog / total) * 100) : 0
  };
}
