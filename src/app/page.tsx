import Link from "next/link";

const steps = [
  {
    title: "Build one profile",
    body: "Upload your resume once. Gemini parses it into a structured profile — work history, skills, preferences, dealbreakers — that powers every application."
  },
  {
    title: "Point an arm at a job",
    body: "Paste a job link (or pick from your matches). A JobArms arm opens the application in a real browser and fills out every field using your profile."
  },
  {
    title: "Review, approve, interview",
    body: "The arm pauses before submitting so you can review every answer — or flip on full-auto and let it apply while you sleep."
  }
];

export default function LandingPage() {
  return (
    <main className="min-h-screen bg-[--color-ink-950] text-white">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-6">
        <div className="text-xl font-bold tracking-tight">
          Job<span className="text-[--color-arm-400]">Arms</span>
        </div>
        <nav className="flex items-center gap-6 text-sm text-slate-300">
          <Link href="/pricing" className="hover:text-white">
            Pricing
          </Link>
          <Link href="/login" className="hover:text-white">
            Log in
          </Link>
          <Link
            href="/signup"
            className="rounded-full bg-[--color-arm-500] px-4 py-2 font-semibold text-[--color-ink-950] hover:bg-[--color-arm-400]"
          >
            Get started
          </Link>
        </nav>
      </header>

      <section className="mx-auto max-w-6xl px-6 pb-24 pt-20 text-center">
        <p className="mb-4 text-sm font-semibold uppercase tracking-widest text-[--color-arm-400]">
          Your AI applies. You interview.
        </p>
        <h1 className="mx-auto max-w-3xl text-5xl font-bold leading-tight tracking-tight">
          Stop filling out job applications. <span className="text-[--color-arm-400]">Grow arms.</span>
        </h1>
        <p className="mx-auto mt-6 max-w-2xl text-lg text-slate-300">
          JobArms builds one profile from your resume, then its AI arms open real job applications
          in a real browser, answer every question the way you would, and submit — with your
          approval, or fully autonomously.
        </p>
        <div className="mt-10 flex justify-center gap-4">
          <Link
            href="/signup"
            className="rounded-full bg-[--color-arm-500] px-8 py-3 text-lg font-semibold text-[--color-ink-950] hover:bg-[--color-arm-400]"
          >
            Start free
          </Link>
          <Link
            href="/pricing"
            className="rounded-full border border-slate-600 px-8 py-3 text-lg font-semibold text-slate-200 hover:border-slate-400"
          >
            See pricing
          </Link>
        </div>
      </section>

      <section className="border-t border-[--color-ink-800] bg-[--color-ink-900] py-20">
        <div className="mx-auto grid max-w-6xl gap-10 px-6 md:grid-cols-3">
          {steps.map((step, i) => (
            <div key={step.title}>
              <div className="mb-3 text-sm font-bold text-[--color-arm-400]">Step {i + 1}</div>
              <h2 className="mb-2 text-xl font-semibold">{step.title}</h2>
              <p className="text-slate-300">{step.body}</p>
            </div>
          ))}
        </div>
      </section>

      <footer className="mx-auto flex max-w-6xl items-center justify-between px-6 py-10 text-sm text-slate-400">
        <span>© {new Date().getFullYear()} JobArms</span>
        <span>jobarms.com</span>
      </footer>
    </main>
  );
}
