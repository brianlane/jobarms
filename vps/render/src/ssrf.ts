/**
 * SSRF guard.
 *
 * The sidecar navigates to URLs handed to it over the network, and it runs on a
 * box that also hosts loopback-only services. So every URL, including redirects
 * and subresources, is re-validated: http(s) only, no localhost, no private or
 * link-local IPv4, no IPv6 literals, no cloud metadata hosts, no *.internal.
 *
 * Mirrors the guard in newCoworker's aiflow-render, which exists for the same
 * reason on the same class of box.
 */

/** True for any IPv4 literal we refuse to navigate to. */
export function isPrivateIpv4(host: string): boolean {
  const parts = host.split(".").map(Number);
  if (parts.length !== 4) return true;
  if (parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a >= 224) return true; // multicast + reserved
  return false;
}

const IPV4_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/**
 * The normalized URL when it is safe to navigate to, else null.
 *
 * Returns the serialized form so callers navigate to exactly what was checked
 * (no chance of re-parsing differently).
 */
export function safeUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  // No empty-host check: WHATWG URL parsing rejects an http(s) URL without a
  // host outright, so `new URL` above has already handled it.
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return null;
  if (host === "metadata" || host === "metadata.google.internal") return null;
  if (host.endsWith(".internal")) return null;
  // An IPv6 literal arrives bracketed, so a colon in the hostname means IPv6.
  // We have no need for it and it is an easy way to smuggle ::1 or fd00::/8.
  if (host.includes(":")) return null;
  if (IPV4_RE.test(host) && isPrivateIpv4(host)) return null;

  return url.toString();
}
