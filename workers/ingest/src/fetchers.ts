/**
 * Public ATS JSON endpoints → normalized job rows. No auth needed; every
 * endpoint here is the same one the company's own public board calls.
 */

export interface NormalizedJob {
  url: string;
  ats: "greenhouse" | "lever" | "workday" | "ashby" | "workable";
  source: string;
  company: string;
  title: string;
  location: string;
  description: string;
}

const strip = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 20_000);

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15_000)
  });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

async function postJson(url: string, body: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000)
  });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

export async function fetchGreenhouse(company: string, board: string): Promise<NormalizedJob[]> {
  const body = (await getJson(
    `https://boards-api.greenhouse.io/v1/boards/${board}/jobs?content=true`
  )) as { jobs?: Array<{ id?: number; absolute_url?: string; title?: string; location?: { name?: string }; content?: string }> };
  return (body.jobs ?? [])
    .filter((j) => j.id || j.absolute_url)
    .map((j) => ({
      // Canonical hosted-board URL, NOT absolute_url: many companies point
      // absolute_url at their own careers site, which embeds the Greenhouse
      // form in an iframe the arm would have to chase. The hosted URL always
      // renders the form directly (and redirects to job-boards.greenhouse.io
      // for migrated boards).
      url: j.id ? `https://boards.greenhouse.io/${board}/jobs/${j.id}` : j.absolute_url!,
      ats: "greenhouse" as const,
      source: "ingest:greenhouse",
      company,
      title: j.title ?? "",
      location: j.location?.name ?? "",
      description: strip(j.content ?? "")
    }));
}

export async function fetchLever(company: string, slug: string): Promise<NormalizedJob[]> {
  const body = (await getJson(`https://api.lever.co/v0/postings/${slug}?mode=json`)) as Array<{
    hostedUrl?: string;
    text?: string;
    categories?: { location?: string };
    descriptionPlain?: string;
  }>;
  return (Array.isArray(body) ? body : [])
    .filter((j) => j.hostedUrl)
    .map((j) => ({
      url: j.hostedUrl!,
      ats: "lever" as const,
      source: "ingest:lever",
      company,
      title: j.text ?? "",
      location: j.categories?.location ?? "",
      description: (j.descriptionPlain ?? "").slice(0, 20_000)
    }));
}

export async function fetchAshby(company: string, board: string): Promise<NormalizedJob[]> {
  const body = (await getJson(
    `https://api.ashbyhq.com/posting-api/job-board/${board}?includeCompensation=true`
  )) as { jobs?: Array<{ jobUrl?: string; title?: string; location?: string; descriptionPlain?: string }> };
  return (body.jobs ?? [])
    .filter((j) => j.jobUrl)
    .map((j) => ({
      url: j.jobUrl!,
      ats: "ashby" as const,
      source: "ingest:ashby",
      company,
      title: j.title ?? "",
      location: j.location ?? "",
      description: (j.descriptionPlain ?? "").slice(0, 20_000)
    }));
}

/** How many postings to pull per tenant sweep (Workday caps the page anyway). */
const WORKDAY_PAGE_LIMIT = 20;

/**
 * Workday postings for one tenant career site.
 *
 * `board` is `<tenant>.<cluster>/<site>`, e.g. `acme.wd1/Careers`, because a
 * Workday URL needs all three parts (tenant, cluster host, and site id) and the
 * companies list only carries one slug field.
 *
 * The Candidate Experience Service endpoint the career site itself calls. It is
 * undocumented but needs no auth on a public board. The listing response has no
 * descriptions, so rows land with title/location only; the description is filled
 * in by `fetchJobMeta` when a user actually tracks the job, which keeps a sweep
 * from making one extra request per posting.
 */
export async function fetchWorkday(company: string, board: string): Promise<NormalizedJob[]> {
  const [tenantPart, site] = board.split("/");
  if (!tenantPart || !site) return [];
  const host = `${tenantPart}.myworkdayjobs.com`;
  const tenant = tenantPart.split(".")[0];

  const body = (await postJson(`https://${host}/wday/cxs/${tenant}/${site}/jobs`, {
    appliedFacets: {},
    limit: WORKDAY_PAGE_LIMIT,
    offset: 0,
    searchText: ""
  })) as {
    jobPostings?: Array<{ title?: string; externalPath?: string; locationsText?: string }>;
  };

  return (body.jobPostings ?? [])
    .filter((j) => j.externalPath)
    .map((j) => ({
      // Canonical posting URL the arm can drive directly.
      url: `https://${host}/en-US/${site}/job${j.externalPath}`,
      ats: "workday" as const,
      source: "ingest:workday",
      company,
      title: j.title ?? "",
      location: j.locationsText ?? "",
      description: ""
    }));
}

export async function fetchWorkable(company: string, account: string): Promise<NormalizedJob[]> {
  const body = (await getJson(
    `https://apply.workable.com/api/v1/widget/accounts/${account}?details=true`
  )) as { jobs?: Array<{ url?: string; shortlink?: string; title?: string; city?: string; country?: string; description?: string }> };
  return (body.jobs ?? [])
    .filter((j) => j.url || j.shortlink)
    .map((j) => ({
      url: (j.url ?? j.shortlink)!,
      ats: "workable" as const,
      source: "ingest:workable",
      company,
      title: j.title ?? "",
      location: [j.city, j.country].filter(Boolean).join(", "),
      description: strip(j.description ?? "")
    }));
}
