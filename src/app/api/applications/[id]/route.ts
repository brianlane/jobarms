import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { MANUAL_STATUSES } from "@/lib/application-status";

const bodySchema = z.object({
  status: z.enum(MANUAL_STATUSES as [string, ...string[]]).optional(),
  notes: z.string().max(10_000).optional()
});

/** Manual tracker updates (status transitions + notes). RLS scopes to owner. */
export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });

  const patch: Record<string, unknown> = {};
  if (parsed.data.status) {
    patch.status = parsed.data.status;
    if (parsed.data.status === "applied") patch.applied_at = new Date().toISOString();
  }
  if (parsed.data.notes !== undefined) patch.notes = parsed.data.notes;
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "empty_patch" }, { status: 400 });
  }

  const { error } = await supabase.from("applications").update(patch).eq("id", id);
  if (error) return NextResponse.json({ error: "update_failed" }, { status: 500 });
  return NextResponse.json({ ok: true });
}
