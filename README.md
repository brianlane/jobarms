# JobArms — jobarms.com

AI job-search platform: one profile, autonomous application. A Gemini-driven
**arm** running a server-side headless browser fills out and submits job
applications for the user — review-gate by default (the arm fills everything,
the user approves before submit), full-auto opt-in per user.

This repository includes:

- Next.js dashboard + marketing app (deployed to Vercel by CI)
- Supabase migrations (Postgres, deny-by-default RLS), auth, and resume storage
- Cloudflare Workers automation edge (`workers/`):
  - **apply-arm** — Browser Rendering (Playwright) + Workflows apply sessions
  - **ingest** — cron polling of public ATS boards into the jobs catalog
- Stripe billing (free tier with metered arm runs; premium unlimited + tailoring)

## Stack

- **App core**: Next.js (App Router, TypeScript, Tailwind 4) on Vercel;
  Supabase for auth (email/password + magic link), Postgres, and storage
- **Automation edge**: Cloudflare Workers — Browser Rendering (Playwright) +
  Workflows for apply sessions (`workers/apply-arm`), cron ingestion
  (`workers/ingest`)
- **AI**: Gemini API (dedicated "Job Arms" Google project, paid tier — prompts
  are not used for model training). Default model `gemini-3.5-flash`
  (override: `GEMINI_TEXT_MODEL`)
- **Billing**: Stripe (test mode until launch)

## Pricing

| Tier | Price | Arm runs | Tailoring |
|------|-------|----------|-----------|
| Free | $0 | 5 / month | — |
| Premium | $20/mo | unlimited | AI resume tailoring + cover letters + full-auto |

One source of truth: [src/lib/plans.ts](src/lib/plans.ts) (limits, gating,
plan copy). The Stripe product/price is created by
`scripts/oneshot/create-stripe-prices.ts` (lookup key
`jobarms_premium_monthly`).

## How an arm run works

1. User pastes a job URL (`POST /api/applications`). The app normalizes the
   URL, detects the ATS ([src/lib/ats.ts](src/lib/ats.ts) — Greenhouse and
   Lever drive today), upserts the job (public ATS APIs provide
   title/company/description), **reserves a metered run**
   (`try_reserve_arm_run` RPC, row-locked monthly cap), snapshots the
   profile + a 24h signed resume URL, and dispatches to the worker.
2. The worker starts an **`ApplyRunWorkflow`** instance (id = run id). Steps:
   extract the form (Browser Rendering session #1, screenshot) → generate
   answers with Gemini (profile-grounded, never invents facts; EEO fields use
   the profile's vault or decline-to-answer) → fill for review (screenshot).
3. **Review gate** (default): the run parks at `needs_review`
   (`step.waitForEvent`, 7-day timeout). The user reviews/edits every answer
   in the dashboard and approves — the app forwards approval to the worker,
   which resumes the workflow.
4. **Submit**: a fresh browser session re-fills with the approved answers,
   attaches the resume, submits, and verifies the ATS confirmation
   (screenshot). Tracker flips to `applied` (or `failed` with an honest
   `submit_unconfirmed` error — never a silent maybe). Full-auto users skip
   step 3.

Run state lives in `application_runs` (step log, answers, screenshots) —
the worker writes it directly to Supabase; the dashboard polls and renders
the timeline, screenshots (signed URLs), and the review UI.

## Security standards & posture

Deny-by-default, inherited from prior builds:

- **RLS on everywhere.** Users read/write only their own rows
  (`profiles`, `resumes`, `applications`, `subscriptions` read-own,
  `application_runs` read-own). Billing, metering, run state, and the shared
  `jobs`/`companies` catalogs are **service-role-write only** (no policies).
- **DB functions are locked down**: `try_reserve_arm_run`, `release_arm_run`,
  and trigger helpers revoke EXECUTE from `public`/`anon`/`authenticated` and
  pin `search_path`.
- **Storage is private**: `resumes` and `run-artifacts` buckets use
  owner-folder policies; everything is served via short-lived signed URLs.
- **App ↔ worker auth**: `ARM_WORKER_SHARED_SECRET` bearer on both directions;
  the ingest worker's manual trigger requires `INTERNAL_CRON_SECRET`.
- **`.env` is never committed** (gitignored; `.env.example` documents shape).
  Unit tests strip live credentials (`tests/setup-env.ts`) so no test can
  reach a real service.
- Baseline security headers on every response (HSTS, nosniff, frame-deny,
  CSP base) — see [next.config.ts](next.config.ts).

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

## Environment variables

See [.env.example](.env.example) for the full annotated list. Local secrets
live in the repo-root `.env` (gitignored); Vercel envs are synced from it by
`scripts/oneshot/setup-vercel.ts`; GitHub Actions secrets are set via
`gh secret set`. Workers get production secrets via `wrangler secret put`
(`ARM_WORKER_SHARED_SECRET`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY`,
`GEMINI_API_KEY` for apply-arm; plus `INTERNAL_CRON_SECRET` for ingest).

## CI/CD

`.github/workflows/ci.yml` (PRs + pushes to main):

- **quality** (lint + build), **typecheck**, **test** (vitest + coverage
  artifact), **security** (npm audit, prod deps, high+), **workers-check**
  (typecheck + `wrangler deploy --dry-run` per worker — no token needed)
- **supabase-drift** (PR-only): dry-run `db push` against the production
  ledger so migration drift is caught at review time, not deploy time
- **vercel-deploy**: deploys are CI-driven (`vercel.json` disables the git
  integration). PRs get preview deploys after checks pass; pushes to main run
  the ordered chain **migrations → edge functions → Vercel production** so a
  failed migration blocks the app deploy
  (`.github/scripts/supabase-deploy.sh`)
- **workers-deploy** (main only): `wrangler deploy` per worker after the app
  deploy — **skips gracefully until `CLOUDFLARE_API_TOKEN` is set** (Workers
  Paid + token are the Phase 3 go-live checklist in [todo.md](todo.md))

Also: `audit.yml` (weekly + PR dependency audit across every package tree),
`codeql.yml` (static analysis), `dependabot.yml` (weekly grouped bumps).

## Operations (one-shot scripts)

`scripts/oneshot/` — run locally with `set -a && source .env && set +a`:

- `create-stripe-prices.ts` — Premium product + price (idempotent)
- `create-stripe-webhook.ts <url>` — register the Stripe webhook
- `setup-vercel.ts` — Stripe webhook + Vercel envs + domains, one shot
- `seed-companies.ts` — seed/extend the ingestion company list

## All work and code modifications must follow this flow

For any change: **branch → PR → babysit CI + review to green → merge**. Never
commit directly to main after the initial scaffold. After merge: watch the
main CI run to green (it applies migrations and deploys), then delete the
merged branch. If using worktrees, remove the worktree and prune after merge.

## Roadmap

The full phased build plan lives in [todo.md](todo.md). Phases 0–6 are built;
the remaining go-live items are the Phase 3 checklist (Workers Paid +
CLOUDFLARE_API_TOKEN + worker secrets) and the launch checklist (Stripe live
keys, Resend domain).
