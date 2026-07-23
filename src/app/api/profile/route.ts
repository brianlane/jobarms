import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceClient } from "@/lib/supabase/service";
import { sendWelcomeEmail } from "@/lib/email";

const profileUpdateSchema = z
  .object({
    full_name: z.string().max(200),
    phone: z.string().max(50),
    location: z.string().max(200),
    headline: z.string().max(200),
    summary: z.string().max(5000),
    links: z.record(z.string(), z.string()),
    work_history: z.array(z.record(z.string(), z.unknown())),
    education: z.array(z.record(z.string(), z.unknown())),
    skills: z.array(z.string()),
    eeo: z.record(z.string(), z.unknown()),
    preferences: z.record(z.string(), z.unknown()),
    arm_autonomy: z.enum(["review_gate", "full_auto"]),
    onboarding_complete: z.boolean()
  })
  .partial();

/** Update the caller's own profile (RLS enforces ownership). */
export async function PATCH(request: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => null);
  const parsed = profileUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const { error } = await supabase.from("profiles").update(parsed.data).eq("id", user.id);
  if (error) return NextResponse.json({ error: "update_failed" }, { status: 500 });

  // Finishing onboarding sends the (once-only) welcome email.
  if (parsed.data.onboarding_complete === true && user.email) {
    const service = createSupabaseServiceClient();
    const { data: profile } = await service
      .from("profiles")
      .select("full_name, welcome_sent")
      .eq("id", user.id)
      .single();
    if (profile && !profile.welcome_sent) {
      const sent = await sendWelcomeEmail(user.email, (profile.full_name ?? "").split(" ")[0]);
      if (sent) {
        await service.from("profiles").update({ welcome_sent: true }).eq("id", user.id);
      }
    }
  }

  return NextResponse.json({ ok: true });
}
