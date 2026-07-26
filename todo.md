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
- [ ] ~~Cloudflare **Workers Paid** upgrade~~ - DROPPED as a launch item. Its
      only driver was Browser Rendering minutes (~10/day), and the sidecar
      (see "ATS-agnostic expansion") replaces Browser Rendering entirely.
      Revisit when run volume nears 3,000 workflow steps/day.
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

- [x] ~~Upgrade Cloudflare to Workers Paid~~ - no longer needed; Browser
      Rendering is gone (see the sidecar below) and the free plan covers
      Workflows at our volume.
- [x] CLOUDFLARE_API_TOKEN → GitHub secret (`jobarms-ci`, minted Jul 22;
      CI workers-deploy verified green on run 29984023489)
- [x] `wrangler secret put` on both workers (apply-arm:
      ARM_WORKER_SHARED_SECRET, SUPABASE_URL, SUPABASE_SECRET_KEY,
      GEMINI_API_KEY; ingest: SUPABASE_URL, SUPABASE_SECRET_KEY,
      INTERNAL_CRON_SECRET); ARM_WORKER_URL set in .env + Vercel
- [x] Schema: jobs, applications, application_runs (+ screenshots bucket)
- [x] `workers/apply-arm`: ApplyRunWorkflow (extract form → Gemini answers →
      fill + screenshot → review gate (waitForEvent, 7d) → submit → verify)
- [x] ~~Browser Rendering (Playwright) session management~~ - replaced by the
      persistent `vps/render` sidecar; a per-phase browser could not hold a login
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
- [x] Greenhouse live run verified end to end (real Stripe posting, review
      gated): 21 fields extracted, 21 grounded answers, parked at needs_review,
      canceled. It had been failing for every Greenhouse job in the catalog, and
      the cause was not the iframe embedding we assumed: interpolating the
      adapter's comma-separated scope matched the `<form>` element instead of
      its inputs, so extraction saw exactly one field. Fixed in #31

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

## Captcha Layer 3 - trustworthy IP + fingerprint (infrastructure)

The real ceiling for invisible reCAPTCHA v3/Enterprise. It is NOT a vision
problem (no puzzle to see); Google scores the session by IP reputation and
browser fingerprint. Cloudflare Browser Rendering runs from datacenter IPs
that score as bot-like, so hard Enterprise sites will block even a perfectly
filled application. Layers 1 (behavioral realism) and 2 (Gemini-vision solver
for interactive image challenges) do NOT address this. No third-party solver.

- [ ] Move the arm's browser off Cloudflare Browser Rendering to a
      controllable browser (VPS / browser-farm) where we own the fingerprint
      and can attach a residential/mobile proxy per run
- [ ] Residential/mobile proxy integration (per-run rotating egress IP so the
      reCAPTCHA session scores as a real user)
- [ ] Realistic, stable browser fingerprint (real Chromium profile, not
      headless-flagged) + stealth hardening
- [ ] Fall back to this browser only when Layers 1-2 detect a hard invisible
      block, to keep cost/latency low on the common path
- [ ] Re-run the live submit test on the Enterprise sites that blocked under
      Layers 1-2; measure the pass-rate lift

## ATS-agnostic expansion (sidecar browser + managed email + Workday)

The wedge is no longer "which ATS did we hand-code" but "can the arm hold a
session". Login-gated sites (Workday runs a separate tenant, and a separate
candidate ACCOUNT, per employer) need a browser that keeps cookies across a
multi-page wizard and a mailbox that can receive the verification mail.

Phase A - managed applicant email:

- [x] `profiles.applicant_alias` + atomic `claim_applicant_alias` RPC +
      `inbound_emails` log (migration 20260724020000_applicant_email.sql)
- [x] `workers/email-inbound`: Email Routing catch-all -> app webhook for
      managed aliases, plain forward for everything else (explicit hello@ rules
      still take precedence)
- [x] `POST /api/email/inbound`: bearer-auth, Message-ID dedupe, ATS-sender-gated
      verification link/code extraction
- [x] Auto-forward every alias message to the user's real inbox via Resend
      (From the alias, Reply-To the original sender)
- [x] Settings surfaces the managed address read-only (never something to manage)
- [ ] **Manual**: `wrangler secret put EMAIL_INBOUND_SECRET` on email-inbound,
      add `EMAIL_INBOUND_SECRET` to Vercel env, then flip Email Routing
      catch-all to "Send to a Worker" -> jobarms-email-inbound

Phase B - `vps/render` sidecar (the controllable browser):

- [x] Express + Playwright service, bearer auth, SSRF guard, rate limit,
      HTTP-200 structured errors (a Tunnel replaces origin 5xx bodies)
- [x] Persistent per-user-per-tenant contexts with `storageState` on disk so a
      logged-in session survives restarts and the review gate. Map slots are
      reserved synchronously so concurrent first-callers cannot leak a duplicate
      context (and a duplicate candidate account)
- [x] Migrated browser logic (reachForm, playbooks, vision recovery, combobox and
      checkbox filling, resume attach) with playbook + vision INJECTED, so the
      box holds no Supabase or Gemini credentials
- [x] Account handling: sign in, create account, detect the email-verification
      wall, finish a verification by link or one-time code
- [x] Multi-page wizard support (per-page extract/fill, deduped into one review
      payload, bounded page walk)
- [x] `scripts/deploy.sh` (idempotent systemd install, loopback-only bind,
      hardened unit) + CI `render-check` job with a 100% coverage gate
- [x] Deployed to the internal KVM1 (1806097) with its own `cloudflared-jobarms`
      unit beside the connector already on the box; browser.jobarms.com is up
      and `RENDER_URL` + `RENDER_TOKEN` are set in Vercel and on apply-arm.
      Capped at one concurrent phase: that box has a single vCPU
- [x] Phases are started, not awaited. Cloudflare caps an origin response at
      100s and a 24-field Lever fill measures ~133s, so waiting inline turned
      finished work into a 524. `/session/ensure`, `/extract`, and `/fill`
      return a job id and the worker polls `GET /jobs/:id`
- [x] `deploy.sh` installs Chromium with the RESOLVED playwright, not the range
      in package.json: `^1.58.0` resolving to 1.62.0 left the box holding
      browser build 1208 while the runtime wanted 1234
- [x] Cut the apply-arm Workflow over: every browser phase is now an HTTPS call
      to the sidecar, the `BROWSER` binding is gone, and the worker bundle
      dropped to ~26 KiB with only the Workflow binding left
- [x] Workflow gained the account steps: `ensure account`, a 30-minute
      `waitForEvent("account-verified")` park, and a
      `POST /runs/:id/account-verified` endpoint for the app to release it
- [x] Vision recovery spans the boundary: the sidecar returns `form_not_found`
      WITH a screenshot, the worker asks Gemini what to try, and calls back with
      that strategy, so AI credentials stay on the edge
- [ ] Residential/mobile proxy per run, once a hard invisible block is observed
- [x] **Re-homed the interactive-captcha solver.** Solving needs the live page
      (the sidecar's) and a vision model (the worker's), so the sidecar ships the
      grid to `POST /internal/solve-captcha` and clicks what comes back. That
      endpoint has its OWN bearer, so a compromised box can ask for tile picks
      and nothing else. Bounded by a 90s budget; unsolved stays `captcha_blocked`,
      and leaving `RENDER_SOLVER_URL` unset disables solving entirely.
- [ ] **Manual**: generate `SOLVER_SHARED_SECRET`, put it on the apply-arm worker,
      and pass it to the sidecar deploy as `RENDER_SOLVER_TOKEN` along with
      `RENDER_SOLVER_URL=https://arm.jobarms.com/internal/solve-captcha`

Phase C - account vault + verification loop:

- [x] `site_accounts` (service-only, deny-all RLS): per user + tenant host, alias
      email, AES-256-GCM encrypted password, status, failure locking
      (migration 20260724030000_site_accounts.sql)
- [x] One account per tenant enforced by a unique constraint + read-the-winner on
      a concurrent dispatch, so we never create duplicate candidate profiles
- [x] `needs_account_verification` run state + `tenant_host` on the run
      (migration 20260724031000_run_account_verification.sql); a run stalled in
      it for 24h is retry-eligible with a refund
- [x] Inbound webhook consumes the verification: sidecar completes it in the held
      session, vault row marked verified, workflow released. Mail is forwarded
      BEFORE the browser is touched so an outage cannot cost the user their mail
- [x] `src/lib/render.ts` client: structured-error classification (a 200 with an
      error body is permanent; a non-2xx is transport and retryable)
- [ ] **Manual**: `SITE_ACCOUNT_ENC_KEY` (openssl rand -hex 32) + `RENDER_URL` +
      `RENDER_TOKEN` in .env and Vercel

Phase D - Workday:

- [x] Detect `*.myworkdayjobs.com` / `*.myworkdaysite.com` with DOT-ANCHORED
      suffix matching (a bare endsWith also matches `notmyworkdayjobs.com`, which
      for an account-gated ATS means creating an account on a hostile page)
- [x] `parseWorkdayUrl` + job metadata from the public `cxs` endpoint
      (locale / no-locale / `details` URL shapes)
- [x] `SUPPORTED_ATS` + `ACCOUNT_REQUIRED_ATS`; dispatch AND retry provision the
      alias + tenant account before writing the run row, releasing the reserved
      arm-run slot if either step fails so a user is never charged for a run that
      never started
- [x] Multi-page wizard support in the sidecar (per-page extract/fill, one
      deduplicated review payload, submit replays it in the held session)
- [x] Ingest fetcher for a tenant career site (`board_token` is
      `<tenant>.<cluster>/<site>`, e.g. `acme.wd1/Careers`)
- [ ] **Live review-gated smoke on a real Workday posting**, end to end through
      account creation and email verification. No longer blocked on
      infrastructure (sidecar deployed, tunnel up, secrets set, and a Lever run
      proved the whole path); needs a Workday posting seeded to run against.
      `debug/smoke-arm-run.ts` is review-gated so it can never submit, and it
      only knows greenhouse/lever today
- [ ] Seed a few Workday companies once that smoke passes

Note: the Workers Paid upgrade is no longer a launch blocker (it only ever
bought Browser Rendering minutes). Workflows on the free plan covers us since
WAITING instances do not count toward concurrency; the real ceiling becomes
3,000 workflow steps/day, roughly 300-400 arm runs/day.

## Admin console (/admin)

Operator surface for the whole platform, modeled on newCoworker's admin. Access
is the `ADMIN_EMAIL` allowlist; every mutation is audited. See the README
section for the posture.

- [x] Foundation: `getAdminUser()` gate, `/admin/login`, protected route group
      + nav shell, proxy + robots, `admin_audit_log` migration and
      `logAdminAction`, platform overview, `/admin/system` (env matrix,
      dependency probes, audit viewer), `create-admin.ts` one-shot
- [x] Users: fleet roster (sortable and filterable through the URL) + per-user
      detail covering billing, quotas, applications, runs, resumes, memory,
      vaulted ATS accounts, and alias mail; operator actions (comp or revoke a
      plan, resend welcome, delete an account with an impact preview), each
      audited and each refusing rather than half-succeeding
- [ ] Session impersonation ("view as") is deliberately NOT built. Tenant pages
      read through the RLS-scoped client, so real impersonation would mean
      swapping every dashboard read to the service role and giving up RLS as
      defense in depth on the tenant surface. `/admin/users/[id]` mirrors what
      the user sees instead. Revisit only if UI-fidelity debugging demands it
- [x] Runs + ATS health: fleet run console (step-log funnel, failure taxonomy,
      phase durations, refund provenance), run forensics page with signed
      screenshots, per-platform health, playbook decay, and field-stat guidance
      read through the same `lessonsFromStats` the arm prompt uses. Operator
      cancel + force refund; retry stays in `debug/retry-application.ts` rather
      than duplicating the dispatch path
- [x] Money: `ai_spend_events` ledger + `record_ai_spend` RPC, token
      instrumentation in the app (one `generateMetered` seam) and the worker,
      `/admin/ai` unit economics (cost per submitted application, per user,
      margin, fallback rate), `/admin/revenue` (MRR trend, ARPU, conversion,
      pending churn, billing problems)
- [x] Catalog + engagement: `/admin/catalog` (size, daily adds, platform mix,
      per-source freshness, stale boards, Discover attribution) and
      `/admin/engagement` (active users by day/week/month, activation funnel from
      signup to a landed application, weekly cohorts, segments)

## Later / parked

- [ ] Chrome extension (assisted apply in the user's own browser)
- [ ] Networking / referral features
- [ ] Career journal
- [ ] Google OAuth sign-in
- [ ] Mobile
