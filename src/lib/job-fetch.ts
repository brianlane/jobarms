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
