/** ATS detection + job-page URL normalization (pure, unit-tested). */

export type Ats = "greenhouse" | "lever" | "ashby" | "workable" | "unknown";

export function detectAts(rawUrl: string): Ats {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return "unknown";
  }
  const host = url.hostname.toLowerCase();
  if (host.endsWith("greenhouse.io")) return "greenhouse";
  if (host.endsWith("lever.co")) return "lever";
  if (host.endsWith("ashbyhq.com")) return "ashby";
  if (host.endsWith("workable.com")) return "workable";
  return "unknown";
}

/** ATSes the arm can drive today. */
export const SUPPORTED_ATS: ReadonlySet<Ats> = new Set(["greenhouse", "lever"]);

export function normalizeJobUrl(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  // Strip trackers; keep meaningful params (gh_jid for embedded boards).
  const keep = new Set(["gh_jid", "lever-origin"]);
  const params = new URLSearchParams();
  url.searchParams.forEach((value, key) => {
    if (keep.has(key)) params.set(key, value);
  });
  url.search = params.toString() ? `?${params.toString()}` : "";
  url.hash = "";
  return url.toString();
}
