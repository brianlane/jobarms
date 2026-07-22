# JobArms — jobarms.com

AI job-search platform: one profile, autonomous application. A Gemini-driven
**arm** running a server-side headless browser fills out and submits job
applications for the user — review-gate by default (the arm fills everything,
the user approves before submit), full-auto opt-in per user.

This repository includes:

- Next.js dashboard + marketing app (deployed to Vercel by CI)
- Supabase migrations (Postgres, deny-by-default RLS) and edge-function scaffolding
- Cloudflare Workers automation edge (`workers/`): the apply arm
  (Browser Rendering + Workflows) and job-ingestion workers
- Stripe billing (free tier with metered arm runs; premium unlimited + tailoring)

## Stack

- **App core**: Next.js (App Router, TypeScript, Tailwind) on Vercel;
  Supabase for auth (email/password + magic link), Postgres, and resume storage
- **Automation edge**: Cloudflare Workers — Browser Rendering (Playwright) +
  Workflows for apply sessions, cron Workers for job ingestion
- **AI**: Gemini API (dedicated "Job Arms" Google project, paid tier —
  prompts are not used for model training)
- **Billing**: Stripe (test mode until launch)

## Pricing (draft)

| Tier | Price | Arm runs | Tailoring |
|------|-------|----------|-----------|
| Free | $0 | limited / month | — |
| Premium | TBD | unlimited | AI resume tailoring + cover letters |

## Security standards & posture

The platform follows a **deny-by-default** model, inherited from prior builds:

- **Row Level Security is on by default** with deny-by-default policies.
  Users read/write only their own rows. Service/secret tables run RLS with
  **no policies** — only `service_role` (which bypasses RLS) can touch them;
  the Supabase advisor's INFO-level `rls_enabled_no_policy` findings on those
  tables are confirmation the lockdown is active, not an oversight.
- **`.env` is never committed** (gitignored; `.env.example` documents shape).
- **App ↔ Worker auth**: the Next.js app and the Cloudflare apply-arm worker
  authenticate each other with `ARM_WORKER_SHARED_SECRET` on both directions.
- Resume files and run screenshots live in **private** storage buckets,
  served via short-lived signed URLs only.

## Development

```bash
npm install
npm run dev          # Next.js dev server
npm test             # vitest unit suite
npm run typecheck    # next typegen + tsc --noEmit
npm run lint
```

Workers:

```bash
cd workers/apply-arm && npm install
npm run check        # typecheck + wrangler deploy --dry-run
npm run dev          # local (requires Workers Paid features for browser)
```

## Environment variables

See `.env.example` for the full annotated list. Local secrets live in the
repo-root `.env` (gitignored). Workers read local secrets from
`workers/*/.dev.vars` (gitignored) and production secrets via
`wrangler secret put`.

## CI/CD

`.github/workflows/ci.yml` (PRs + pushes to main):

- **quality** (lint + build), **typecheck**, **test** (vitest + coverage
  artifact), **security** (npm audit, prod deps, high+), **workers-check**
  (typecheck + `wrangler deploy --dry-run` per worker)
- **supabase-drift** (PR-only): dry-run `db push` against the production
  ledger so migration drift is caught at review time, not deploy time
- **vercel-deploy**: deploys are CI-driven (`vercel.json` disables the git
  integration). PRs get preview deploys after checks pass; pushes to main run
  the ordered chain **migrations → edge functions → Vercel production** so a
  failed migration blocks the app deploy instead of shipping code whose
  schema never landed (`.github/scripts/supabase-deploy.sh`)
- **workers-deploy** (main only): `wrangler deploy` for each worker once the
  app deploy succeeds (requires `CLOUDFLARE_API_TOKEN`; skips gracefully
  until it is set)

Also: `audit.yml` (weekly + PR dependency audit across every package tree),
`codeql.yml` (static analysis), `dependabot.yml` (weekly grouped bumps).

## All work and code modifications must follow this flow

For any change: **branch → PR → babysit CI + review to green → merge**. Never
commit directly to main after the initial scaffold. After merge: watch the
main CI run to green (it applies migrations and deploys), then delete the
merged branch. If using worktrees, remove the worktree and prune after merge.

## Roadmap

The full phased build plan lives in [todo.md](todo.md). Current phase: **0 — scaffold**.
