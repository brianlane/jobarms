/**
 * jobarms-email-inbound - Cloudflare Email Worker for managed applicant mail.
 *
 * Wired as the Email Routing CATCH-ALL for jobarms.com. Two paths:
 *
 *  - Mail to a managed applicant alias (`a-<10 chars>@jobarms.com`): parse the
 *    MIME and POST a compact JSON payload to the app's /api/email/inbound
 *    webhook, which logs it, extracts any ATS account-verification link/code,
 *    and forwards it to the user's real inbox.
 *  - Anything else: forward to FALLBACK_FORWARD_TO, preserving the behavior the
 *    catch-all had before this worker existed. Explicit routing rules (hello@)
 *    are matched by Email Routing BEFORE the catch-all, so platform mail never
 *    reaches this code at all.
 *
 * Loop guard: mail FROM the platform domain is dropped. The app forwards through
 * Resend from a jobarms.com address, so its bounces and auto-replies must never
 * re-enter the pipeline.
 *
 * Reliability: a non-2xx from the webhook THROWS, which tells Cloudflare the
 * delivery temporarily failed so the sending server retries later. That is safe
 * because the webhook dedupes on Message-ID, so a retry cannot double-forward.
 */
import PostalMime from "postal-mime";
import { htmlToText, looksLikeStrippedTemplate } from "./html-text";
import { domainOf, isApplicantAlias } from "./alias";

export interface Env {
  /** Public URL of the app webhook, e.g. https://jobarms.com/api/email/inbound */
  APP_INBOUND_URL: string;
  /** Zone this worker serves; also the loop-guard domain. */
  PLATFORM_EMAIL_DOMAIN: string;
  /** Where non-alias catch-all mail goes (a VERIFIED Email Routing destination). */
  FALLBACK_FORWARD_TO: string;
  /** Shared bearer; must match the app's EMAIL_INBOUND_SECRET. */
  EMAIL_INBOUND_SECRET: string;
}

/**
 * HTML body relayed for rendering. Must stay at or below the webhook's schema
 * cap; an over-long body is DROPPED (text still flows) rather than truncated,
 * because truncated HTML renders as visibly broken markup.
 */
const MAX_HTML_CHARS = 500_000;
/** Text bodies are clipped rather than dropped: prose survives truncation. */
const MAX_TEXT_CHARS = 900_000;

/** The subset of Cloudflare's ForwardableEmailMessage this worker uses. */
export interface ForwardableEmailMessage {
  readonly from: string;
  readonly to: string;
  readonly headers: Headers;
  readonly raw: ReadableStream<Uint8Array>;
  forward(rcptTo: string): Promise<void>;
}

export default {
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    const platformDomain = (env.PLATFORM_EMAIL_DOMAIN || "jobarms.com").toLowerCase();

    // Loop guard: never process mail the platform itself originated.
    if (domainOf(message.from) === platformDomain) return;

    // Not a managed mailbox: behave exactly like the plain catch-all forward.
    if (!isApplicantAlias(message.to, platformDomain)) {
      if (env.FALLBACK_FORWARD_TO) await message.forward(env.FALLBACK_FORWARD_TO);
      return;
    }

    const email = await PostalMime.parse(message.raw);

    // Prefer text/plain, UNLESS that part is itself flattened template source
    // (stylesheets and merge tags masquerading as prose). In that case, and when
    // there is no text part at all, collapse the HTML properly instead:
    // htmlToText keeps anchor URLs, which is what verification extraction needs.
    const plain = (email.text ?? "").trim();
    const text =
      plain.length > 0 && !(email.html && looksLikeStrippedTemplate(plain))
        ? plain
        : htmlToText(email.html ?? "") || plain;

    const messageId =
      message.headers.get("message-id") ||
      email.messageId ||
      `cf-${Date.now()}-${crypto.randomUUID()}`;

    const html = (email.html ?? "").trim();

    const res = await fetch(env.APP_INBOUND_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.EMAIL_INBOUND_SECRET}`
      },
      body: JSON.stringify({
        // Envelope recipient is the authoritative alias to route on (the To:
        // header can list several addresses or none of ours).
        to: message.to,
        from: email.from?.address || message.from,
        subject: email.subject ?? "",
        text: text.slice(0, MAX_TEXT_CHARS),
        ...(html && html.length <= MAX_HTML_CHARS ? { html } : {}),
        messageId
      })
    });

    if (!res.ok) {
      // Temporary failure: make the sender retry rather than silently dropping
      // a verification mail a run is parked waiting for.
      throw new Error(`inbound webhook returned ${res.status}`);
    }
  }
};
