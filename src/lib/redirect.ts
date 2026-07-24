/**
 * Post-auth redirect target validation (pure, unit-tested).
 *
 * Only same-site paths are allowed. Beyond the obvious absolute-URL and
 * protocol-relative ("//host") cases, WHATWG URL parsing treats a backslash
 * like a forward slash, so "/\evil.com" resolves to https://evil.com/ -
 * reject any backslash outright.
 */
export function safeNextPath(raw: string | null | undefined, fallback = "/dashboard"): string {
  if (!raw) return fallback;
  if (!raw.startsWith("/")) return fallback;
  if (raw.startsWith("//")) return fallback;
  if (raw.includes("\\")) return fallback;
  return raw;
}
