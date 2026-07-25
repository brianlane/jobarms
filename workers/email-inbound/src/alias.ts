/**
 * Managed-alias recognition.
 *
 * MIRRORS `src/lib/applicant-email.ts` in the app (same prefix, alphabet, and
 * length). The two trees are separate npm packages so the constant is duplicated
 * rather than imported; if the alias shape ever changes, change both. The app is
 * authoritative: this worker only decides "webhook or plain forward", and a
 * mismatch degrades to forwarding the mail on, never to losing it.
 */
const ALIAS_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const ALIAS_LENGTH = 10;
const ALIAS_RE = new RegExp(`^a-[${ALIAS_ALPHABET}]{${ALIAS_LENGTH}}$`);

/** The domain part of an address, lowercased ("" when malformed). */
export function domainOf(address: string): string {
  const at = address.lastIndexOf("@");
  return at >= 0 ? address.slice(at + 1).trim().toLowerCase() : "";
}

/** True when this address is one of the managed applicant mailboxes. */
export function isApplicantAlias(address: string, platformDomain: string): boolean {
  const trimmed = address.trim().toLowerCase();
  const at = trimmed.lastIndexOf("@");
  if (at < 0) return false;
  if (trimmed.slice(at + 1) !== platformDomain.toLowerCase()) return false;
  return ALIAS_RE.test(trimmed.slice(0, at));
}
