import Link from "next/link";
import { redirect } from "next/navigation";
import { getAdminUser } from "@/lib/admin/guard";
import { AdminNav } from "@/components/admin/AdminNav";

export const metadata = { title: "Admin", robots: { index: false, follow: false } };

/**
 * The admin gate. Everything under this route group is operator-only, and this
 * layout is the real check: the proxy redirect is convenience, but a request
 * that somehow reaches a page still has to satisfy `getAdminUser()` here.
 *
 * A signed-in NON-admin is bounced to their own dashboard rather than the admin
 * login, since sending a normal user to a sign-in form they can never pass is a
 * dead end.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const admin = await getAdminUser();
  if (!admin) redirect("/admin/login?next=/admin/dashboard");

  return (
    <div className="flex min-h-screen flex-col bg-ink-950 text-slate-200 md:flex-row">
      {/* Mobile top bar */}
      <div className="border-b border-ink-800 bg-ink-950 md:hidden">
        <div className="flex items-center justify-between px-5 py-4">
          <Link href="/admin/dashboard" className="font-display text-lg font-bold text-white">
            Job<span className="text-arm-400">Arms</span>
            <span className="ml-2 font-mono text-[10px] uppercase tracking-[0.2em] text-slate-500">
              admin
            </span>
          </Link>
          <form action="/auth/signout" method="post">
            <button className="font-mono text-[10px] uppercase tracking-[0.15em] text-slate-400">
              Sign out
            </button>
          </form>
        </div>
        <AdminNav variant="topbar" />
      </div>

      {/* Desktop sidebar */}
      <aside className="hidden w-60 shrink-0 flex-col border-r border-ink-800 bg-ink-950 md:flex">
        <Link href="/admin/dashboard" className="px-6 py-6 font-display text-xl font-bold text-white">
          Job<span className="text-arm-400">Arms</span>
          <span className="mt-1 block font-mono text-[10px] uppercase tracking-[0.2em] text-slate-500">
            admin console
          </span>
        </Link>
        <AdminNav variant="sidebar" />
        <div className="border-t border-ink-800 px-4 py-5">
          <p className="truncate px-2 pb-1 text-xs text-slate-500">{admin.email}</p>
          <Link
            href="/dashboard"
            className="block px-2 pb-3 font-mono text-[10px] uppercase tracking-[0.14em] text-slate-500 hover:text-arm-300"
          >
            My dashboard
          </Link>
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
