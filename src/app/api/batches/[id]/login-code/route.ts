import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { submitBatchLoginCode } from "@/lib/arm";

const bodySchema = z.object({
  // LinkedIn PINs are short numeric codes; keep it permissive but bounded.
  code: z.string().trim().min(4).max(12)
});

/**
 * Hand a batch parked on a LinkedIn sign-in PIN the code the user just entered.
 * Same contract as the single-run route: ownership under the user's own RLS,
 * and the batch must actually be waiting on a code.
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

  const { data: batch } = await supabase
    .from("apply_batches")
    .select("id, status")
    .eq("id", id)
    .maybeSingle();
  if (!batch) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (batch.status !== "needs_login_code") {
    return NextResponse.json(
      { error: "not_awaiting_code", status: batch.status },
      { status: 409 }
    );
  }

  const result = await submitBatchLoginCode(id, parsed.data.code);
  if (!result.ok) return NextResponse.json({ error: result.reason }, { status: 503 });

  return NextResponse.json({ ok: true });
}
