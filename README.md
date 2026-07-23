# JobArms - jobarms.com

AI job-search platform: one profile, autonomous application. A Gemini-driven
**arm** running a server-side headless browser fills out and submits job
applications for the user - review-gate by default (the arm fills everything,
the user approves before submit), full-auto opt-in per user.

This repository includes:

- Next.js dashboard + marketing app (deployed to Vercel by CI)
- Supabase migrations (Postgres, deny-by-default RLS), auth, and resume storage
- Cloudflare Workers automation edge (`workers/`):
  - **apply-arm** - Browser Rendering (Playwright) + Workflows apply sessions
  - **ingest** - cron polling of public ATS boards into the jobs catalog
- Stripe billing (every AI surface metered per plan; see src/lib/plans.ts)

## Stack

- **App core**: Next.js (App Router, TypeScript, Tailwind 4) on Vercel;
  Supabase for auth (email/password + magic link), Postgres, and storage
- **Automation edge**: Cloudflare Workers - Browser Rendering (Playwright) +
  Workflows for apply sessions (`workers/apply-arm`), cron ingestion
  (`workers/ingest`), both live on custom domains (arm.jobarms.com,
  ingest.jobarms.com)
- **AI**: Gemini API (dedicated "Job Arms" Google project, paid tier - prompts
  are not used for model training). Default model `gemini-3.6-flash` with
  capacity fallback `gemini-3.5-flash-lite`; both env-overridable
  (`GEMINI_TEXT_MODEL`, `GEMINI_FALLBACK_MODEL`) so a model swap is a config
  change, not a deploy
- **Billing**: Stripe (test mode until launch)

## Pricing

| Tier | Price | Arm runs | AI features |
|------|-------|----------|-------------|
| Free | $0 | 3 / month | 2 resume parses (lifetime), review-gate only |
| Premium | $19/mo | up to 200 / month | tailoring + cover letters (100/mo each), full-auto |
| Max | $199/mo | 100 / DAY | tailoring + cover letters + parses (300/mo each), full-auto |

Arm-run metering counts SUCCESSFUL runs only: the slot is reserved at
dispatch and refunded by the worker when a run dies from a system failure
(workflow error, unconfirmed submit). User cancels, including review-gate
timeouts, still count. Quotas live in [src/lib/plans.ts](src/lib/plans.ts);
tier mapping from Stripe prices in [src/lib/billing.ts](src/lib/billing.ts).

The table above is fully enforced in code: three tiers with window-aware
quotas (month, day for Max arm runs, lifetime for free parses), Stripe
price-to-tier mapping (`tierFromPrice`, authoritative env price id with a
lookup-key fallback that can never over-grant Max), full-auto gated to paid
plans server-side, and success-only arm-run metering with idempotent
refunds (details under Budget enforcement).

## How an arm run works

1. User pastes a job URL (`POST /api/applications`). The app normalizes the
   URL, detects the ATS ([src/lib/ats.ts](src/lib/ats.ts) - Greenhouse and
   Lever drive today), upserts the job (public ATS APIs provide
   title/company/description), **reserves a metered run**
   (`try_reserve_arm_run` RPC, row-locked monthly cap), snapshots the
   profile + the user's answer memory + a 24h signed resume URL, and
   dispatches to the worker.
2. The worker starts an **`ApplyRunWorkflow`** instance (id = run id). Steps:
   extract the form (Browser Rendering session #1, screenshot), generate
   answers with Gemini (profile-grounded, never invents facts; EEO fields use
   the profile's vault or decline-to-answer), fill for review (screenshot).
3. **Review gate** (default): the run parks at `needs_review`
   (`step.waitForEvent`, 7-day timeout). The user reviews/edits every answer
   in the dashboard and approves - the app forwards approval to the worker,
   which resumes the workflow.
4. **Submit**: a fresh browser session re-fills with the approved answers,
   attaches the resume, submits, and verifies the ATS confirmation
   (screenshot). Tracker flips to `applied` (or `failed` with an honest
   `submit_unconfirmed` error - never a silent maybe). Full-auto users skip
   step 3.

Run state lives in `application_runs` (step log, answers, screenshots) -
the worker writes it directly to Supabase; the dashboard polls and renders
the timeline, screenshots (signed URLs), and the review UI.

## Arm learning

Every review-gate approval teaches the system, two layers
([src/lib/answer-memory.ts](src/lib/answer-memory.ts), capture in the
approve route, retrieval in the dispatch route):

- **Per-user memory** (`user_answer_memory`): the user's approved answers,
  keyed by normalized question. Hand edits at the review gate are the
  strongest signal: an edit always wins and a later plain approval never
  downgrades it. Job-specific prose ("why this company", cover letters) is
  never memorized. The top 80 entries ride each dispatch and the arm's
  prompt reuses them, weighting `user_edited` entries highest. A user's
  memory feeds ONLY their own runs.
- **Platform lessons** (`platform_field_stats`): anonymous per-ATS
  aggregates: seen/skipped/edited counts per normalized question, plus
  option-choice counts for NON-SENSITIVE select/radio questions only.
  Sensitive topics (visa/sponsorship, EEO categories, salary, clearance,
  and similar) are blocklisted from aggregation; free text is never
  aggregated across users. High-signal rows (option majority >= 60% with
  n >= 3, or skip rate >= 50%) become prompt guidance for every user's runs
  on that ATS.

Capture is best-effort after the approval is already forwarded, so learning
can never block or fail a submission.

## Self-healing arms

Two more layers keep arms working on hostile pages and recovering from
failure ([workers/apply-arm/src/](workers/apply-arm/src/)):

- **Vision recovery + per-domain playbooks** (`arm_playbooks`, RLS-on/no
  policies): when the expected form shape is missing (company career sites
  with lazy embeds, apply buttons, odd layouts), the arm attempts page-wide
  recovery; a strategy that works (click text, iframe hop, scroll) is
  recorded per domain+ats with success/failure counts, and every future run
  on that domain applies the known fix FIRST. The platform heals itself
  with use.
- **Run retry** (`POST /api/applications/:id/retry`, `debug/
  retry-application.ts` mirror): eligible when the latest run is terminal,
  dead-ended at a junk review, or stuck for more than 24h. Refund semantics
  follow the outcome policy above. The application page's run console shows
  the step timeline, screenshots, and retry/cancel controls.

## Budget enforcement

Every model call and every arm run is metered BEFORE the work happens, via
row-locked SQL functions (`try_reserve_arm_run` / `try_reserve_ai_call` and
their release/refund twins). Quotas are window-aware
(`armRunQuota` / `aiCallQuota` in [src/lib/plans.ts](src/lib/plans.ts)):

| Surface | Free | Premium | Max | At the cap |
|---------|------|---------|-----|------------|
| Arm runs | 3 / month | 200 / month | 100 / DAY | 402 + upgrade hint |
| Resume parses | 2 LIFETIME | 100 / month | 300 / month | 402 (upgrade or fair-use message) |
| Resume tailoring | 0 (paid feature) | 100 / month | 300 / month | 402 fair-use message |
| Cover letters | 0 (paid feature) | 100 / month | 300 / month | 402 fair-use message |
| Full-auto mode | no (review-gate only) | yes | yes | forced to review_gate server-side |

Arm-run metering counts SUCCESSFUL runs only, with outcome-based refunds:

- The slot is reserved at dispatch. The worker refunds it (idempotent
  `refund_arm_run` RPC, `slot_refunded` flag row-locked with the decrement)
  ONLY for system failures: workflow errors and unconfirmed submits.
- User behavior consumes: user cancels and review-gate timeouts count
  (`canceled_by` provenance distinguishes user from system cancels).
- The retry endpoint (`POST /api/applications/:id/retry`) follows the same
  policy: a stale run's slot is refunded when the failure was systemic,
  and the fresh run reserves its own slot.
- AI-call slots release on transient model failures so retries cost
  nothing; a "not a resume" verdict stays consumed so junk uploads cannot
  loop free model calls.
- Gemini capacity resilience is separate from metering: every call retries
  transient errors with backoff on the primary model, then falls back to
  `GEMINI_FALLBACK_MODEL` ([src/lib/gemini.ts](src/lib/gemini.ts)).

## Security standards & posture

The platform follows a **deny-by-default** model. New code is expected to
uphold these standards:

- **Row Level Security is on everywhere** with deny-by-default policies.
  Users read/write only their own rows (`profiles`, `resumes`,
  `applications`; read-own on `subscriptions`, `application_runs`,
  `arm_run_usage`, `ai_usage`, `user_answer_memory`).
- **"RLS enabled, no policies" is the deny-all design, not an oversight.**
  Service-only tables (`platform_field_stats`, `arm_playbooks`) and all
  metering/billing writes go exclusively through the Next.js server or the
  worker (service role) after their own auth checks; anon/authenticated
  roles get an unconditional deny at the database layer.
- **DB functions are locked down.** Every RPC (`try_reserve_arm_run`,
  `release_arm_run`, `refund_arm_run`, `try_reserve_ai_call`,
  `release_ai_call`, `record_answer_memory`, `record_field_stats`, trigger
  helpers) revokes EXECUTE from `public`/`anon`/`authenticated` and pins
  `search_path = pg_catalog, public`.
- **Storage is private**: `resumes` and `run-artifacts` buckets use
  owner-folder policies; everything is served via short-lived signed URLs.
  The arm receives a 24h signed resume URL, never bucket access.
- **App and worker authenticate each other** with
  `ARM_WORKER_SHARED_SECRET` bearer on both directions; the ingest worker's
  manual trigger requires `INTERNAL_CRON_SECRET`.
- **Auth email posture**: Site URL pinned to https://jobarms.com with a
  redirect allowlist; all auth emails (confirm, magic link, reset) send from
  hello@jobarms.com via Resend SMTP with branded templates, configured as
  code in `scripts/oneshot/configure-supabase-auth.ts`.
- **`.env` is never committed** (gitignored; `.env.example` documents shape).
  Unit tests strip live credentials (`tests/setup-env.ts`) so no test can
  reach a real service.
- Baseline security headers on every response (HSTS, nosniff, frame-deny,
  CSP base) - see [next.config.ts](next.config.ts).

## Development

```bash
npm install
npm run dev          # Next.js dev server
npm run test:fast    # vitest unit suite (hermetic)
npm test             # + coverage
npm run typecheck    # next typegen + tsc --noEmit
npm run lint
```

Workers:

```bash
cd workers/apply-arm && npm install
npm run check        # typecheck + wrangler deploy --dry-run (no token needed)
npm run deploy       # requires wrangler auth (CI does this on main)
```

## Adding an ATS adapter (required checklist)

An ATS the arm can drive must be wired at EVERY layer, or jobs on it
silently fall back to track-only:

1. **Detection**: add the hostname to `detectAts` and (when the adapter
   ships) to `SUPPORTED_ATS` in [src/lib/ats.ts](src/lib/ats.ts), with tests
   in [tests/ats.test.ts](tests/ats.test.ts).
2. **Adapter**: form selector, `openApplication` (including any
   embed/iframe chasing), `submit`, and `confirmSubmitted` in
   [workers/apply-arm/src/adapters.ts](workers/apply-arm/src/adapters.ts).
3. **Job metadata**: public-API fetcher in
   [src/lib/job-fetch.ts](src/lib/job-fetch.ts) so tracker rows get
   title/company/description.
4. **Ingestion**: board fetcher in
   [workers/ingest/src/fetchers.ts](workers/ingest/src/fetchers.ts) with
   CANONICAL hosted-form URLs (company career sites often wrap the real
   form in an iframe; store the URL the arm can actually drive).
5. **Live smoke**: `npx tsx debug/smoke-arm-run.ts <posting-url>` (review
   gated, never submits) against a real posting; verify field extraction
   count and screenshots.
6. **Redeploy both workers** (CI does it on merge; locally
   `npx wrangler deploy` per worker).

## Environment variables

See [.env.example](.env.example) for the full annotated list. Local secrets
live in the repo-root `.env` (gitignored); Vercel envs are synced from it by
`scripts/oneshot/setup-vercel.ts`; GitHub Actions secrets are set via
`gh secret set`. Workers get production secrets via `wrangler secret put`
(`ARM_WORKER_SHARED_SECRET`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY`,
`GEMINI_API_KEY` for apply-arm; plus `INTERNAL_CRON_SECRET` for ingest).

## Production checklist (high level)

- **Vercel env** (synced by `setup-vercel.ts`): Supabase URL + keys, Stripe
  keys + `STRIPE_WEBHOOK_SECRET` + `STRIPE_PRICE_PREMIUM_MONTHLY` +
  `STRIPE_PRICE_MAX_MONTHLY`, `GEMINI_API_KEY`, `INTERNAL_CRON_SECRET`,
  `ARM_WORKER_SHARED_SECRET`, `ARM_WORKER_URL`, `RESEND_API_KEY`,
  `NEXT_PUBLIC_APP_URL`.
- **GitHub Actions secrets**: `SUPABASE_ACCESS_TOKEN`,
  `SUPABASE_DB_PASSWORD`, `VERCEL_TOKEN`, `VERCEL_ORG_ID`,
  `VERCEL_PROJECT_ID`, `CLOUDFLARE_API_TOKEN` (the scoped `jobarms-ci`
  token: Workers Scripts + jobarms.com zone Workers Routes / DNS / Email
  Routing / Zone Settings).
- **Worker secrets** (`wrangler secret put`, manual after adding a new one):
  listed under Environment variables above.
- **Stripe webhook** registered at `https://jobarms.com/api/webhooks/stripe`
  (`create-stripe-webhook.ts`); rolling the secret means updating `.env` and
  Vercel env.
- **Model knobs**: `GEMINI_TEXT_MODEL` / `GEMINI_FALLBACK_MODEL` swap the
  models without a deploy (Vercel env + `wrangler secret put` on apply-arm).
- **Supabase auth config** is code: rerun
  `scripts/oneshot/configure-supabase-auth.ts` after editing templates,
  Site URL, or SMTP.
- **Cloudflare plan**: workers run on the free Browser Rendering allowance
  (about 10 browser-minutes/day, roughly 3-5 arm runs). Upgrade to Workers
  Paid before real volume; it is the only remaining infra checklist item.

## Operating scripts

One-shot and diagnostic scripts run locally with
`set -a && source .env && set +a`. **They touch production** (service-role
key, live Stripe, live Cloudflare): read before running.

[scripts/oneshot/](scripts/oneshot/):

- `setup-vercel.ts` - Stripe webhook + Vercel envs + domains, one shot
- `create-stripe-prices.ts` / `create-stripe-price-19.ts` /
  `create-stripe-price-max.ts` - products/prices per tier
- `create-stripe-webhook.ts <url>` - register the Stripe webhook
- `configure-supabase-auth.ts` - Site URL, redirect allowlist, Resend SMTP
  sender, branded auth email templates
- `finish-email-routing.ts` - Email Routing rules once the destination
  address is verified
- `comp-premium.ts <email> [--revoke]` - comp an account to Premium without
  Stripe (owner/test accounts)
- `seed-companies.ts` - seed/extend the ingestion company list

[debug/](debug/):

- `smoke-arm-run.ts [url]` - live end-to-end arm smoke against a real
  posting; review-gated so it can NEVER submit; always cancels
- `repro-resume-parse.ts` - run the production parse path against the
  newest stored resume, printing the real error
- `normalize-profile.ts <email>` - apply the resume normalizers to a
  profile saved before normalization shipped
- `retry-application.ts` - operator mirror of the run-retry endpoint

## CI/CD

`.github/workflows/ci.yml` (PRs + pushes to main):

- **quality** (banned-word gates, lint, build), **typecheck**, **test**
  (vitest + coverage artifact), **security** (npm audit, prod deps, high+),
  **workers-check** (typecheck + `wrangler deploy --dry-run` per worker,
  no token needed)
- **supabase-drift** (PR-only): dry-run `db push` against the production
  ledger so migration drift is caught at review time, not deploy time
- **vercel-deploy**: deploys are CI-driven (`vercel.json` disables the git
  integration). On PRs the job first runs the **deploy gate**
  (`.github/scripts/deploy-gate.sh`): it polls until EVERY other check on
  the commit (across all workflows and apps) concluded success, every
  legacy commit status is green, and every review thread is resolved -
  unresolved threads fail immediately since they never self-resolve. Only
  then does the preview deploy. Pushes to main skip the PR-shaped gate and
  run the ordered chain **migrations, edge functions, Vercel production**
  so a failed migration blocks the app deploy
  (`.github/scripts/supabase-deploy.sh`).
- **workers-deploy** (main only): `wrangler deploy` per worker after the
  app deploy, using the scoped `CLOUDFLARE_API_TOKEN`.

Dependabot is fully automated within the merge policy:

- `dependabot.yml` opens weekly grouped minor/patch bumps per package tree
  (majors arrive as their own PRs).
- `dependabot-automerge-label.yml` (pull_request_target) tags every
  Dependabot PR `dependabot-automerge`; safety lives in the merger, not the
  label.
- `dependabot-automerge.yml` evaluates after CI, CodeQL, and Dependency
  Audit complete (plus Vercel's late status events) and squash-merges ONLY
  when every check run on the head commit concluded success (skipped,
  neutral, and cancelled all block), every commit status is green, and
  there are zero unresolved review threads. A red check on a major bump
  blocks it forever, by design.

Also: `audit.yml` (weekly + PR dependency audit across every package tree)
and `codeql.yml` (static analysis).

## Post-merge: what CI does vs what you still do

**CI does automatically on every push to main** (ordered, each step
blocking the next): apply pending Supabase migrations (`supabase db push`,
fails loudly on ledger drift), bulk-deploy any edge functions, deploy the
app to Vercel production, then deploy both Cloudflare workers.

**Still manual after merge (when the change calls for it):**

- New worker secrets: `wrangler secret put` per worker.
- New Vercel env vars (or rerun `setup-vercel.ts`).
- One-shot scripts (`scripts/oneshot/`), e.g. new Stripe prices or Supabase
  auth config changes.

## Writing style: banned words and characters

**Em dashes.** Never use the em dash character (U+2014) in ANY context: site
copy, code, comments, docs, commit messages, or AI-generated output. Use a
comma, colon, period, or plain hyphen instead. Enforced by the `quality` CI
job (greps every tracked file, lockfiles excluded) and by every model prompt.

**"Gemini" in user-facing surfaces.** Public and user views never name the
underlying model: use "AI", "we", or "JobArms" instead. Enforced by the
`quality` CI job, which fails on any occurrence of the word in rendered
component files (`src/**/*.tsx`, comments included, so nothing can drift
into JSX). Internal code (`src/lib`, `workers/`, scripts, env var names) may
reference Gemini freely.

## All work and code modifications must follow this flow

For any change use a worktree and never stop to ask for permission to
continue: **branch (in a worktree) -> PR -> babysit CI + review to green ->
merge**. Never commit directly to main after the initial scaffold. After a
successful merge do the post-merge steps above, return to main, then
**clean up the worktree** (mandatory, below).

### Worktree cleanup (mandatory after merge)

Never leave a worktree behind once its PR is merged. Orphaned worktrees can
leave dev processes running for days, pinning CPU and draining the battery.
After returning to main:

1. **Kill anything still running out of the worktree** - dev servers
   especially. Check with `ps aux | grep jobarms-wt-` (or
   `lsof +D /Users/brianlane/jobarms-wt-<name>`) and kill any PIDs found
   (`kill`, then `kill -9` if they do not die).
2. **Remove the worktree** from the main repo:
   `git worktree remove /Users/brianlane/jobarms-wt-<name>` then
   `git worktree prune`. Worktrees live at `/Users/brianlane/jobarms-wt-*`.
3. **Delete the merged local branch**: `git branch -d <branch>`.
4. **Verify**: `git worktree list` shows only the main checkout, and
   `ps aux | grep jobarms-wt-` finds nothing.

## Roadmap

The full phased build plan lives in [todo.md](todo.md). Phases 0-6 and the
tier system (pricing table above) are built and live. Open items: the
Workers Paid upgrade before real arm-run volume, and the launch checklist
(Stripe live keys + live webhook).
