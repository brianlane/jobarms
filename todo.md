# JobArms build plan — todo.md

Simplify-style job-search platform at **jobarms.com** whose wedge is autonomous
application: a Gemini-driven **arm** running a server-side headless browser
fills out and submits job applications for the user. Review-gate by default,
full-auto opt-in. Multi-user with Stripe free/premium tiers from day 1.

Working agreement: branch → PR → babysit CI to green → merge (see README).
Check items off as they land on `main`.

## Phase 0 — Setup + scaffold

Manual account setup (done unless unchecked):

- [x] Google AI Studio "Job Arms" project + API key, paid tier billing enabled
- [x] Supabase project (`fjzvlshxcgbuhrhxdsiu`, us-east-2)
- [x] Stripe account (sandbox keys; live keys at launch)
- [x] GitHub repo `brianlane/jobarms`
- [x] Vercel project + token
- [x] Cloudflare zone `jobarms.com` (existing account)
- [x] Local `.env` populated (gitignored)
- [ ] Cloudflare **Workers Paid** upgrade (deferred to Phase 3 by decision)
- [ ] `CLOUDFLARE_API_TOKEN` minted for CI worker deploys (Phase 3)
- [ ] Resend account + jobarms.com domain verification (Phase 1 email)
- [ ] Stripe live keys + live webhook (launch)

Repo scaffold:

- [ ] First commit: .gitignore (protects .env), README skeleton, this todo.md
- [ ] Next.js 15 + TypeScript + Tailwind app scaffold (src/app)
- [ ] `workers/` directory scaffold (apply-arm, ingest) with wrangler configs
- [ ] `supabase/` init: config.toml (tracked), first migration
- [ ] `.env.example` documenting every variable
- [ ] CI: ci.yml (quality, typecheck, test, security, workers-check,
      supabase-drift, vercel-deploy, workers-deploy)
- [ ] CI: audit.yml (all package trees), codeql.yml, dependabot.yml
- [ ] GitHub Actions secrets set (`gh secret set` from local .env)
- [ ] Vercel project linked + domain jobarms.com attached
- [ ] vercel.json (git integration off — CI owns deploys)

## Phase 1 — App skeleton (auth + billing)

- [ ] Supabase Auth: email/password + magic link (Google OAuth parked)
- [ ] Auth middleware + session handling (@supabase/ssr)
- [ ] Marketing landing page (hero, features, pricing, CTA)
- [ ] Dashboard shell (nav: Applications, Profile, Discover, Billing, Settings)
- [ ] Schema: profiles, subscriptions + RLS deny-by-default posture
- [ ] Stripe: one-shot script to create products/prices (test mode)
- [ ] Stripe: checkout session + customer portal routes
- [ ] Stripe: webhook route (subscription lifecycle → subscriptions table)
- [ ] Plan gating helper (free: N arm runs/month; premium: unlimited + tailoring)
- [ ] Transactional email via Resend (welcome, receipts ride Stripe)

## Phase 2 — Profile + resume (the "one profile")

- [ ] Schema: resumes table + private storage bucket
- [ ] Resume upload (PDF/DOCX) → Supabase Storage
- [ ] Gemini resume parse → structured profile JSON (work history, education,
      skills, links)
- [ ] Onboarding wizard: upload → review parsed profile → preferences +
      dealbreakers (salary floor, locations, remote, visa) → EEO answers vault
- [ ] Profile editor (all sections editable post-onboarding)
- [ ] Arm autonomy setting: review-gate (default) / full-auto

## Phase 3 — Apply arm (the product)

- [ ] **Manual: upgrade Cloudflare to Workers Paid** ($5/mo)
- [ ] **Manual: mint CLOUDFLARE_API_TOKEN → GitHub secret**
- [ ] Schema: jobs, applications, application_runs (+ screenshots bucket)
- [ ] `workers/apply-arm`: Workflow (navigate → extract form → Gemini answers →
      fill → screenshot each step → pause at review gate → submit)
- [ ] Browser Rendering (Playwright) session management
- [ ] ATS adapters: Greenhouse, then Lever (detect from URL/DOM)
- [ ] App: paste-a-job-URL → create application + queue arm run
- [ ] App ↔ worker auth (ARM_WORKER_SHARED_SECRET both directions)
- [ ] Review-gate UI: answers + screenshots, edit-then-approve, submit resumes
      the workflow
- [ ] Full-auto path (skips gate when user opted in)
- [ ] Free-tier run metering (reserve slot before run starts)
- [ ] Failure handling: arm marks run failed with reason + last screenshot;
      user can retry or apply manually

## Phase 4 — Tracker

- [ ] Applications pipeline view: saved → applying → needs_review → applied →
      interviewing → offer / rejected (list + kanban)
- [ ] Application detail: exactly what the arm submitted (answers, resume
      version, screenshots, timestamps)
- [ ] Manual status updates + notes
- [ ] Manually-tracked applications (applied elsewhere, still tracked)

## Phase 5 — Tailoring (premium)

- [ ] Gemini resume tailoring per job (keyword analysis vs job description)
- [ ] Tailored resume version stored as a child of the base resume
- [ ] Cover letter generator
- [ ] Tailored PDF becomes the file the arm uploads for that application
- [ ] Premium gating wired through the plan helper

## Phase 6 — Discovery (post-MVP)

- [ ] `workers/ingest`: cron polling of public ATS JSON endpoints
      (Greenhouse, Lever, Ashby, Workable) for a tracked-company list
- [ ] Aggregator API connectors (Adzuna / JSearch / USAJobs)
- [ ] Jobs normalized into Supabase `jobs`
- [ ] Matching feed scored against profile preferences + dealbreakers
- [ ] "Queue for arm" from the feed (this is where full-auto pays off)

## Later / parked

- [ ] Chrome extension (assisted apply in the user's own browser)
- [ ] Networking / referral features
- [ ] Career journal
- [ ] Google OAuth sign-in
- [ ] Mobile
