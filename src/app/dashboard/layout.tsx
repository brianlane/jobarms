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
    <div className="flex min-h-screen bg-slate-50">
      <aside className="flex w-56 shrink-0 flex-col border-r border-slate-200 bg-[--color-ink-950] text-white">
        <Link href="/" className="px-5 py-5 text-lg font-bold">
          Job<span className="text-[--color-arm-400]">Arms</span>
        </Link>
        <nav className="flex flex-1 flex-col gap-1 px-3">
          {navItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="rounded-md px-3 py-2 text-sm text-slate-300 hover:bg-[--color-ink-800] hover:text-white"
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="border-t border-[--color-ink-800] px-3 py-4">
          <p className="truncate px-2 pb-2 text-xs text-slate-400">{user.email}</p>
          <form action="/auth/signout" method="post">
            <button className="w-full rounded-md px-3 py-2 text-left text-sm text-slate-300 hover:bg-[--color-ink-800] hover:text-white">
              Sign out
            </button>
          </form>
        </div>
      </aside>
      <main className="flex-1 overflow-x-auto p-8">{children}</main>
    </div>
  );
}
