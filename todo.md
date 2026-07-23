# JobArms build plan - todo.md

Simplify-style job-search platform at **jobarms.com** whose wedge is autonomous
application: a Gemini-driven **arm** running a server-side headless browser
fills out and submits job applications for the user. Review-gate by default,
full-auto opt-in. Multi-user with Stripe free/premium tiers from day 1.

Working agreement: branch → PR → babysit CI to green → merge (see README).
Check items off as they land on `main`.

## Phase 0 - Setup + scaffold

Manual account setup (done unless unchecked):

- [x] Google AI Studio "Job Arms" project + API key, paid tier billing enabled
- [x] Supabase project (`fjzvlshxcgbuhrhxdsiu`, us-east-2)
- [x] Stripe account (sandbox keys; live keys at launch)
- [x] GitHub repo `brianlane/jobarms`
- [x] Vercel project + token
- [x] Cloudflare zone `jobarms.com` (existing account)
- [x] Local `.env` populated (gitignored)
- [ ] Cloudflare **Workers Paid** upgrade ($5/mo, dashboard → Workers & Pages
      → Plans). Everything is deployed and working on the free allowance;
      the binding limit that matters is Browser Rendering (~10 browser-
      minutes/day = roughly 3-5 arm runs). Upgrade before real usage.
- [x] `CLOUDFLARE_API_TOKEN` for CI worker deploys: the `jobarms-ci` token
      (scoped: Workers Scripts + jobarms.com zone Workers Routes / DNS /
      Email Routing / Zone Settings) is in .env + GitHub secrets; CI
      workers-deploy verified green with it. The original broad account
      token (`job-arms-token-cf`) is now unused except as the token-admin
      credential that minted jobarms-ci; keep or delete it in dashboard →
      Account API Tokens.
- [x] Inbound email (honedtech-style): Cloudflare Email Routing enabled,
      hello@ + catch-all forward to jobarmsteam@gmail.com (destination
      verified Jul 23)
- [x] Resend account + jobarms.com domain verified (Jul 23);
      RESEND_API_KEY in .env + Vercel. Welcome email sends from
      hello@jobarms.com
- [ ] Stripe live keys + live webhook (launch)

Repo scaffold:

- [x] First commit: .gitignore (protects .env), README skeleton, this todo.md
- [x] Next.js 16 + TypeScript + Tailwind app scaffold (src/app)
- [x] `workers/` directory scaffold (apply-arm, ingest) with wrangler configs
- [x] `supabase/` init: config.toml (tracked), first migration
- [x] `.env.example` documenting every variable
- [x] CI: ci.yml (quality, typecheck, test, security, workers-check,
      supabase-drift, vercel-deploy, workers-deploy)
- [x] CI: audit.yml (all package trees), codeql.yml, dependabot.yml
- [x] GitHub Actions secrets set (`gh secret set` from local .env)
- [x] Vercel project envs + domains attached (scripts/oneshot/setup-vercel.ts)
- [x] vercel.json (git integration off - CI owns deploys)
- [x] Cloudflare DNS records for Vercel (A @ 216.198.79.1, CNAME www, both
      DNS-only) + Vercel cert issued; jobarms.com and www live over HTTPS

## Phase 1 - App skeleton (auth + billing)

- [x] Supabase Auth: email/password + magic link (Google OAuth parked)
- [x] Auth session proxy + route guards (@supabase/ssr, src/proxy.ts)
- [x] Marketing landing page (hero, features, CTA) + /pricing
- [x] Dashboard shell (nav: Applications, Discover, Profile, Billing, Settings)
- [x] Schema: profiles, subscriptions, arm_run_usage + RLS deny-by-default
- [x] Stripe: one-shot product/price script (ran - price_1TwA3uHGoK50aYq0dmrBqsnx)
- [x] Stripe: checkout session + customer portal routes
- [x] Stripe: webhook route (registered at jobarms.com/api/webhooks/stripe)
- [x] Plan gating helper (free: 5 arm runs/month; premium: unlimited + tailoring)
- [x] Welcome email via Resend (no-ops until RESEND_API_KEY is set)

## Phase 2 - Profile + resume (the "one profile")

- [x] Schema: resumes table + private storage buckets (resumes, run-artifacts)
- [x] Resume upload (PDF/DOCX) → Supabase Storage
- [x] Gemini resume parse → structured profile JSON
- [x] Onboarding wizard: upload → review parsed profile → preferences +
      dealbreakers → done
- [x] Profile editor (basics, links, work history, education, skills)
- [x] Arm autonomy setting: review-gate (default) / full-auto (Settings)

## Phase 3 - Apply arm (the product)

- [ ] **Manual: upgrade Cloudflare to Workers Paid** ($5/mo). The workers
      deployed and run on the free allowance (Browser Rendering free tier =
      10 browser-minutes/day, roughly 3-5 arm runs); upgrade before real
      usage volume. This is the ONLY remaining Cloudflare item.
- [x] CLOUDFLARE_API_TOKEN → GitHub secret (`jobarms-ci`, minted Jul 22;
      CI workers-deploy verified green on run 29984023489)
- [x] `wrangler secret put` on both workers (apply-arm:
      ARM_WORKER_SHARED_SECRET, SUPABASE_URL, SUPABASE_SECRET_KEY,
      GEMINI_API_KEY; ingest: SUPABASE_URL, SUPABASE_SECRET_KEY,
      INTERNAL_CRON_SECRET); ARM_WORKER_URL set in .env + Vercel
- [x] Schema: jobs, applications, application_runs (+ screenshots bucket)
- [x] `workers/apply-arm`: ApplyRunWorkflow (extract form → Gemini answers →
      fill + screenshot → review gate (waitForEvent, 7d) → submit → verify)
- [x] Browser Rendering (Playwright) session management
- [x] ATS adapters: Greenhouse + Lever
- [x] App: paste-a-job-URL → create application + dispatch arm run
- [x] App ↔ worker auth (ARM_WORKER_SHARED_SECRET both directions)
- [x] Review-gate UI: editable answers + screenshots + approve
- [x] Full-auto path (skips gate per profile setting)
- [x] Free-tier run metering (row-locked reserve before dispatch, release on
      early failure)
- [x] Failure handling: honest failed status + error + screenshots; job stays
      tracked
- [x] Live end-to-end run verified (debug/smoke-arm-run.ts): real Lever
      posting → form extracted (30+ fields) → Gemini answers grounded in the
      smoke profile → filled + screenshots → parked at needs_review →
      canceled. Review-gate smoke NEVER submits.
- [ ] Greenhouse live run: most big boards now redirect to company careers
      sites that lazy-embed the GH iframe; the adapter chases the iframe but
      needs validation against a company that still hosts on
      job-boards.greenhouse.io

## Phase 4 - Tracker

- [x] Applications list with status pipeline (saved → applying → needs_review
      → applied → interviewing → offer / rejected / withdrawn / failed)
- [x] Application detail: run timeline, exactly what the arm submitted,
      screenshots
- [x] Manual status updates + notes
- [x] Manually-tracked applications ("Track only" mode)
- [ ] Kanban board view (list shipped first; kanban when it earns its keep)

## Phase 5 - Tailoring (premium)

- [x] Gemini resume tailoring per job + keyword analysis (incorporated/missing)
- [x] Tailored resume stored as `kind='tailored'` child linked to application
- [x] Cover letter generator (stored on the application)
- [x] Tailored PDF rendered (pdf-lib) and set as the application's resume -
      the arm uploads it
- [x] Premium gating wired through the plan helper (402 + upgrade CTA)

## Phase 6 - Discovery (post-MVP)

- [x] `workers/ingest`: cron (7,37 * * * *) polling Greenhouse/Lever/Ashby/
      Workable public endpoints for the `companies` list
- [x] Jobs normalized + upserted into `jobs` (conflict key: url)
- [x] Matching feed (/dashboard/discover) scored against profile skills,
      headline, and location/remote preferences
- [x] "Send an arm" from the feed (prefills the apply form)
- [x] Company seed script (scripts/oneshot/seed-companies.ts)
- [ ] Aggregator API connectors (Adzuna / JSearch / USAJobs) - needs API keys
- [x] Ingest worker deployed (ingest.jobarms.com, cron live) + 10 companies
      seeded - ~4,000 jobs in the catalog from the first two sweeps

## Tier spec v2 implementation (COMPLETE, Jul 23)

The README pricing table is fully enforced in code:

- [x] Free tier: 3 arm runs/month, 2 resume parses LIFETIME (window-aware
      quotas + meterKey in src/lib/plans.ts), review-gate only (canFullAuto
      forced server-side at dispatch and retry)
- [x] Premium: 200 arm runs/month cap
- [x] Max tier ($199/mo): Stripe price created (STRIPE_PRICE_MAX_MONTHLY in
      .env + Vercel), 100 arm runs/DAY (day-keyed reservation), 300/mo AI
      quotas (migration 20260723211000_max_tier.sql)
- [x] Tier mapping from Stripe price IDs (tierFromPrice in
      src/lib/billing.ts; unknown prices can never over-grant Max)
- [x] Success-only metering: idempotent refund_arm_run RPC + slot_refunded
      flag + canceled_by provenance (migration
      20260723220000_run_refunds.sql); worker refunds system failures only
- [x] Pricing page + PLAN_COPY for three tiers
- [x] Run retry endpoint + run console + retry-application.ts debug mirror

## Later / parked

- [ ] Chrome extension (assisted apply in the user's own browser)
- [ ] Networking / referral features
- [ ] Career journal
- [ ] Google OAuth sign-in
- [ ] Mobile
