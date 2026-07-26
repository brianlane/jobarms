/**
 * Health of the managed-alias forward path, for /admin/system.
 *
 * Why this exists: `inbound_emails.forwarded` was recorded per message and
 * aggregated nowhere, so a forward that failed was invisible until a human
 * noticed mail they never received. That is exactly how a run of silently
 * discarded forwards went unnoticed. One failure is a bad address; several in a
 * day is the relay being broken for everyone, and only the count tells them
 * apart.
 *
 * PRIVACY: this reads timestamps, the sender's DOMAIN, and the boolean. Never
 * the subject and never the body. `inbound_emails` holds users' real
 * correspondence, and the env matrix on the same page already refuses to print
 * values on the principle that an operator screen is not a place to leak
 * things. "Admin diagnoses email" must not quietly become "admin reads mail".
 */

export interface InboundEmailRow {
  created_at: string;
  from_domain: string;
  forwarded: boolean;
  /** Provider reason it was refused. Null on older rows and on success. */
  forward_error?: string | null;
}

export interface ForwardFailure {
  at: string;
  fromDomain: string;
  /**
   * Why the provider refused. Rows written before the column existed have none,
   * hence the fallback rather than a promise the data cannot keep.
   */
  reason: string;
}

export interface InboundEmailHealth {
  received24h: number;
  received7d: number;
  failed24h: number;
  failed7d: number;
  /** Share of the last 7 days that failed to forward, rounded. */
  failureRatePct: number;
  /** Newest first, capped, so the panel shows a pattern rather than a dump. */
  recentFailures: ForwardFailure[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
export const RECENT_FAILURE_CAP = 8;

export function summarizeInboundEmail(
  rows: InboundEmailRow[],
  now: Date = new Date(),
  cap: number = RECENT_FAILURE_CAP
): InboundEmailHealth {
  let received24h = 0;
  let received7d = 0;
  let failed24h = 0;
  let failed7d = 0;
  const failures: ForwardFailure[] = [];

  for (const row of rows) {
    const at = Date.parse(row.created_at);
    // An unparseable timestamp cannot be placed in a window, and guessing would
    // put it in the wrong one. Skipped rather than counted somewhere false.
    if (!Number.isFinite(at)) continue;
    const age = now.getTime() - at;
    if (age > 7 * DAY_MS) continue;

    received7d += 1;
    if (age <= DAY_MS) received24h += 1;
    if (row.forwarded) continue;

    failed7d += 1;
    if (age <= DAY_MS) failed24h += 1;
    failures.push({
      at: row.created_at,
      fromDomain: row.from_domain || "unknown",
      reason: row.forward_error?.trim() || "no reason recorded"
    });
  }

  failures.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

  return {
    received24h,
    received7d,
    failed24h,
    failed7d,
    failureRatePct: received7d > 0 ? Math.round((failed7d / received7d) * 100) : 0,
    recentFailures: failures.slice(0, cap)
  };
}
