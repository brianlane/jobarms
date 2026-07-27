import { NextResponse } from "next/server";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseServiceClient } from "@/lib/supabase/service";
import { requireEnv } from "@/lib/env";
import { forwardInboundEmail } from "@/lib/email";
import {
  APPLICANT_EMAIL_DOMAIN,
  domainOf,
  extractVerification,
  isAtsAccountSender
} from "@/lib/applicant-email";
import { completeRenderVerification } from "@/lib/render";
import { markSiteAccountVerified } from "@/lib/site-accounts";
import { resumeAccountVerification } from "@/lib/arm";
import {
  isUniqueViolation,
  pickVerificationRun,
  verificationHost
} from "@/lib/inbound-verification";

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
  /** The sender's own display name, when the original message carried one. */
  fromName: z.string().max(320).default(""),
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
  const { to, from, fromName, subject, text, html, messageId } = parsed.data;

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

  if (insertError) {
    // A unique-key conflict is a genuine redelivery of mail we already
    // handled, so 200 tells the sender to stop retrying and we do not forward
    // twice.
    if (isUniqueViolation(insertError)) {
      return NextResponse.json({ ok: true, skipped: "duplicate" });
    }
    // Anything else is a write that did not happen. Treating it as a
    // duplicate used to swallow transient database errors: the sender saw
    // 200, never retried, and the message reached neither the user nor the
    // table. Fail loudly so delivery is retried instead.
    console.error("inbound insert failed", insertError);
    return NextResponse.json({ ok: false, error: "insert_failed" }, { status: 500 });
  }
  if (!inserted) {
    // Wrote without erroring but nothing came back, so we cannot confirm the
    // row or safely forward against it. A retry either succeeds or hits the
    // duplicate branch above, both of which are correct.
    console.error("inbound insert returned no row", { alias, messageId });
    return NextResponse.json({ ok: false, error: "insert_unconfirmed" }, { status: 500 });
  }

  const forward = await forwardInboundEmail({
    to: profile.email as string,
    alias,
    fromAddress,
    fromName,
    subject,
    text,
    ...(html ? { html } : {})
  });
  // Written either way, so a refusal leaves its reason on the row instead of
  // only in the logs. Whoever looks at /admin/system next gets the answer, not
  // just the alarm.
  await service
    .from("inbound_emails")
    .update({
      forwarded: forward.ok,
      forward_error: forward.ok ? null : forward.reason
    })
    .eq("id", inserted.id);

  // Act on a verification: hand the link/code to the sidecar so it completes the
  // confirmation inside the session that created the account, then release the
  // run parked on it. Best-effort and AFTER the forward, so a sidecar outage can
  // never cost the user their mail; the parked run simply times out honestly.
  let consumed: ConsumeOutcome = "none";
  if (verification.link || verification.code) {
    consumed = await consumeVerification(service, {
      userId: profile.id as string,
      link: verification.link,
      code: verification.code,
      fromDomain
    });
  }

  return NextResponse.json({
    ok: true,
    forwarded: forward.ok,
    // Echoed so a probe against this endpoint sees the reason immediately rather
    // than having to go and read the row it just wrote.
    ...(forward.ok ? {} : { forwardError: forward.reason }),
    verification: Boolean(verification.link || verification.code),
    consumed
  });
}

type ConsumeOutcome =
  | "none"
  | "no_pending_run"
  | "ambiguous_run"
  | "verified"
  | "failed"
  | "sidecar_error";

/**
 * Complete a pending account verification and resume the run waiting on it.
 *
 * Scoped to a run that is actually parked at `needs_account_verification` for
 * this user, so an old or unsolicited verification mail cannot drive the browser.
 */
async function consumeVerification(
  service: SupabaseClient,
  args: {
    userId: string;
    link: string | null;
    code: string | null;
    fromDomain: string | null;
  }
): Promise<ConsumeOutcome> {
  try {
    // Every parked run, not just the newest, so the one matching this mail's
    // tenant can be picked out below.
    const { data: runs } = await service
      .from("application_runs")
      .select("id, tenant_host")
      .eq("user_id", args.userId)
      .eq("status", "needs_account_verification")
      .order("created_at", { ascending: false })
      .limit(20);

    const { run, ambiguous } = pickVerificationRun(
      runs ?? [],
      verificationHost(args.link, args.fromDomain)
    );
    if (ambiguous) return "ambiguous_run";
    if (!run?.tenant_host) return "no_pending_run";

    const tenantHost = run.tenant_host as string;
    const result = await completeRenderVerification({
      userId: args.userId,
      tenantHost,
      link: args.link,
      code: args.code
    });
    if (!result.ok) return "sidecar_error";

    if (result.data.status !== "authenticated") {
      // The tenant did not accept it (expired link, wrong code). Leave the run
      // parked: another mail may still arrive before the timeout.
      return "failed";
    }

    await markSiteAccountVerified(service, args.userId, tenantHost);
    // Release the workflow. The worker owns run state, so a failure here leaves
    // the run parked to time out rather than marking it done behind the worker.
    const resumed = await resumeAccountVerification(run.id as string);
    return resumed.ok ? "verified" : "sidecar_error";
  } catch {
    // Verification is advisory: the message is already stored and forwarded.
    return "sidecar_error";
  }
}
