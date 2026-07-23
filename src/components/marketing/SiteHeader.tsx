import Link from "next/link";

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-50 border-b border-white/5 bg-ink-950/85 backdrop-blur-md">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4 sm:px-10">
        <Link href="/" className="font-display text-xl font-bold tracking-tight text-white" aria-label="JobArms home">
          Job<span className="text-arm-400">Arms</span>
        </Link>
        <nav aria-label="Main navigation" className="flex items-center gap-4 sm:gap-7">
          <Link
            href="/pricing"
            className="font-mono text-[11px] uppercase tracking-[0.18em] text-slate-400 transition-colors hover:text-white"
          >
            Pricing
          </Link>
          <Link
            href="/login"
            className="font-mono text-[11px] uppercase tracking-[0.18em] text-slate-400 transition-colors hover:text-white"
          >
            Log in
          </Link>
          <Link
            href="/signup"
            className="rounded-full border border-arm-500/50 px-4 py-2 font-mono text-[11px] uppercase tracking-[0.18em] text-arm-400 transition-colors hover:bg-arm-500 hover:text-ink-950"
          >
            Get started
          </Link>
        </nav>
      </div>
    </header>
  );
}
