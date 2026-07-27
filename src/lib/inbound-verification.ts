/**
 * Helpers for routing an inbound verification email to the run that asked for
 * it, and for telling a real redelivery apart from a failed write.
 *
 * Kept out of the route file because App Router route modules may only export
 * their HTTP handlers, and these need to be unit-testable on their own.
 */

/**
 * Postgres unique-violation. Distinguishes genuine redelivery of a message we
 * already stored from a write that simply did not happen.
 */
export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "23505"
  );
}

/**
 * Host a verification mail points at, used to match it to the run waiting on
 * it. Prefers the link, since that names the tenant directly, and falls back
 * to the sending domain when there is no usable link.
 */
export function verificationHost(
  link: string | null,
  fromDomain: string | null
): string | null {
  if (link) {
    try {
      return new URL(link).hostname.toLowerCase();
    } catch {
      // Unparseable link; fall through to the sending domain.
    }
  }
  return fromDomain ? fromDomain.toLowerCase() : null;
}

export interface VerificationRunPick<T> {
  run: T | null;
  ambiguous: boolean;
}

/**
 * Choose which parked run a verification mail belongs to.
 *
 * Taking the newest run for the user is wrong as soon as two applications are
 * waiting at once: mail for one employer drives the other tenant's session,
 * and both runs suffer for it. Match on the tenant instead, accept a lone
 * candidate when the tenant cannot be matched, and refuse to guess between
 * several. Letting the intended run time out honestly beats completing a
 * verification in the wrong browser session.
 */
export function pickVerificationRun<T extends { tenant_host?: string | null }>(
  runs: T[],
  host: string | null
): VerificationRunPick<T> {
  if (runs.length === 0) return { run: null, ambiguous: false };

  if (host) {
    const matched = runs.filter((run) => {
      const tenant = run.tenant_host?.toLowerCase();
      if (!tenant) return false;
      return tenant === host || host.endsWith(`.${tenant}`) || tenant.endsWith(`.${host}`);
    });
    if (matched.length === 1) return { run: matched[0], ambiguous: false };
    if (matched.length > 1) return { run: null, ambiguous: true };
  }

  if (runs.length === 1) return { run: runs[0], ambiguous: false };
  return { run: null, ambiguous: true };
}
