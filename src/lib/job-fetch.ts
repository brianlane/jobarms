import { detectAts, parseWorkdayUrl, type Ats } from "@/lib/ats";

/** Best-effort job metadata for the tracker, from public ATS APIs. */
export interface JobMeta {
  company: string;
  title: string;
  location: string;
  description: string;
  ats: Ats;
}

export function parseGreenhouseUrl(url: URL): { board: string; jobId: string } | null {
  // https://boards.greenhouse.io/<board>/jobs/<id> or job-boards.greenhouse.io
  const parts = url.pathname.split("/").filter(Boolean);
  const jobsIdx = parts.indexOf("jobs");
  if (jobsIdx > 0 && parts[jobsIdx + 1]) {
    return { board: parts[0], jobId: parts[jobsIdx + 1] };
  }
  const ghJid = url.searchParams.get("gh_jid");
  if (ghJid && parts[0]) return { board: parts[0], jobId: ghJid };
  return null;
}

export function parseLeverUrl(url: URL): { company: string; postingId: string } | null {
  // https://jobs.lever.co/<company>/<posting-uuid>[/apply]
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length >= 2) return { company: parts[0], postingId: parts[1] };
  return null;
}

export function parseAshbyUrl(url: URL): { org: string; jobId: string } | null {
  // https://jobs.ashbyhq.com/<org>/<job-uuid>[/application]
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length >= 2) return { org: parts[0], jobId: parts[1] };
  return null;
}

const DAYFORCE_LOCALE_RE = /^[a-z]{2}-[A-Za-z]{2}$/;

export function parseDayforceUrl(
  url: URL
): { tenant: string; site: string; locale: string; jobId: string } | null {
  // https://jobs.dayforcehcm.com/<locale>/<tenant>/<site>/jobs/<id>[/apply...]
  // The shape is exact: "jobs" is always the FOURTH segment. Requiring the
  // exact index (not just ">= 3") stops a deeper or reshaped path from being
  // misread as locale/tenant/site off the first three segments.
  const parts = url.pathname.split("/").filter(Boolean);
  const jobsIdx = parts.indexOf("jobs");
  if (jobsIdx !== 3 || !parts[jobsIdx + 1]) return null;
  const [locale, tenant, site] = parts;
  if (!DAYFORCE_LOCALE_RE.test(locale)) return null;
  return { tenant, site, locale, jobId: parts[jobsIdx + 1] };
}

const HTML_ENTITIES: Record<string, string> = {
  "&nbsp;": " ",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&#039;": "'",
  "&amp;": "&"
};

// Built from the keys so the pattern cannot drift from the table, which also
// means every match is guaranteed to have a replacement. None of `&`, `#`, or
// `;` is a regex metacharacter, so the keys need no escaping.
const HTML_ENTITY_PATTERN = new RegExp(Object.keys(HTML_ENTITIES).join("|"), "g");

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    // One pass over the entities, because decoding them in sequence lets an
    // earlier replacement feed the next one. Turning "&amp;" into "&" first
    // rewrote the literal text "&amp;lt;" into "<" instead of "&lt;".
    .replace(HTML_ENTITY_PATTERN, (entity) => HTML_ENTITIES[entity])
    .replace(/\s+/g, " ")
    .trim();
}

/** Fetch title/company/description from the public ATS JSON APIs. */
export async function fetchJobMeta(rawUrl: string): Promise<JobMeta> {
  const ats = detectAts(rawUrl);
  const fallback: JobMeta = { company: "", title: "", location: "", description: "", ats };
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return fallback;
  }

  try {
    if (ats === "greenhouse") {
      const parsed = parseGreenhouseUrl(url);
      if (!parsed) return fallback;
      const res = await fetch(
        `https://boards-api.greenhouse.io/v1/boards/${parsed.board}/jobs/${parsed.jobId}`,
        { signal: AbortSignal.timeout(10_000) }
      );
      if (!res.ok) return fallback;
      const job = (await res.json()) as {
        title?: string;
        location?: { name?: string };
        content?: string;
        company_name?: string;
      };
      return {
        company: job.company_name ?? parsed.board,
        title: job.title ?? "",
        location: job.location?.name ?? "",
        description: stripHtml(job.content ?? "").slice(0, 20_000),
        ats
      };
    }

    if (ats === "lever") {
      const parsed = parseLeverUrl(url);
      if (!parsed) return fallback;
      const res = await fetch(
        `https://api.lever.co/v0/postings/${parsed.company}/${parsed.postingId}`,
        { signal: AbortSignal.timeout(10_000) }
      );
      if (!res.ok) return fallback;
      const job = (await res.json()) as {
        text?: string;
        categories?: { location?: string };
        descriptionPlain?: string;
      };
      return {
        company: parsed.company,
        title: job.text ?? "",
        location: job.categories?.location ?? "",
        description: (job.descriptionPlain ?? "").slice(0, 20_000),
        ats
      };
    }

    if (ats === "ashby") {
      const parsed = parseAshbyUrl(url);
      if (!parsed) return fallback;
      // Ashby's posting API is board-wide (the same endpoint ingest polls);
      // there is no public single-posting endpoint, so match the job by the
      // UUID in the URL, which is the posting's `id`.
      const res = await fetch(`https://api.ashbyhq.com/posting-api/job-board/${parsed.org}`, {
        signal: AbortSignal.timeout(10_000)
      });
      if (!res.ok) return fallback;
      const body = (await res.json()) as {
        jobs?: Array<{ id?: string; title?: string; location?: string; descriptionPlain?: string }>;
      };
      const job = (body.jobs ?? []).find((j) => j.id === parsed.jobId);
      if (!job) return fallback;
      return {
        // The board API carries no organization name; the URL's org slug is
        // the best public identifier, same trade-off as Lever.
        company: decodeURIComponent(parsed.org),
        title: job.title ?? "",
        location: job.location ?? "",
        description: (job.descriptionPlain ?? "").slice(0, 20_000),
        ats
      };
    }

    if (ats === "dayforce") {
      const parsed = parseDayforceUrl(url);
      if (!parsed) return fallback;
      const host = url.hostname;
      // The board id keys the posting endpoint; read it from the site context
      // (public, unauthenticated) rather than assuming 1.
      const ctxRes = await fetch(
        `https://${host}/api/geo/${parsed.tenant}/sitecontext/${parsed.tenant}/${parsed.site}/${parsed.locale}`,
        { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) }
      );
      if (!ctxRes.ok) return fallback;
      const ctx = (await ctxRes.json()) as { jobBoardId?: number };
      const boardId = ctx.jobBoardId ?? 1;

      const res = await fetch(
        `https://${host}/api/geo/${parsed.tenant}/jobposting/${parsed.tenant}/${parsed.locale}/${boardId}/${parsed.jobId}`,
        { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) }
      );
      if (!res.ok) return fallback;
      const body = (await res.json()) as {
        jobTitle?: string;
        jobPostingContent?: { jobDescription?: string };
        postingLocations?: Array<{ formattedAddress?: string }>;
      };
      return {
        // The posting API carries no employer name; the tenant slug is the best
        // public identifier, same trade-off as Lever and Ashby.
        company: parsed.tenant,
        title: body.jobTitle ?? "",
        location: body.postingLocations?.[0]?.formattedAddress ?? "",
        // jobDescription is HTML.
        description: stripHtml(body.jobPostingContent?.jobDescription ?? "").slice(0, 20_000),
        ats
      };
    }

    if (ats === "workday") {
      const parsed = parseWorkdayUrl(url);
      if (!parsed) return fallback;
      // The Candidate Experience Service endpoint the career site itself calls.
      // Undocumented but public (no auth on a public board), and far better than
      // scraping a JS-rendered page for metadata we only need for the tracker.
      const res = await fetch(
        `https://${parsed.host}/wday/cxs/${parsed.tenant}/${parsed.site}/job${parsed.externalPath}`,
        {
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(10_000)
        }
      );
      if (!res.ok) return fallback;
      const body = (await res.json()) as {
        jobPostingInfo?: {
          title?: string;
          jobDescription?: string;
          location?: string;
          additionalLocations?: string[];
        };
        hiringOrganization?: { name?: string };
      };
      const info = body.jobPostingInfo ?? {};
      return {
        // Workday reports the legal entity, which is a better company name than
        // the tenant slug; fall back to the slug when it is absent.
        company: body.hiringOrganization?.name ?? parsed.tenant,
        title: info.title ?? "",
        location: info.location ?? info.additionalLocations?.[0] ?? "",
        // jobDescription is HTML.
        description: stripHtml(info.jobDescription ?? "").slice(0, 20_000),
        ats
      };
    }
  } catch {
    // network/timeout - tracker row just gets the URL
  }
  return fallback;
}
