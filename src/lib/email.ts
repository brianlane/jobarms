import { Resend } from "resend";

/**
 * Transactional email via Resend. Gracefully no-ops when RESEND_API_KEY is
 * unset (the account + domain verification are a Phase 1 manual checklist
 * item), so nothing upstream ever breaks on email.
 */

/** Longest body we relay in a forward; beyond this the text is clipped. */
const FORWARD_TEXT_MAX = 200_000;

/** Longest reason we keep. Provider messages are short; a runaway one is not. */
const REASON_MAX = 300;

/**
 * Did the provider ACCEPT the message, and if not, why.
 *
 * The Resend SDK does not throw on a rejected send: `emails.send` resolves with
 * `{ data, error }`, where error carries codes like `invalid_from_address`,
 * `validation_error`, and `daily_quota_exceeded`. Discarding the return value
 * therefore reported every send as a success, so a forward the provider refused
 * was recorded against the message as delivered and nothing ever surfaced it.
 *
 * The reason is both logged and RETURNED. Logging alone meant an operator had to
 * already suspect a problem and go looking; returning it lets the reason sit
 * next to the message it belongs to. Only the provider's own code and message
 * travel, never the addresses.
 */
function outcomeOf(
  what: string,
  result: { error?: { name?: string; message?: string } | null }
): SendOutcome {
  if (!result.error) return { ok: true };
  const { name, message } = result.error;
  console.error(`${what} rejected by email provider`, name, message);
  return { ok: false, reason: [name, message].filter(Boolean).join(": ").slice(0, REASON_MAX) };
}

/**
 * A send either happened or it did not, and a failure always says why. Deliberately
 * not a bare boolean: the boolean is what let a refused forward look delivered.
 */
export type SendOutcome = { ok: true } | { ok: false; reason: string };

function unattempted(reason: string): SendOutcome {
  return { ok: false, reason };
}

/** Strip everything with meaning in an address header, then collapse space. */
function headerSafe(value: string): string {
  return value
    .replace(/["'<>,;:\\\r\n]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A safe From display name identifying whoever actually wrote.
 *
 * Two separate constraints meet here.
 *
 * Header safety: characters with meaning in an address header (quotes, angle
 * brackets, commas, colons, semicolons) are stripped rather than escaped, so a
 * crafted sender can never inject a second recipient or break the header.
 *
 * Deliverability: NO email domain goes in here. Google lists "using an
 * @gmail.com domain as the display name" among the deceptive display-name
 * practices it treats as spoofing, and a bare address in a display name ahead
 * of a DIFFERENT real address is also invalid per RFC 5322, whose unquoted
 * phrase cannot contain `@` or `.`. Gmail acts on that by accepting the message
 * with a 250 and then discarding it: no bounce, nothing in spam, which is how a
 * forward went missing while every layer reported success.
 *
 * So we prefer the sender's own name, fall back to the local part alone, and
 * quote the result.
 */
function displayName(senderName: string, fromAddress: string): string {
  const candidate = headerSafe(senderName) || headerSafe(fromAddress);
  // Cut at the first `@` whatever the source. Plenty of clients set the display
  // name to the address itself, so trusting the name would put the domain right
  // back where it must not be.
  const who = candidate.split("@")[0].trim().slice(0, 100);
  return `"${who ? `${who} (via JobArms)` : "JobArms"}"`;
}

export interface ForwardArgs {
  /** The user's real inbox (their signup address). */
  to: string;
  /** The managed alias the mail arrived at; becomes the From so replies work. */
  alias: string;
  /** Whoever actually sent it; becomes Reply-To. */
  fromAddress: string;
  /** The sender's own display name, when the original message carried one. */
  fromName?: string;
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
 * Never throws. A failure comes back with its reason: the message is already
 * stored, so a failed forward is a degraded notification rather than lost mail,
 * and the caller keeps the reason on the row for whoever looks later.
 */
export async function forwardInboundEmail(args: ForwardArgs): Promise<SendOutcome> {
  const key = process.env.RESEND_API_KEY;
  if (!key) return unattempted("email_unconfigured");
  if (!args.to) return unattempted("no_recipient_on_file");
  if (!args.alias) return unattempted("no_alias");

  const text = args.text.slice(0, FORWARD_TEXT_MAX);
  try {
    const resend = new Resend(key);
    const result = await resend.emails.send({
      // From the alias (a jobarms.com address we can authenticate) rather than
      // the original sender, which would fail SPF/DKIM and land in spam. The
      // sender goes in the display name so the user still sees who wrote.
      from: `${displayName(args.fromName ?? "", args.fromAddress)} <${args.alias}>`,
      to: args.to,
      ...(args.fromAddress ? { replyTo: args.fromAddress } : {}),
      subject: args.subject || "(no subject)",
      ...(args.html ? { html: args.html } : {}),
      text:
        text ||
        "This message arrived at the email JobArms applies with and had no text body."
    });
    return outcomeOf("inbound forward", result);
  } catch (err) {
    return unattempted(String(err).slice(0, REASON_MAX));
  }
}

export interface ReviewNeededArgs {
  to: string;
  firstName: string;
  company: string;
  jobTitle: string;
  applicationId: string;
  /** Question labels the form did not accept. */
  fields: string[];
}

/**
 * Tell a user their arm stopped and needs them.
 *
 * Sent when the arm filled an application, read the form back, and found it was
 * not holding an answer the user approved, so it refused to submit rather than
 * send something wrong. This mail is what makes that wait worth having: a
 * full-auto user chose not to be asked, so nothing else would bring them back to
 * the dashboard before the run expires.
 *
 * Written for someone who did NOT expect to be interrupted, so it leads with why
 * it is asking rather than with what to do.
 */
export async function sendReviewNeededEmail(args: ReviewNeededArgs): Promise<SendOutcome> {
  const key = process.env.RESEND_API_KEY;
  if (!key) return unattempted("email_unconfigured");
  if (!args.to) return unattempted("no_recipient_on_file");

  const role = [args.jobTitle, args.company].filter(Boolean).join(" at ") || "an application";

  const lines = [
    `Hi${args.firstName ? ` ${args.firstName}` : ""},`,
    "",
    `Your arm filled out ${role}, then checked its work and found the form was not holding one of the answers you approved. Rather than submit something wrong on your behalf, it stopped and saved everything.`,
    ""
  ];
  if (args.fields.length > 0) {
    const noun = args.fields.length === 1 ? "question" : "questions";
    lines.push(`The ${noun} it could not set: ${args.fields.join(", ")}.`, "");
  }
  lines.push(
    "Open the application to fix that answer and approve it, and your arm will finish the job:",
    `https://jobarms.com/dashboard/applications/${args.applicationId}`,
    "",
    "Nothing has been sent to this employer. If you do nothing, the run ends on its own in 7 days.",
    "",
    "- JobArms"
  );

  try {
    const resend = new Resend(key);
    const result = await resend.emails.send({
      from: "JobArms <hello@jobarms.com>",
      to: args.to,
      subject: `Your arm needs you: ${role}`,
      text: lines.join("\n")
    });
    return outcomeOf("review needed email", result);
  } catch (err) {
    return unattempted(String(err).slice(0, REASON_MAX));
  }
}

/**
 * Welcome mail. Still a boolean: nothing persists the reason for this one, and
 * a rejection is logged by `outcomeOf` either way.
 */
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
    return outcomeOf("welcome email", result).ok;
  } catch {
    return false;
  }
}
