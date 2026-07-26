import { Resend } from "resend";

/**
 * Transactional email via Resend. Gracefully no-ops when RESEND_API_KEY is
 * unset (the account + domain verification are a Phase 1 manual checklist
 * item), so nothing upstream ever breaks on email.
 */

/** Longest body we relay in a forward; beyond this the text is clipped. */
const FORWARD_TEXT_MAX = 200_000;

/**
 * Whether the provider ACCEPTED the message, naming the reason when it did not.
 *
 * The Resend SDK does not throw on a rejected send: `emails.send` resolves with
 * `{ data, error }`, where error carries codes like `invalid_from_address`,
 * `validation_error`, and `daily_quota_exceeded`. Discarding the return value
 * therefore reported every send as a success, so a forward the provider refused
 * was recorded against the message as delivered and nothing ever surfaced it.
 *
 * The reason is logged rather than returned because callers only need the
 * boolean, and a rejection is worth reading in the function logs. Only the
 * provider's own code and message are logged, never the addresses.
 */
function accepted(
  what: string,
  result: { error?: { name?: string; message?: string } | null }
): boolean {
  if (!result.error) return true;
  console.error(`${what} rejected by email provider`, result.error.name, result.error.message);
  return false;
}

/**
 * A safe From display name built from the original sender's address.
 *
 * Two separate constraints meet here.
 *
 * Header safety: characters with meaning in an address header (quotes, angle
 * brackets, commas, colons, semicolons) are stripped rather than escaped, so a
 * crafted sender address can never inject a second recipient or break the
 * header.
 *
 * Deliverability: the phrase is QUOTED and the `@` is spelled out. A bare email
 * address sitting in a display name in front of a DIFFERENT real address is
 * invalid per RFC 5322 (an unquoted phrase cannot contain `@` or `.`) and is
 * also the precise shape mailbox providers score as spoofing, which is a good
 * way to have every forward filed as spam.
 */
function displayName(fromAddress: string): string {
  const clean = fromAddress
    .replace(/["'<>,;:\\\r\n]/g, "")
    .replace(/@/g, " at ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return `"${clean ? `${clean} via JobArms` : "JobArms"}"`;
}

export interface ForwardArgs {
  /** The user's real inbox (their signup address). */
  to: string;
  /** The managed alias the mail arrived at; becomes the From so replies work. */
  alias: string;
  /** Whoever actually sent it; becomes Reply-To. */
  fromAddress: string;
  subject: string;
  text: string;
  html?: string;
}

/**
 * Relay a message that landed on a user's managed applicant alias to their real
 * inbox.
 *
 * Cloudflare Email Routing can only forward to VERIFIED destination addresses,
 * which every user's own email is not, so the relay happens here instead: we
 * re-send through Resend (jobarms.com is a verified sender) From the alias with
 * Reply-To set to the original sender. A recruiter's mail therefore lands in the
 * user's inbox and hitting reply goes straight back to the recruiter, never
 * through us.
 *
 * Returns false (never throws) when email is unconfigured or the provider
 * fails: the message is already stored, so a failed forward is a degraded
 * notification, not lost mail.
 */
export async function forwardInboundEmail(args: ForwardArgs): Promise<boolean> {
  const key = process.env.RESEND_API_KEY;
  if (!key || !args.to || !args.alias) return false;

  const text = args.text.slice(0, FORWARD_TEXT_MAX);
  try {
    const resend = new Resend(key);
    const result = await resend.emails.send({
      // From the alias (a jobarms.com address we can authenticate) rather than
      // the original sender, which would fail SPF/DKIM and land in spam. The
      // sender goes in the display name so the user still sees who wrote.
      from: `${displayName(args.fromAddress)} <${args.alias}>`,
      to: args.to,
      ...(args.fromAddress ? { replyTo: args.fromAddress } : {}),
      subject: args.subject || "(no subject)",
      ...(args.html ? { html: args.html } : {}),
      text:
        text ||
        "This message arrived at the email JobArms applies with and had no text body."
    });
    return accepted("inbound forward", result);
  } catch {
    return false;
  }
}
export async function sendWelcomeEmail(to: string, firstName: string): Promise<boolean> {
  const key = process.env.RESEND_API_KEY;
  if (!key || !to) return false;

  try {
    const resend = new Resend(key);
    const result = await resend.emails.send({
      from: "JobArms <hello@jobarms.com>",
      to,
      subject: "Your arms are ready 🦾",
      text: [
        `Hi${firstName ? ` ${firstName}` : ""},`,
        "",
        "Welcome to JobArms. Your profile is set up, which means your arms are ready to work.",
        "",
        "Paste any Greenhouse or Lever job link into the dashboard and an arm will fill out the entire application from your profile - you review every answer before it submits.",
        "",
        "Apply to something: https://jobarms.com/dashboard/applications/new",
        "",
        "- JobArms"
      ].join("\n")
    });
    return accepted("welcome email", result);
  } catch {
    return false;
  }
}
