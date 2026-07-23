/**
 * Public ATS JSON endpoints → normalized job rows. No auth needed; every
 * endpoint here is the same one the company's own public board calls.
 */

export interface NormalizedJob {
  url: string;
  ats: "greenhouse" | "lever" | "ashby" | "workable";
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

export async function fetchGreenhouse(company: string, board: string): Promise<NormalizedJob[]> {
  const body = (await getJson(
    `https://boards-api.greenhouse.io/v1/boards/${board}/jobs?content=true`
  )) as { jobs?: Array<{ absolute_url?: string; title?: string; location?: { name?: string }; content?: string }> };
  return (body.jobs ?? [])
    .filter((j) => j.absolute_url)
    .map((j) => ({
      url: j.absolute_url!,
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
