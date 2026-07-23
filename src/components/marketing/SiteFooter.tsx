import Link from "next/link";

export function SiteFooter() {
  return (
    <footer className="border-t border-white/5 bg-ink-950 px-6 py-16 sm:px-10">
      <div className="mx-auto grid max-w-6xl gap-10 sm:grid-cols-[1fr_auto_auto] sm:gap-16">
        <div>
          <p className="font-display text-2xl font-bold text-white">
            Job<span className="text-arm-400">Arms</span>
          </p>
          <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.25em] text-slate-500">
            Your AI applies. You interview.
          </p>
        </div>
        <nav aria-label="Footer navigation" className="flex flex-col gap-2.5">
          <Link href="/pricing" className="font-mono text-[11px] uppercase tracking-[0.15em] text-slate-500 hover:text-arm-400">
            Pricing
          </Link>
          <Link href="/signup" className="font-mono text-[11px] uppercase tracking-[0.15em] text-slate-500 hover:text-arm-400">
            Sign up
          </Link>
          <Link href="/login" className="font-mono text-[11px] uppercase tracking-[0.15em] text-slate-500 hover:text-arm-400">
            Log in
          </Link>
        </nav>
        <div className="sm:text-right">
          <p className="font-mono text-[11px] tracking-wide text-slate-500">
            <a href="mailto:hello@jobarms.com" className="text-arm-400 hover:text-arm-300">
              hello@jobarms.com
            </a>
          </p>
          <p className="mt-2 font-mono text-[11px] tracking-wide text-slate-500">
            &copy; {new Date().getFullYear()} JobArms. All rights reserved.
          </p>
        </div>
      </div>
    </footer>
  );
}
