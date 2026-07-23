import Link from "next/link";
import { SiteHeader } from "@/components/marketing/SiteHeader";
import { SiteFooter } from "@/components/marketing/SiteFooter";
import {
  FREE_ARM_RUNS_PER_MONTH,
  MAX_ARM_RUNS_PER_DAY,
  MAX_PRICE_USD_MONTHLY,
  PREMIUM_ARM_RUNS_PER_MONTH,
  PREMIUM_PRICE_USD_MONTHLY
} from "@/lib/plans";

const steps = [
  {
    n: "01",
    title: "Build one profile",
    body: "Upload your resume once. JobArms turns it into a structured profile: work history, skills, preferences, and dealbreakers that power every application."
  },
  {
    n: "02",
    title: "Point an arm at a job",
    body: "Paste a job link or pick from your matches. A JobArms arm opens the real application in a real browser and fills out every field using your profile."
  },
  {
    n: "03",
    title: "Review, approve, interview",
    body: "The arm pauses before submitting so you can review and edit every answer. Or flip on full auto and let it apply while you sleep."
  }
];

const features = [
  {
    title: "Real browser, real applications",
    body: "Arms drive the actual employer application in a headless browser and screenshot every step, so you see exactly what was submitted."
  },
  {
    title: "Answers grounded in your resume",
    body: "Every answer comes from your profile. Arms never invent employers, degrees, or credentials. Questions they cannot answer are flagged for you."
  },
  {
    title: "Review gate by default",
    body: "Nothing is submitted until you approve it. Edit any answer at the gate, then send. Full auto is a setting you opt into, not a surprise."
  },
  {
    title: "AI resume tailoring",
    body: "Premium tailors your resume to each job's keywords and renders a fresh PDF. That tailored version is the file the arm uploads."
  },
  {
    title: "A tracker that fills itself",
    body: "Every arm run lands in your pipeline automatically: what was asked, what was answered, when it was submitted, and what happened next."
  },
  {
    title: "Matches from live boards",
    body: "JobArms polls real company career boards around the clock and scores fresh postings against your skills, locations, and salary floor."
  }
];

const faqs = [
  {
    q: "Will it apply to jobs without asking me?",
    a: "Only if you turn on full auto. The default is a review gate: the arm fills everything out, then waits for you to read and approve every answer before it submits."
  },
  {
    q: "Does the AI make things up on my applications?",
    a: "No. Answers are generated only from your profile and resume. If a question needs information the profile does not have, the arm skips it and flags it for you at the review gate."
  },
  {
    q: "Which job sites can the arms handle?",
    a: "Arms currently drive Greenhouse and Lever applications, which cover a large share of startup and tech hiring. Anything else is saved to your tracker so nothing falls through."
  },
  {
    q: "Is it really free?",
    a: `Yes. The free plan includes ${FREE_ARM_RUNS_PER_MONTH} autonomous applications a month, your full profile, and the tracker. Premium is $${PREMIUM_PRICE_USD_MONTHLY}/month for up to ${PREMIUM_ARM_RUNS_PER_MONTH} applications a month plus AI tailoring and cover letters. Max is $${MAX_PRICE_USD_MONTHLY}/month for ${MAX_ARM_RUNS_PER_DAY} applications every day, and only successful submissions count.`
  }
];

const jsonLd = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "JobArms",
  applicationCategory: "BusinessApplication",
  operatingSystem: "Web",
  url: "https://jobarms.com",
  description:
    "JobArms builds one profile from your resume, then its AI arms open real job applications in a real browser, answer every question the way you would, and submit with your approval.",
  offers: [
    { "@type": "Offer", price: "0", priceCurrency: "USD", name: "Free" },
    {
      "@type": "Offer",
      price: String(PREMIUM_PRICE_USD_MONTHLY),
      priceCurrency: "USD",
      name: "Premium"
    },
    {
      "@type": "Offer",
      price: String(MAX_PRICE_USD_MONTHLY),
      priceCurrency: "USD",
      name: "Max"
    }
  ]
};

export default function LandingPage() {
  return (
    <div className="bg-ink-950 text-white">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <SiteHeader />

      {/* Hero */}
      <section className="hero-glow px-6 pb-24 pt-20 sm:px-10 sm:pt-28">
        <div className="mx-auto max-w-4xl text-center">
          <p className="eyebrow">Your AI applies. You interview.</p>
          <h1 className="mt-6 font-display text-4xl font-bold leading-[1.05] tracking-tight sm:text-6xl">
            Stop filling out job applications.
            <br />
            <span className="text-arm-400">Grow arms.</span>
          </h1>
          <p className="mx-auto mt-7 max-w-2xl text-lg leading-relaxed text-slate-300">
            JobArms builds one profile from your resume, then its AI arms open real job
            applications in a real browser, answer every question the way you would, and submit
            with your approval, or fully autonomously.
          </p>
          <div className="mt-10 flex flex-col items-center justify-center gap-4 sm:flex-row">
            <Link
              href="/signup"
              className="w-full rounded-full bg-arm-500 px-8 py-4 text-center font-semibold text-ink-950 transition-colors hover:bg-arm-400 sm:w-auto"
            >
              Start free
            </Link>
            <Link
              href="/pricing"
              className="w-full rounded-full border border-slate-600 px-8 py-4 text-center font-semibold text-slate-200 transition-colors hover:border-arm-400 hover:text-white sm:w-auto"
            >
              See pricing
            </Link>
          </div>
          <p className="mt-6 font-mono text-[11px] uppercase tracking-[0.2em] text-slate-500">
            {FREE_ARM_RUNS_PER_MONTH} free applications a month. No card required.
          </p>
        </div>
      </section>

      <div className="divider-glow mx-auto max-w-6xl" />

      {/* How it works */}
      <section className="px-6 py-24 sm:px-10">
        <div className="mx-auto max-w-6xl">
          <p className="eyebrow">How it works</p>
          <h2 className="mt-4 max-w-2xl font-display text-3xl font-bold tracking-tight sm:text-4xl">
            Three steps between you and your next interview
          </h2>
          <div className="mt-14 grid gap-10 md:grid-cols-3">
            {steps.map((step) => (
              <div key={step.n} className="rounded-2xl border border-white/5 bg-ink-900 p-8">
                <p className="font-mono text-sm font-bold text-arm-400">{step.n}</p>
                <h3 className="mt-4 font-display text-xl font-semibold">{step.title}</h3>
                <p className="mt-3 leading-relaxed text-slate-400">{step.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="border-t border-white/5 bg-ink-900/50 px-6 py-24 sm:px-10">
        <div className="mx-auto max-w-6xl">
          <p className="eyebrow">What you get</p>
          <h2 className="mt-4 max-w-2xl font-display text-3xl font-bold tracking-tight sm:text-4xl">
            Built for people who would rather interview than copy-paste
          </h2>
          <div className="mt-14 grid gap-x-12 gap-y-12 sm:grid-cols-2 lg:grid-cols-3">
            {features.map((f) => (
              <div key={f.title}>
                <div className="mb-4 h-px w-10 bg-arm-500" />
                <h3 className="font-display text-lg font-semibold">{f.title}</h3>
                <p className="mt-2 text-[15px] leading-relaxed text-slate-400">{f.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Pricing preview */}
      <section className="px-6 py-24 sm:px-10">
        <div className="mx-auto max-w-4xl text-center">
          <p className="eyebrow">Pricing</p>
          <h2 className="mt-4 font-display text-3xl font-bold tracking-tight sm:text-4xl">
            Free to start. Plans that scale to {MAX_ARM_RUNS_PER_DAY} applications a day.
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-slate-400">
            The free plan is a real plan: {FREE_ARM_RUNS_PER_MONTH} autonomous applications every
            month, forever. Premium (${PREMIUM_PRICE_USD_MONTHLY}/mo) raises that to{" "}
            {PREMIUM_ARM_RUNS_PER_MONTH} a month with AI tailoring. Max ($
            {MAX_PRICE_USD_MONTHLY}/mo) unlocks {MAX_ARM_RUNS_PER_DAY} every day, and only
            successful submissions count.
          </p>
          <Link
            href="/pricing"
            className="mt-8 inline-block rounded-full border border-arm-500/50 px-8 py-3.5 font-semibold text-arm-400 transition-colors hover:bg-arm-500 hover:text-ink-950"
          >
            Compare plans
          </Link>
        </div>
      </section>

      <div className="divider-glow mx-auto max-w-6xl" />

      {/* FAQ */}
      <section className="px-6 py-24 sm:px-10">
        <div className="mx-auto max-w-3xl">
          <p className="eyebrow">Questions</p>
          <h2 className="mt-4 font-display text-3xl font-bold tracking-tight sm:text-4xl">
            The things everyone asks first
          </h2>
          <dl className="mt-12 space-y-10">
            {faqs.map((faq) => (
              <div key={faq.q}>
                <dt className="font-display text-lg font-semibold text-white">{faq.q}</dt>
                <dd className="mt-2 leading-relaxed text-slate-400">{faq.a}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      {/* Final CTA */}
      <section className="border-t border-white/5 bg-ink-900/50 px-6 py-24 text-center sm:px-10">
        <div className="mx-auto max-w-2xl">
          <h2 className="font-display text-3xl font-bold tracking-tight sm:text-4xl">
            Your next application can write itself
          </h2>
          <p className="mt-4 text-slate-400">
            Upload your resume, point an arm at a job, and see the difference tonight.
          </p>
          <Link
            href="/signup"
            className="mt-8 inline-block rounded-full bg-arm-500 px-10 py-4 font-semibold text-ink-950 transition-colors hover:bg-arm-400"
          >
            Start free
          </Link>
        </div>
      </section>

      <SiteFooter />
    </div>
  );
}
