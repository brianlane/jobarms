/** ATS detection + job-page URL normalization (pure, unit-tested). */

export type Ats =
  | "greenhouse"
  | "lever"
  | "workday"
  | "ashby"
  | "workable"
  | "linkedin"
  | "unknown";

/**
 * Host suffixes, matched as the domain itself or a subdomain of it.
 *
 * Suffix matching must be dot-anchored: a bare `endsWith("greenhouse.io")` also
 * matches `evilgreenhouse.io`, which would route an attacker-chosen page into an
 * adapter (and, for Workday, into the account-creation path).
 */
const ATS_HOSTS: ReadonlyArray<{ suffix: string; ats: Ats }> = [
  { suffix: "greenhouse.io", ats: "greenhouse" },
  { suffix: "lever.co", ats: "lever" },
  // Workday tenants live at <tenant>.wdN.myworkdayjobs.com; some career sites
  // are served from myworkdaysite.com instead.
  { suffix: "myworkdayjobs.com", ats: "workday" },
  { suffix: "myworkdaysite.com", ats: "workday" },
  { suffix: "ashbyhq.com", ats: "ashby" },
  { suffix: "workable.com", ats: "workable" },
  // LinkedIn Easy Apply. Unlike every other ATS, the "account" here is the
  // user's own LinkedIn login (see the site-account vault), not one the arm
  // creates, so this is account-gated but never account-creating.
  { suffix: "linkedin.com", ats: "linkedin" }
];

export function detectAts(rawUrl: string): Ats {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return "unknown";
  }
  const host = url.hostname.toLowerCase();
  for (const { suffix, ats } of ATS_HOSTS) {
    if (host === suffix || host.endsWith(`.${suffix}`)) return ats;
  }
  return "unknown";
}

/** ATSes the arm has a tuned adapter for today. */
export const SUPPORTED_ATS: ReadonlySet<Ats> = new Set([
  "greenhouse",
  "lever",
  "workday",
  "ashby",
  "linkedin"
]);

/**
 * The adapter a run dispatches with: the tuned adapter for supported ATSes,
 * the best-effort `generic` adapter for every other board.
 *
 * Generic runs carry guardrails the caller must enforce (and the worker
 * re-enforces): review-gate only, never account creation, and an explicit
 * user acknowledgment that the attempt may fail and still consume a run.
 */
export type DispatchAts = "greenhouse" | "lever" | "workday" | "ashby" | "linkedin" | "generic";

export function dispatchAtsOf(ats: Ats): DispatchAts {
  return SUPPORTED_ATS.has(ats) ? (ats as DispatchAts) : "generic";
}

/**
 * ATSes that require a candidate account on the employer's own tenant before an
 * application can be submitted. Drives the account-vault and email-verification
 * path at dispatch; mirrors `requiresAccount` on the sidecar's adapters.
 */
export const ACCOUNT_REQUIRED_ATS: ReadonlySet<Ats> = new Set(["workday", "linkedin"]);

/**
 * The fixed host every LinkedIn session, job URL, and vault row is keyed by.
 * A run's tenant host is normalized to this so the browser session, the
 * `site_accounts` row, and the dispatch all agree on one key.
 */
export const LINKEDIN_HOST = "www.linkedin.com";

/**
 * The numeric posting id from any LinkedIn job URL shape, or null.
 *
 * LinkedIn surfaces the same posting under several URLs: the canonical
 * `/jobs/view/<id>/`, and search/collection pages that carry the id in a
 * `currentJobId` query param. Both must normalize to one catalog key so a job
 * pasted from search and the same job opened directly are not tracked twice.
 */
export function parseLinkedInJobId(url: URL): string | null {
  const fromQuery = url.searchParams.get("currentJobId");
  if (fromQuery && /^\d+$/.test(fromQuery)) return fromQuery;

  const parts = url.pathname.split("/").filter(Boolean);
  const viewIdx = parts.indexOf("view");
  if (viewIdx !== -1 && /^\d+$/.test(parts[viewIdx + 1] ?? "")) return parts[viewIdx + 1];

  return null;
}

export interface WorkdayRef {
  /** Tenant, the first host label: `nvidia` in nvidia.wd5.myworkdayjobs.com. */
  tenant: string;
  /** Career-site id, the path segment before `/job`. */
  site: string;
  /** Everything after `/job`, e.g. `/US-CA-Santa-Clara/Engineer_JR123`. */
  externalPath: string;
  host: string;
}

/** A locale segment Workday puts before the site id, e.g. `en-US`. */
const LOCALE_RE = /^[a-z]{2}(-[A-Za-z]{2})?$/;

/**
 * Parse a Workday posting URL into the pieces its JSON endpoint needs.
 *
 * Shapes seen in the wild, with and without the locale segment:
 *   /en-US/<site>/job/<location>/<title>_<reqId>
 *   /<site>/job/<location>/<title>_<reqId>
 *   /en-US/<site>/details/<title>_<reqId>   (the "details" variant)
 */
export function parseWorkdayUrl(url: URL): WorkdayRef | null {
  // URL parsing guarantees a non-empty host for http(s), and callers only reach
  // here for a detected Workday host, so the first label is always present.
  const host = url.hostname.toLowerCase();
  const tenant = host.split(".")[0];

  const parts = url.pathname.split("/").filter(Boolean);
  // Workday uses /job/ and /details/ for the same posting depending on the site.
  const anchor = parts.findIndex((p) => p === "job" || p === "details");
  if (anchor < 1) return null;

  const tail = parts.slice(anchor + 1);
  if (tail.length === 0) return null;

  // The site id is the segment immediately before the anchor, skipping a locale.
  const site = parts[anchor - 1];
  if (!site || LOCALE_RE.test(site)) return null;

  return { tenant, site, externalPath: `/${tail.join("/")}`, host };
}

/** The tenant host a run applies on, used to key its account and session. */
export function tenantHostOf(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function normalizeJobUrl(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;

  // LinkedIn: collapse every posting shape to the canonical view URL on the
  // fixed host, so search-result and direct-open URLs share one catalog key and
  // one session. A LinkedIn URL with no parseable posting id is not a job.
  const host = url.hostname.toLowerCase();
  if (host === "linkedin.com" || host.endsWith(".linkedin.com")) {
    const id = parseLinkedInJobId(url);
    return id ? `https://${LINKEDIN_HOST}/jobs/view/${id}/` : null;
  }

  // Strip trackers; keep meaningful params (gh_jid for embedded boards).
  const keep = new Set(["gh_jid", "lever-origin"]);
  // Workday postings carry no meaningful query params, and its `?q=` search
  // state would otherwise fragment the shared jobs catalog by URL.
  const params = new URLSearchParams();
  url.searchParams.forEach((value, key) => {
    if (keep.has(key)) params.set(key, value);
  });
  url.search = params.toString() ? `?${params.toString()}` : "";
  url.hash = "";
  return url.toString();
}
