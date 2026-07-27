import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceClient } from "@/lib/supabase/service";
import {
  deleteLinkedInAccount,
  LINKEDIN_TENANT_HOST,
  setLinkedInCredentials
} from "@/lib/linkedin";
import { clearRenderSession } from "@/lib/render";

const bodySchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(200),
  // Must be explicitly true: the user is handing us their real professional
  // identity, so consent is recorded, not assumed.
  consent: z.literal(true)
});

/** Connect (or re-connect) the user's LinkedIn account. */
export async function POST(request: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });

  const service = createSupabaseServiceClient();
  await setLinkedInCredentials(service, user.id, parsed.data.email, parsed.data.password);
  await service
    .from("profiles")
    .update({ linkedin_consent_at: new Date().toISOString() })
    .eq("id", user.id);
  // Drop any session held under the OLD credentials so the next run signs in
  // fresh with the password just stored, rather than riding a stale login.
  await clearRenderSession({ userId: user.id, tenantHost: LINKEDIN_TENANT_HOST });

  return NextResponse.json({ ok: true, email: parsed.data.email });
}

/** Disconnect: drop the credentials, the consent, and the browser session. */
export async function DELETE() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const service = createSupabaseServiceClient();
  await deleteLinkedInAccount(service, user.id);
  await service.from("profiles").update({ linkedin_consent_at: null }).eq("id", user.id);
  // Best-effort (clearRenderSession never throws): forget the logged-in cookies
  // so the account is not left signed in on the box after the user disconnects.
  await clearRenderSession({ userId: user.id, tenantHost: LINKEDIN_TENANT_HOST });

  return NextResponse.json({ ok: true });
}
