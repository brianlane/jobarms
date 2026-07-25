import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServiceClient } from "@/lib/supabase/service";
import { requireEnv } from "@/lib/env";
import { forwardInboundEmail } from "@/lib/email";
import {
  APPLICANT_EMAIL_DOMAIN,
  domainOf,
  extractVerification,
  isAtsAccountSender
} from "@/lib/applicant-email";

/**
 * Inbound mail webhook, called by the `jobarms-email-inbound` Cloudflare Email
 * Worker for every message that reaches a managed applicant alias.
 *
 * Three jobs, in order:
 *  1. Log it (`inbound_emails`, deduped on Message-ID so a retried delivery
 *     cannot double-store or double-forward).
 *  2. Extract an account verification link/code when the SENDER is a known ATS,
 *     so the apply-arm run waiting on it can proceed. Extraction only records
 *     what it found; nothing is visited here.
 *  3. Forward the message to the user's real inbox.
 *
 * Auth is the shared `EMAIL_INBOUND_SECRET` bearer. A non-2xx tells Cloudflare
 * the delivery failed so the sender retries; we therefore return 200 for every
 * outcome we do not want retried (unknown alias, loop guard, duplicate).
 */

const bodySchema = z.object({
  /** Envelope recipient: the authoritative alias to route on. */
  to: z.string().max(320),
  from: z.string().max(320).default(""),
  subject: z.string().max(2000).default(""),
  text: z.string().max(1_000_000).default(""),
  html: z.string().max(1_000_000).optional(),
  messageId: z.string().max(400)
});

export async function POST(request: Request) {
  const expected = requireEnv("EMAIL_INBOUND_SECRET");
  if (request.headers.get("authorization") !== `Bearer ${expected}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  const { to, from, subject, text, html, messageId } = parsed.data;

  const alias = to.trim().toLowerCase();
  const fromAddress = from.trim().toLowerCase();
  const fromDomain = domainOf(fromAddress);

  // Loop guard: we send FROM jobarms.com (forwards, welcome mail), so our own
  // bounces and auto-replies must never re-enter the pipeline.
  if (fromDomain === APPLICANT_EMAIL_DOMAIN) {
    return NextResponse.json({ ok: true, skipped: "own_domain" });
  }

  const service = createSupabaseServiceClient();

  // Resolve the alias to its owner. An unknown alias is normal (catch-all mail
  // to an address that was never issued): accept and drop, never retry.
  const { data: profile } = await service
    .from("profiles")
    .select("id, email")
    .eq("applicant_alias", alias)
    .maybeSingle();
  if (!profile) return NextResponse.json({ ok: true, skipped: "unknown_alias" });

  // Extraction runs only for known ATS senders, so a lookalike "verify your
  // account" mail from anywhere else is logged and forwarded but never becomes
  // something the arm will act on.
  const verification = isAtsAccountSender(fromAddress)
    ? extractVerification(text, html ?? "")
    : { link: null, code: null };

  // Insert first and let the (user_id, message_id) unique index arbitrate: on a
  // retried delivery the insert fails, we skip, and the user gets exactly one
  // forward. `select()` returning no row means the duplicate lost the race.
  const { data: inserted, error: insertError } = await service
    .from("inbound_emails")
    .insert({
      user_id: profile.id,
      alias,
      from_address: fromAddress,
      from_domain: fromDomain,
      subject,
      body_text: text,
      message_id: messageId,
      verification_link: verification.link,
      verification_code: verification.code
    })
    .select("id")
    .maybeSingle();

  if (insertError || !inserted) {
    // Duplicate delivery (or a transient write failure). Either way, do NOT
    // forward again; returning 200 stops the sender from retrying a message we
    // have already handled.
    return NextResponse.json({ ok: true, skipped: "duplicate" });
  }

  const forwarded = await forwardInboundEmail({
    to: profile.email as string,
    alias,
    fromAddress,
    subject,
    text,
    ...(html ? { html } : {})
  });
  if (forwarded) {
    await service.from("inbound_emails").update({ forwarded: true }).eq("id", inserted.id);
  }

  return NextResponse.json({
    ok: true,
    forwarded,
    verification: Boolean(verification.link || verification.code)
  });
}
