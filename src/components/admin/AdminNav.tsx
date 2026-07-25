"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Admin navigation. Mirrors DashboardNav's shape so the two shells feel like
 * one product, with the operator palette rather than the tenant one.
 */
const navItems = [
  { href: "/admin/dashboard", label: "Overview" },
  { href: "/admin/users", label: "Users" },
  { href: "/admin/system", label: "System" }
];

function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AdminNav({ variant }: { variant: "sidebar" | "topbar" }) {
  const pathname = usePathname();

  if (variant === "topbar") {
    return (
      <nav className="flex gap-1 overflow-x-auto px-3 pb-3" aria-label="Admin navigation">
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

  return (
    <nav className="flex flex-1 flex-col gap-1 px-3" aria-label="Admin navigation">
      {navItems.map((item) => {
        const active = isActive(pathname, item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={`rounded-lg px-3.5 py-2.5 font-mono text-[11px] uppercase tracking-[0.14em] transition-colors ${
              active
                ? "bg-ink-800 font-bold text-arm-300"
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
