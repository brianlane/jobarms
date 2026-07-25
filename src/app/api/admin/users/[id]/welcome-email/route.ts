import { NextResponse } from "next/server";
import { getAdminUser } from "@/lib/admin/guard";
import { logAdminAction } from "@/lib/admin/audit";
import { createSupabaseServiceClient } from "@/lib/supabase/service";
import { sendWelcomeEmail } from "@/lib/email";

/**
 * Resend the welcome email. For the support case where onboarding finished but
 * the mail never landed (Resend unconfigured at the time, a bounce, a typo since
 * corrected).
 *
 * `welcome_sent` is only flipped on a successful send, so a no-op send (email
 * unconfigured) cannot mark the user as welcomed.
 */
export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const admin = await getAdminUser();
  if (!admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { id } = await ctx.params;
  const supabase = createSupabaseServiceClient();
  const { data: profile } = await supabase
    .from("profiles")
    .select("email, full_name")
    .eq("id", id)
    .maybeSingle();
  if (!profile?.email) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const firstName = String(profile.full_name ?? "").split(" ")[0];
  const sent = await sendWelcomeEmail(profile.email, firstName);
  if (sent) {
    await supabase.from("profiles").update({ welcome_sent: true }).eq("id", id);
  }

  await logAdminAction({
    adminEmail: admin.email,
    action: "resend_welcome_email",
    targetUserId: id,
    detail: { sent }
  });

  return sent
    ? NextResponse.json({ ok: true })
    : NextResponse.json(
        { error: "not_sent", hint: "Email is unconfigured or the provider refused." },
        { status: 502 }
      );
}
