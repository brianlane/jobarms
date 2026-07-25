import { NextResponse } from "next/server";
import { getAdminUser } from "@/lib/admin/guard";
import { logAdminAction } from "@/lib/admin/audit";
import { loadDeletionImpact } from "@/lib/admin/user-detail";
import { createSupabaseServiceClient } from "@/lib/supabase/service";

/**
 * Delete an account completely.
 *
 * Removing the auth user is the whole operation: `profiles`, `applications`,
 * `application_runs`, `resumes`, `inbound_emails`, `user_answer_memory`,
 * `subscriptions`, and both usage meters all reference `auth.users` with
 * `on delete cascade`.
 *
 * Two refusals, both deliberate:
 * - An account with a live Stripe subscription. The database cascade cannot stop
 *   the billing, so deleting first would leave Stripe charging a card with
 *   nobody to serve.
 * - The admin's own account, which would lock the operator out mid-request.
 *
 * Storage objects are NOT cascaded by Postgres. Resume files and run artifacts
 * live in private buckets under the user's own folder, so those are removed
 * explicitly before the auth user goes.
 */
export async function DELETE(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const admin = await getAdminUser();
  if (!admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { id } = await ctx.params;
  if (id === admin.id) {
    return NextResponse.json({ error: "cannot_delete_self" }, { status: 409 });
  }

  const impact = await loadDeletionImpact(id);
  if (impact.activeSubscriptionId) {
    return NextResponse.json(
      {
        error: "stripe_active",
        hint: "Cancel the Stripe subscription first; deleting now would keep billing a card with nobody to serve.",
        subscriptionId: impact.activeSubscriptionId
      },
      { status: 409 }
    );
  }

  const supabase = createSupabaseServiceClient();

  // Storage is not part of the FK cascade. Both buckets are laid out with the
  // user id as the top-level folder, so listing that prefix is the full set.
  for (const bucket of ["resumes", "run-artifacts"]) {
    const { data: files } = await supabase.storage.from(bucket).list(id);
    const paths = (files ?? []).map((file: { name: string }) => `${id}/${file.name}`);
    if (paths.length > 0) await supabase.storage.from(bucket).remove(paths);
  }

  const { error } = await supabase.auth.admin.deleteUser(id);
  if (error) return NextResponse.json({ error: "delete_failed" }, { status: 500 });

  // The id goes in the payload rather than target_user_id: that column
  // references auth.users, and the row it would point at no longer exists.
  await logAdminAction({
    adminEmail: admin.email,
    action: "delete_user",
    targetUserId: null,
    detail: { deletedUserId: id, ...impact }
  });

  return NextResponse.json({ ok: true, deleted: impact });
}
