/**
 * Env-derived configuration.
 *
 * Read once at import so a request never sees a half-changed config, and kept in
 * one place so the deploy script's .env and the code cannot drift.
 */
/**
 * A numeric env var, falling back when unset or unparseable. Exported for tests:
 * CONFIG itself is frozen at import, so the parsing rules are verified here
 * rather than by re-importing the module per case.
 */
export function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** A string env var, falling back when unset or blank. Exported for tests. */
export function str(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw && raw.trim() ? raw : fallback;
}

export const CONFIG = {
  port: num("PORT", 8080),
  /** Bearer required on every route except /health. */
  token: str("RENDER_TOKEN", ""),
  /** Per-navigation timeout. */
  navTimeoutMs: num("RENDER_NAV_TIMEOUT_MS", 30_000),
  /** Default per-action Playwright timeout. */
  actionTimeoutMs: num("RENDER_ACTION_TIMEOUT_MS", 20_000),
  /** Where session cookies are persisted (see sessions.ts). */
  stateDir: str("RENDER_STATE_DIR", "/var/lib/jobarms-render/state"),
  /** Idle session eviction. Longer than a wizard, shorter than the review gate. */
  sessionTtlMs: num("RENDER_SESSION_TTL_MS", 30 * 60 * 1000),
  /**
   * Cached contexts. Each is a real Chromium context, so on the shared KVM1 box
   * (1 vCPU / 4GB) this stays deliberately small.
   */
  maxSessions: num("RENDER_MAX_SESSIONS", 8),
  /** Concurrent in-flight browser requests; the rest queue. */
  maxConcurrency: num("RENDER_MAX_CONCURRENCY", 2),
  rateWindowMs: num("RENDER_RATE_WINDOW_MS", 60_000),
  rateMax: num("RENDER_RATE_MAX", 60),
  /** Cap on wizard pages walked in one request, so a loop can never spin. */
  maxWizardPages: num("RENDER_MAX_WIZARD_PAGES", 12)
} as const;
