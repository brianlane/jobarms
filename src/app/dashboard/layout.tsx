import Link from "next/link";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const navItems = [
  { href: "/dashboard", label: "Overview" },
  { href: "/dashboard/applications", label: "Applications" },
  { href: "/dashboard/discover", label: "Discover" },
  { href: "/dashboard/profile", label: "Profile" },
  { href: "/dashboard/billing", label: "Billing" },
  { href: "/dashboard/settings", label: "Settings" }
];

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

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
        <nav className="flex gap-1 overflow-x-auto px-3 pb-3" aria-label="Dashboard navigation">
          {navItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="shrink-0 rounded-full px-3.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-slate-300 hover:bg-ink-800 hover:text-white"
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </div>

      {/* Desktop sidebar */}
      <aside className="hidden w-60 shrink-0 flex-col bg-ink-950 text-white md:flex">
        <Link href="/" className="px-6 py-6 font-display text-xl font-bold">
          Job<span className="text-arm-400">Arms</span>
        </Link>
        <nav className="flex flex-1 flex-col gap-1 px-3" aria-label="Dashboard navigation">
          {navItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="rounded-lg px-3.5 py-2.5 font-mono text-[11px] uppercase tracking-[0.14em] text-slate-400 transition-colors hover:bg-ink-800 hover:text-white"
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="border-t border-ink-800 px-4 py-5">
          <p className="truncate px-2 pb-3 text-xs text-slate-500">{user.email}</p>
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
