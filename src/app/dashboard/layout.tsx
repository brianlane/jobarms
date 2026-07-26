import Link from "next/link";
import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/supabase/auth";
import { isAdminEmail } from "@/lib/admin/guard";
import { DashboardNav } from "@/components/DashboardNav";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const user = await getAuthUser();
  if (!user) redirect("/login");

  // The console already links back here; this is the other half of that pair, so
  // an operator is not left typing /admin from memory. Rendered only for the
  // allowlist, and it is only a LINK: /admin re-checks server-side, so showing
  // it grants nothing on its own.
  const isAdmin = isAdminEmail(user.email);

  return (
    <div className="flex min-h-screen flex-col bg-slate-50 md:flex-row">
      {/* Mobile top bar */}
      <div className="border-b border-ink-800 bg-ink-950 md:hidden">
        <div className="flex items-center justify-between px-5 py-4">
          <Link href="/" className="font-display text-lg font-bold text-white">
            Job<span className="text-arm-400">Arms</span>
          </Link>
          <form action="/auth/signout" method="post">
            <button className="font-mono text-[10px] uppercase tracking-[0.15em] text-slate-400">
              Sign out
            </button>
          </form>
        </div>
        <DashboardNav variant="topbar" />
      </div>

      {/* Desktop sidebar */}
      <aside className="hidden w-60 shrink-0 flex-col bg-ink-950 text-white md:flex">
        <Link href="/" className="px-6 py-6 font-display text-xl font-bold">
          Job<span className="text-arm-400">Arms</span>
        </Link>
        <DashboardNav variant="sidebar" />
        <div className="border-t border-ink-800 px-4 py-5">
          {/* Spacing follows whether the link below it exists, so a normal
              user's sidebar is unchanged by this addition. */}
          <p className={`truncate px-2 text-xs text-slate-500 ${isAdmin ? "pb-1" : "pb-3"}`}>
            {user.email}
          </p>
          {isAdmin && (
            <Link
              href="/admin/dashboard"
              className="block px-2 pb-3 font-mono text-[10px] uppercase tracking-[0.14em] text-slate-500 hover:text-arm-300"
            >
              Admin console
            </Link>
          )}
          <form action="/auth/signout" method="post">
            <button className="w-full rounded-lg px-2 py-2 text-left font-mono text-[11px] uppercase tracking-[0.14em] text-slate-400 hover:bg-ink-800 hover:text-white">
              Sign out
            </button>
          </form>
        </div>
      </aside>

      <main className="flex-1 overflow-x-auto p-5 sm:p-8">{children}</main>
    </div>
  );
}
