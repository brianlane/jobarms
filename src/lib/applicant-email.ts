/**
 * Managed applicant email: the mailbox an arm applies with.
 *
 * Login-gated ATSes (Workday first) require a candidate ACCOUNT per employer
 * tenant, and creating one means receiving a verification mail. So each user
 * gets a stable alias at jobarms.com that JobArms controls end to end. The
 * user never manages it: mail arriving there is logged, acted on when it is an
 * account verification, and forwarded to their real inbox.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { randomBytes } from "node:crypto";

/** Domain every managed alias lives on (Email Routing catches the whole zone). */
export const APPLICANT_EMAIL_DOMAIN = "jobarms.com";

/**
 * Alphabet for the random part: lowercase letters and digits with the
 * ambiguous glyphs (0/o, 1/l/i) removed, so an alias read off a screenshot or
 * dictated over the phone survives the round trip.
 */
const ALIAS_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const ALIAS_LENGTH = 10;

/**
 * A uniformly random index in [0, max) drawn from the CSPRNG.
 *
 * Rejection sampling, not modulo: 31 does not divide 256, so `byte % 31` would
 * make the first nine letters measurably likelier than the rest. Bytes at or
 * above the largest multiple of `max` are discarded and redrawn, which costs a
 * few extra bytes and makes the distribution exactly flat.
 */
function randomIndex(max: number): number {
  const limit = Math.floor(256 / max) * max;
  for (;;) {
    const byte = randomBytes(1)[0];
    if (byte < limit) return byte % max;
  }
}

/**
 * A fresh candidate alias, e.g. `a-7f3k9d2pqr@jobarms.com`. The `a-` prefix
 * marks it as an applicant mailbox so the inbound worker can tell managed
 * aliases from platform addresses (hello@, team@) at a glance.
 *
 * ~31^10 (about 8e14) possibilities. Aliases are effectively public once we mail
 * from them, but they must stay UNGUESSABLE: anyone who can predict one could
 * send mail an arm might act on. The DB's unique index is what prevents
 * duplicates; the entropy here is what prevents targeting.
 */
export function generateApplicantAlias(): string {
  let local = "a-";
  for (let i = 0; i < ALIAS_LENGTH; i++) {
    local += ALIAS_ALPHABET[randomIndex(ALIAS_ALPHABET.length)];
  }
  return `${local}@${APPLICANT_EMAIL_DOMAIN}`;
}

/** True when an address is one of our managed applicant aliases. */
export function isApplicantAlias(address: string): boolean {
  const trimmed = address.trim().toLowerCase();
  const at = trimmed.lastIndexOf("@");
  if (at < 0) return false;
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  if (domain !== APPLICANT_EMAIL_DOMAIN) return false;
  return new RegExp(`^a-[${ALIAS_ALPHABET}]{${ALIAS_LENGTH}}$`).test(local);
}

/** How many fresh candidates to try before giving up on a unique alias. */
const CLAIM_ATTEMPTS = 5;

/**
 * The user's managed alias, assigning one on first use.
 *
 * Idempotent by construction: `claim_applicant_alias` returns the existing
 * alias when there is one, and null when the candidate collided, in which case
 * we generate another. Returns null only if every attempt collided (never seen
 * in practice) or the RPC is unavailable, and callers must treat that as "no
 * account-capable email" rather than inventing one.
 */
export async function ensureApplicantAlias(
  service: SupabaseClient,
  userId: string
): Promise<string | null> {
  for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt++) {
    const { data } = await service.rpc("claim_applicant_alias", {
      p_user_id: userId,
      p_candidate: generateApplicantAlias()
    });
    if (typeof data === "string" && data) return data;
  }
  return null;
}

/**
 * Sender domains whose mail we treat as ATS account plumbing (verification
 * links and one-time codes). Matched as the domain itself or any subdomain, so
 * `notification.myworkday.com` counts for `myworkday.com`.
 *
 * Kept deliberately tight: only mail from a known ATS sender is ever ACTED on
 * (link visited / code entered). Everything else is logged and forwarded, never
 * auto-clicked, so a phishing mail to an alias can't drive the browser.
 */
export const ATS_ACCOUNT_DOMAINS: readonly string[] = [
  "myworkday.com",
  "myworkdayjobs.com",
  "workday.com",
  "greenhouse.io",
  "lever.co",
  "ashbyhq.com",
  "workable.com"
];

/** The domain part of an address, lowercased ("" when malformed). */
export function domainOf(address: string): string {
  const at = address.lastIndexOf("@");
  return at >= 0 ? address.slice(at + 1).trim().toLowerCase() : "";
}

/** True when `domain` is one of `allowed` (exact match or a subdomain of one). */
export function domainMatches(domain: string, allowed: readonly string[]): boolean {
  const d = domain.trim().toLowerCase();
  return allowed.some((base) => d === base || d.endsWith(`.${base}`));
}

/** True when mail from this address is ATS account plumbing we may act on. */
export function isAtsAccountSender(address: string): boolean {
  return domainMatches(domainOf(address), ATS_ACCOUNT_DOMAINS);
}

export interface Verification {
  /** Absolute https URL that confirms the account, when the mail carried one. */
  link: string | null;
  /** Numeric one-time code, when the mail carried one instead of a link. */
  code: string | null;
}

/**
 * Verification-link keywords. A confirmation URL essentially always carries one
 * of these in its path or query, which keeps us off the unsubscribe footer,
 * privacy-policy, and "view in browser" links that share the same domain.
 */
const LINK_HINTS = [
  "verify",
  "verification",
  "confirm",
  "activate",
  "activation",
  "validate",
  "setpassword",
  "set-password",
  "createaccount",
  "create-account",
  "token=",
  "onetime",
  "one-time"
];

/** Links we must never treat as verification, even when a hint word matches. */
const LINK_BLOCKLIST = ["unsubscribe", "optout", "opt-out", "privacy", "preferences"];

// A 4-8 digit run is the usual OTP shape. Requiring an adjacent cue word (in
// either order) keeps us off ZIP codes, phone fragments, and req numbers.
const CODE_CUE = "(?:code|otp|pin|passcode|one[- ]?time(?:\\s+\\w+){0,2})";
// "Your verification code is 483920": only a word or two separates the cue from
// the digits.
const CODE_AFTER_CUE = new RegExp(`${CODE_CUE}\\D{0,20}(\\d{4,8})\\b`, "i");
// "483920 is your verification code": digits-first phrasing puts a whole clause
// in between, so this window has to be wider than the cue-first one.
const CODE_BEFORE_CUE = new RegExp(`\\b(\\d{4,8})\\D{0,30}${CODE_CUE}`, "i");

/** Every absolute http(s) URL in a blob of text or HTML, in order. */
function urlsIn(content: string): string[] {
  // Stop at whitespace and the characters that commonly terminate a URL in
  // prose or markup (quotes, angle brackets, closing parens/brackets).
  const matches = content.match(/https?:\/\/[^\s"'<>)\]]+/gi) ?? [];
  // Trailing sentence punctuation is not part of the URL.
  return matches.map((url) => url.replace(/[.,;:!?]+$/, ""));
}

/**
 * Pull an account-verification link or one-time code out of a message.
 *
 * PURE and conservative: it reports what it found and never decides whether to
 * act. The caller checks the sender first (see `isAtsAccountSender`), so a
 * lookalike mail can never get its link visited.
 */
export function extractVerification(text: string, html = ""): Verification {
  const content = `${text}\n${html}`;

  const link =
    urlsIn(content).find((url) => {
      const lower = url.toLowerCase();
      if (LINK_BLOCKLIST.some((bad) => lower.includes(bad))) return false;
      return LINK_HINTS.some((hint) => lower.includes(hint));
    }) ?? null;

  // Prefer the plain-text part for codes: HTML carries style/attribute digits
  // (colors, widths, tracking ids) that read like codes to a regex.
  const codeSource = text || content;
  const code =
    CODE_AFTER_CUE.exec(codeSource)?.[1] ?? CODE_BEFORE_CUE.exec(codeSource)?.[1] ?? null;

  return { link, code };
}
