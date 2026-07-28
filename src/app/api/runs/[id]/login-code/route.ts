import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { submitLoginCode } from "@/lib/arm";

const bodySchema = z.object({
  // LinkedIn PINs are short numeric codes; keep it permissive but bounded.
  code: z.string().trim().min(4).max(12)
});

/**
 * Hand a run parked on a LinkedIn sign-in PIN the code the user just entered.
 *
 * Ownership is checked under the user's own RLS, and the run must actually be
 * waiting on a code, so a stale or wrong-state submit is rejected rather than
 * fired blindly at the worker.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });

  const { data: run } = await supabase
    .from("application_runs")
    .select("id, status")
    .eq("id", id)
    .maybeSingle();
  if (!run) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (run.status !== "needs_login_code") {
    return NextResponse.json({ error: "not_awaiting_code", status: run.status }, { status: 409 });
  }

  const result = await submitLoginCode(id, parsed.data.code);
  if (!result.ok) return NextResponse.json({ error: result.reason }, { status: 503 });

  return NextResponse.json({ ok: true });
}
