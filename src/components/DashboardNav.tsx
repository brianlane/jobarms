"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const navItems = [
  { href: "/dashboard", label: "Overview" },
  { href: "/dashboard/applications", label: "Applications" },
  { href: "/dashboard/discover", label: "Discover" },
  { href: "/dashboard/profile", label: "Profile" },
  { href: "/dashboard/billing", label: "Billing" },
  { href: "/dashboard/settings", label: "Settings" }
];

function isActive(pathname: string, href: string): boolean {
  if (href === "/dashboard") return pathname === "/dashboard";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function DashboardNav({ variant }: { variant: "sidebar" | "topbar" }) {
  const pathname = usePathname();

  if (variant === "topbar") {
    return (
      <nav className="flex gap-1 overflow-x-auto px-3 pb-3" aria-label="Dashboard navigation">
        {navItems.map((item) => {
          const active = isActive(pathname, item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={`shrink-0 rounded-full px-3.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.12em] ${
                active
                  ? "bg-arm-500 font-bold text-ink-950"
                  : "text-slate-300 hover:bg-ink-800 hover:text-white"
              }`}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>
    );
  }

  return (
    <nav className="flex flex-1 flex-col gap-1 px-3" aria-label="Dashboard navigation">
      {navItems.map((item) => {
        const active = isActive(pathname, item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={`rounded-lg px-3.5 py-2.5 font-mono text-[11px] uppercase tracking-[0.14em] transition-colors ${
              active
                ? "border-l-2 border-arm-400 bg-ink-800 font-bold text-arm-300"
                : "text-slate-400 hover:bg-ink-800 hover:text-white"
            }`}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
