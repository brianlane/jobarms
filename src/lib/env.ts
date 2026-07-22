/**
 * Typed access to required server environment variables.
 * Fails loudly at the call site instead of letting an undefined credential
 * turn into a confusing downstream auth error.
 */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/** Optional env with a default. */
export function envOr(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

export function appUrl(): string {
  return envOr("NEXT_PUBLIC_APP_URL", "http://localhost:3000");
}
