import Link from "next/link";
import { PLAN_COPY } from "@/lib/plans";

export const metadata = { title: "Pricing" };

export default function PricingPage() {
  return (
    <main className="min-h-screen bg-[--color-ink-950] px-6 py-16 text-white">
      <div className="mx-auto max-w-4xl text-center">
        <Link href="/" className="text-lg font-bold">
          Job<span className="text-[--color-arm-400]">Arms</span>
        </Link>
        <h1 className="mt-8 text-4xl font-bold">Simple pricing</h1>
        <p className="mt-3 text-slate-300">
          Free to start. Upgrade when you want unlimited arms and AI tailoring.
        </p>
        <div className="mt-12 grid gap-8 text-left sm:grid-cols-2">
          {(["free", "premium"] as const).map((tier) => (
            <div
              key={tier}
              className={`rounded-2xl border p-8 ${
                tier === "premium"
                  ? "border-[--color-arm-500] bg-[--color-ink-900]"
                  : "border-[--color-ink-800] bg-[--color-ink-900]"
              }`}
            >
              <h2 className="text-xl font-bold">{PLAN_COPY[tier].name}</h2>
              <p className="mt-2 text-3xl font-bold">{PLAN_COPY[tier].price}</p>
              <ul className="mt-6 space-y-3 text-sm text-slate-300">
                {PLAN_COPY[tier].features.map((f) => (
                  <li key={f} className="flex gap-2">
                    <span className="text-[--color-arm-400]">✓</span> {f}
                  </li>
                ))}
              </ul>
              <Link
                href="/signup"
                className={`mt-8 block rounded-lg px-4 py-3 text-center font-semibold ${
                  tier === "premium"
                    ? "bg-[--color-arm-500] text-[--color-ink-950] hover:bg-[--color-arm-400]"
                    : "border border-slate-600 text-slate-200 hover:border-slate-400"
                }`}
              >
                {tier === "premium" ? "Go Premium" : "Start free"}
              </Link>
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
