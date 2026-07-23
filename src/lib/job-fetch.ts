import { detectAts, type Ats } from "@/lib/ats";

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

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
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
  } catch {
    // network/timeout - tracker row just gets the URL
  }
  return fallback;
}
