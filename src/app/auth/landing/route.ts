import { NextResponse } from "next/server";
import { getAdminUser } from "@/lib/admin/guard";

/**
 * Where a fresh sign-in lands.
 *
 * The admin allowlist is `ADMIN_EMAIL`, a server-only value, so the sign-in form
 * cannot know whether it just authenticated an operator, and it must not learn:
 * shipping the allowlist to the browser would publish exactly the address worth
 * attacking. The form sends everyone here and this decides.
 *
 * Only reached when no explicit `next` was asked for, so a link that wanted a
 * particular page still wins. An operator who wants the user view has the
 * console's own "My dashboard" link, which is why this can prefer the console
 * without trapping anyone out of their own account.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const admin = await getAdminUser();
  const target = admin ? "/admin/dashboard" : "/dashboard";
  return NextResponse.redirect(new URL(target, new URL(request.url).origin));
}
