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

export interface VerificationOrigin {
  host: string | null;
  /**
   * Whether the host came from a verification link, which names the tenant,
   * rather than the sending domain, which usually does not. A code-only mail
   * arrives from something generic like `myworkday.com` and cannot tell two
   * Workday tenants apart, so it must not be used to rule runs out.
   */
  namesTenant: boolean;
}

/**
 * Where a verification mail points, used to match it to the run waiting on it.
 * Prefers the link and falls back to the sending domain, reporting which one
 * it used so the caller knows how much the host is worth.
 */
export function verificationOrigin(
  link: string | null,
  fromDomain: string | null
): VerificationOrigin {
  if (link) {
    try {
      return { host: new URL(link).hostname.toLowerCase(), namesTenant: true };
    } catch {
      // Unparseable link; fall through to the sending domain.
    }
  }
  return { host: fromDomain ? fromDomain.toLowerCase() : null, namesTenant: false };
}

export interface VerificationRunPick<T> {
  run: T | null;
  ambiguous: boolean;
}

/**
 * Choose which parked run a verification mail belongs to.
 *
 * Taking the newest run for the user is wrong as soon as two applications are
 * waiting at once: mail for one employer drives the other tenant's session
 * and both runs suffer for it. So a host that names a tenant is matched
 * against the parked runs first.
 *
 * A host that does NOT name a tenant proves nothing. Code-only mail arrives
 * from a generic sender like `myworkday.com`, which will never equal
 * `acme.wd1.myworkdayjobs.com`, and treating that as "matches nothing" would
 * leave every parked run stuck forever. In that case there is simply no
 * signal, so the newest run is used, which is what happened before any of
 * this existed.
 *
 * Refusing to guess is reserved for the case where we genuinely could tell
 * the runs apart and still cannot choose. Completing a verification in the
 * wrong browser session is worse than letting a run time out honestly.
 */
export function pickVerificationRun<T extends { tenant_host?: string | null }>(
  allRuns: T[],
  origin: VerificationOrigin
): VerificationRunPick<T> {
  // A run with no tenant recorded cannot be driven: the sidecar needs the
  // host. Filtering those out here rather than returning one and letting the
  // caller bail keeps a usable run from being passed over in favour of an
  // unusable one.
  const runs = allRuns.filter((run) => Boolean(run.tenant_host));
  if (runs.length === 0) return { run: null, ambiguous: false };
  if (runs.length === 1) return { run: runs[0], ambiguous: false };

  const { host, namesTenant } = origin;
  if (host && namesTenant) {
    const matched = runs.filter((run) => {
      const tenant = (run.tenant_host as string).toLowerCase();
      return tenant === host || host.endsWith(`.${tenant}`) || tenant.endsWith(`.${host}`);
    });
    if (matched.length === 1) return { run: matched[0], ambiguous: false };
    // A link naming a tenant we cannot pin to exactly one parked run is the
    // case worth refusing: we could discriminate and still cannot choose.
    return { run: null, ambiguous: true };
  }

  // No tenant-bearing signal at all. Fall back to the newest parked run.
  return { run: runs[0], ambiguous: false };
}
