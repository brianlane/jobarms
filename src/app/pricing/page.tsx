import Link from "next/link";
import { SiteHeader } from "@/components/marketing/SiteHeader";
import { SiteFooter } from "@/components/marketing/SiteFooter";
import { PLAN_COPY } from "@/lib/plans";

export const metadata = {
  title: "Pricing",
  description:
    "JobArms pricing: a real free plan with autonomous applications every month, and Premium for unlimited arms, AI resume tailoring, and cover letters."
};

export default function PricingPage() {
  return (
    <div className="bg-ink-950 text-white">
      <SiteHeader />

      <section className="hero-glow px-6 py-20 sm:px-10">
        <div className="mx-auto max-w-4xl text-center">
          <p className="eyebrow">Pricing</p>
          <h1 className="mt-5 font-display text-4xl font-bold tracking-tight sm:text-5xl">
            Simple pricing, honest free plan
          </h1>
          <p className="mx-auto mt-5 max-w-xl text-lg text-slate-300">
            Start free and send real applications today. Upgrade when you want unlimited arms and
            AI tailoring.
          </p>
        </div>

        <div className="mx-auto mt-16 grid max-w-4xl gap-8 text-left sm:grid-cols-2">
          {(["free", "premium"] as const).map((tier) => (
            <div
              key={tier}
              className={`relative rounded-2xl border p-8 sm:p-10 ${
                tier === "premium" ? "border-arm-500 bg-ink-900" : "border-white/10 bg-ink-900"
              }`}
            >
              {tier === "premium" && (
                <span className="absolute -top-3 left-8 rounded-full bg-arm-500 px-3 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.15em] text-ink-950">
                  Most popular
                </span>
              )}
              <h2 className="font-display text-xl font-bold">{PLAN_COPY[tier].name}</h2>
              <p className="mt-3 font-display text-4xl font-bold">
                {PLAN_COPY[tier].price}
              </p>
              <ul className="mt-8 space-y-3.5 text-[15px] text-slate-300">
                {PLAN_COPY[tier].features.map((f) => (
                  <li key={f} className="flex gap-3">
                    <span className="mt-0.5 text-arm-400">✓</span>
                    <span>{f}</span>
                  </li>
                ))}
              </ul>
              <Link
                href="/signup"
                className={`mt-10 block rounded-full px-4 py-3.5 text-center font-semibold transition-colors ${
                  tier === "premium"
                    ? "bg-arm-500 text-ink-950 hover:bg-arm-400"
                    : "border border-slate-600 text-slate-200 hover:border-arm-400 hover:text-white"
                }`}
              >
                {tier === "premium" ? "Go Premium" : "Start free"}
              </Link>
            </div>
          ))}
        </div>

        <p className="mx-auto mt-12 max-w-xl text-center text-sm text-slate-500">
          Cancel anytime from your billing page. Every plan keeps the review gate: nothing is ever
          submitted without your approval unless you opt into full auto.
        </p>
      </section>

      <SiteFooter />
    </div>
  );
}
