import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServiceClient } from "@/lib/supabase/service";
import { requireEnv } from "@/lib/env";
import { sendReviewNeededEmail } from "@/lib/email";

/**
 * The apply-arm worker asking us to tell a user their run is waiting on them.
 *
 * Called when the fill interlock refused to submit a full-auto run: the arm
 * parked it for correction, and that user chose full auto precisely so they would
 * not have to watch the dashboard, so without this mail the run would sit unseen
 * until it expired.
 *
 * The send lives here rather than in the worker because this side already owns
 * the only Resend client and the From-header rules Gmail cares about. The worker
 * holds no email credentials at all.
 *
 * Auth is the `ARM_WORKER_SHARED_SECRET` bearer, the same secret the app uses to
 * call the worker; this is that channel running the other way.
 *
 * Always 200 once authenticated, including when the provider refuses. A non-2xx
 * would invite a retry, and nothing good comes of retrying an email while a
 * user's run sits parked.
 */

const bodySchema = z.object({
  runId: z.string().uuid(),
  applicationId: z.string().uuid(),
  userId: z.string().uuid(),
  /** Question labels the form did not accept. Never answer values. */
  fields: z.array(z.string().max(300)).max(50).default([])
});

export async function POST(request: Request): Promise<NextResponse> {
  const auth = request.headers.get("authorization");
  if (auth !== `Bearer ${requireEnv("ARM_WORKER_SHARED_SECRET")}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  const { applicationId, userId, fields } = parsed.data;

  const service = createSupabaseServiceClient();
  const { data: profile } = await service
    .from("profiles")
    .select("email, full_name")
    .eq("id", userId)
    .maybeSingle();

  // No address on file is not an error worth retrying, and the run is parked
  // regardless. Say so plainly instead of pretending a mail went out.
  if (!profile?.email) {
    return NextResponse.json({ ok: true, sent: false, reason: "no_recipient_on_file" });
  }

  const { data: application } = await service
    .from("applications")
    .select("jobs(company, title)")
    .eq("id", applicationId)
    .maybeSingle();
  const job = application?.jobs as unknown as { company?: string; title?: string } | null;

  const outcome = await sendReviewNeededEmail({
    to: profile.email,
    firstName: (profile.full_name ?? "").split(" ")[0],
    company: job?.company ?? "",
    jobTitle: job?.title ?? "",
    applicationId,
    fields
  });

  return NextResponse.json({
    ok: true,
    sent: outcome.ok,
    ...(outcome.ok ? {} : { reason: outcome.reason })
  });
}
