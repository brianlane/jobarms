# JobArms - jobarms.com

AI job-search platform: one profile, autonomous application. A Gemini-driven
**arm** running a server-side headless browser fills out and submits job
applications for the user - review-gate by default (the arm fills everything,
the user approves before submit), full-auto opt-in per user.

This repository includes:

- Next.js dashboard + marketing app (deployed to Vercel by CI)
- Supabase migrations (Postgres, deny-by-default RLS), auth, and resume storage
- Cloudflare Workers automation edge (`workers/`):
  - **apply-arm** - Workflows orchestration for apply sessions
  - **ingest** - cron polling of public ATS boards into the jobs catalog
  - **email-inbound** - Email Routing catch-all for managed applicant mailboxes
- **`vps/render`** - the arm's browser: a persistent Playwright sidecar that
  holds logged-in sessions across multi-page applications
- Stripe billing (every AI surface metered per plan; see src/lib/plans.ts)

## Stack

- **App core**: Next.js (App Router, TypeScript, Tailwind 4) on Vercel;
  Supabase for auth (email/password + magic link), Postgres, and storage
- **Automation edge**: Cloudflare Workers - Workflows orchestration for apply
  sessions (`workers/apply-arm`), cron ingestion (`workers/ingest`), inbound
  mail (`workers/email-inbound`); the first two live on custom domains
  (arm.jobarms.com, ingest.jobarms.com)
- **Browser**: `vps/render`, a persistent Playwright sidecar behind a Cloudflare
  Tunnel. It replaced Browser Rendering because a throwaway browser per phase
  cannot hold the logged-in session an account-gated ATS requires
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

Arm-run metering counts runs the arm did real work for: the slot is reserved
at dispatch and refunded by the worker only when a run dies from a SYSTEM
failure (a workflow error with nothing to show). Work done is paid for even
when the outcome is imperfect: captcha blocks, unconfirmed submits, user
cancels, and review-gate timeouts all count. Quotas live in
[src/lib/plans.ts](src/lib/plans.ts); tier mapping from Stripe prices in
[src/lib/billing.ts](src/lib/billing.ts).

The table above is fully enforced in code: three tiers with window-aware
quotas (month, day for Max arm runs, lifetime for free parses), Stripe
price-to-tier mapping (`tierFromPrice`, authoritative env price id with a
lookup-key fallback that can never over-grant Max), full-auto gated to paid
plans server-side, and success-only arm-run metering with idempotent
refunds (details under Budget enforcement).

## How an arm run works

The apply-arm Worker is the **orchestrator**; the browser lives in
[vps/render](vps/render). Each phase below is one HTTPS call to the sidecar,
which keeps the logged-in session alive between them.

1. User pastes a job URL (`POST /api/applications`). The app normalizes the
   URL, detects the ATS ([src/lib/ats.ts](src/lib/ats.ts) - Greenhouse, Lever,
   Workday, and Ashby have tuned adapters; anything else dispatches the
   best-effort `generic` adapter, below), upserts the job (public ATS APIs
   provide title/company/description), **reserves a metered run**
   (`try_reserve_arm_run` RPC, row-locked monthly cap), snapshots the
   profile + the user's answer memory + a 24h signed resume URL, provisions the
   tenant account for account-gated ATSes, and dispatches to the worker.
2. The worker starts an **`ApplyRunWorkflow`** instance (id = run id). Steps:
   **ensure the candidate account** (account-gated ATSes only; may park at
   `needs_account_verification` for up to 30 minutes while the employer's
   confirmation email is handled), extract the form, generate answers with
   Gemini (profile-grounded, never invents facts; EEO fields use the profile's
   vault or decline-to-answer), fill for review (screenshot).
3. **Review gate** (default): the run parks at `needs_review`
   (`step.waitForEvent`, 7-day timeout). The user reviews/edits every answer
   in the dashboard and approves - the app forwards approval to the worker,
   which resumes the workflow.
4. **Submit**: the sidecar re-fills with the approved answers in the same
   session, attaches the resume, **reads the form back and compares it to those
   answers** (below), submits, and verifies the ATS confirmation (screenshot).
   Tracker flips to `applied`, or `failed` with an honest `captcha_blocked` /
   `submit_unconfirmed` / `verification_failed` error, never a silent maybe.
   Full-auto users skip step 3, unless the read-back catches an answer the form
   did not accept, in which case the run falls BACK to step 3 rather than send it.

Two things span the boundary the same way, because the sidecar has the page and
the worker has the AI credentials:

- **Vision recovery**: when the sidecar cannot reach a form it returns
  `form_not_found` with a screenshot, the worker asks Gemini what stands in the
  way, and calls back with that strategy as the playbook to apply.
- **Captcha solving**: when a visible grid challenge blocks the submit, the
  sidecar ships the grid to the worker's `/internal/solve-captcha`, gets back the
  cells to click, clicks them, and resubmits. That endpoint carries its OWN
  bearer, so a compromise of the box can ask for tile picks and nothing else.

Run state lives in `application_runs` (step log, answers, screenshots) -
the worker writes it directly to Supabase; the dashboard polls and renders
the timeline, screenshots (signed URLs), and the review UI.

## The arm checks its own work

Nothing used to compare what the arm INTENDED with what the form actually held.
A US sanctions question once ended up ticked "Ordinarily a resident of Cuba,
Iran, North Korea, Syria..." on a run whose approved answer read "None of the
above". The answers were right, the fill was wrong, and every layer reported
success; it reached a human only because someone read a screenshot. A separate
bug hid a missing required resume the same way.

So after filling, the sidecar reads the page back
([vps/render/src/extract.ts](vps/render/src/extract.ts) `readFilledState`) and
compares it to the answers it was given
([vps/render/src/verify.ts](vps/render/src/verify.ts)). The comparison is
deliberately **uneven**, because the halves have different costs of being wrong:

- **Choice fields (checkbox/radio): strict set equality.** A wrong tick is a
  factual misstatement made on the user's behalf, and the checked set is
  unambiguous. Both directions are checked, which is what catches a box ticked
  that nobody asked for.
- **Text and dropdowns: flagged only when EMPTY on a field we answered.** Forms
  legitimately rewrite input: a location autocomplete turns "Phoenix, Arizona"
  into "Phoenix, Arizona, United States", phone fields reformat. Comparing those
  strictly would cry wolf on healthy runs, and a warning that is usually noise is
  one people learn to click past, which costs more than it saves.
- **Files are left to `attachResume`**, which already confirms the upload against
  the widget itself.

Three properties are load-bearing and easy to break by accident:

- **Verification runs before advancing a wizard page.** A page's state is gone
  once you leave it, so that is the only moment it can be seen.
- **The LAST look at a field wins.** Verdicts are kept per field, not appended,
  so a control that could not be driven on one page and was driven correctly on
  the next stops counting as a problem. The comparator returns which answers it
  could SEE alongside the disagreements, because "I looked and it was fine" is
  what clears an earlier failure and must be distinguishable from "this page never
  showed me that field".
- **`Mismatch.kind` travels with the mismatch**, never re-derived from the live
  page. By submit time a wizard's earlier pages are out of the DOM, so asking the
  page "was this a choice field?" answers no for everything found before the last
  page, and the interlock waves through the exact wrong ticks it exists to stop.

**The interlock**: when a choice field still disagrees, `/fill` returns
`verification_failed` and does NOT submit. Any remaining mismatches ride back on
every reply, land in `application_runs.fill_mismatches`, and
[RunPanel](src/components/RunPanel.tsx) marks the specific answer with what the
form actually shows rather than a vague banner.

### A refused full-auto run falls back into the review gate

Refusing to submit is only half an answer: the fill is done and the application
is one edit from correct, so the run asks its owner rather than throwing the work
away. It parks at `needs_review` exactly as a review-gate run does, waits 7 days,
and on approval submits ONCE more with the corrected answers.

Three things make that work, and each is load-bearing:

- **The wait listens for the same `approval` event type** as the review gate, so
  [the approve endpoint](src/app/api/runs/[id]/approve/route.ts) and the review UI
  need no changes: both key off `status = needs_review` and neither asks about
  autonomy. Only the step NAMES differ.
- **Step names are Workflows cache keys.** The second submit is a separately
  named step (`submit after correction`), because reusing `submit` would return
  the first attempt's cached `verification_failed` and never resubmit at all. The
  test harness records step names for exactly this reason, and a test asserts no
  two collide, since the mock cannot otherwise see the bug.
- **The user is told.** A full-auto user is not watching for a review request, so
  the worker asks the app to email them
  ([/api/internal/run-needs-review](src/app/api/internal/run-needs-review/route.ts),
  authenticated with `ARM_WORKER_SHARED_SECRET` running the other way). The send
  lives in the app because it owns the only Resend client and the From-header
  rules; the worker holds no email credentials. Best effort throughout: a mail
  that will not send must never cost someone their run.

Exactly one ask, so a form that keeps disagreeing cannot loop somebody forever. A
second refusal, or a correction that never comes, ends the run as `failed` with a
`verification_failed:` prefix, which is precisely where these runs ended before
the fallback existed. Being asked is therefore never worse than not being asked.

**Review-gate runs do not come back here.** That user already reviewed these
answers and the sidecar already tried the alternative tactic, so a second ask
would spend another week to reach the same place.

Metering follows `captcha_blocked` on every path, including a user cancelling a
parked run: the arm did the full application, so the run is consumed. The slot is
released in exactly one place, the outer catch for terminal system failures, and a
test asserts it is never released here.

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

A third layer learns something different: not what to answer, but **how to
operate the widget**.

- **Fill tactics** (`arm_fill_tactics`, RLS-on/no policies, one row per
  domain+ats+kind): sites disagree about how a control wants to be driven. A
  custom widget can leave its real input hidden and wire every behaviour to the
  visible `<label>`, so ticking the input does nothing while clicking the label
  works. When the read-back says a field did not take, the sidecar retries that
  field the OTHER way (choice: click the label instead of the input; text:
  `fill()` instead of typing) and looks again. Whatever worked is recorded via
  `record_fill_tactic`, and later runs on that domain lead with it. A tactic that
  starts failing more than it succeeds is dropped by `record_fill_tactic_failure`,
  the same rule that retires a stale playbook.

Two invariants there are worth keeping. A kind counts as solved only when
NOTHING of that kind is still wrong anywhere on the form, so neither one lucky
field nor one clean wizard page can teach a tactic the rest of the form
disagrees with. And swapping a tactic resets `failure_count`, or the new winner
inherits the loser's record and is ignored from its first day.

## The browser sidecar (why the arm can hold a session)

The arm's browser lives in [vps/render](vps/render): a long-lived Express +
Playwright service behind a Cloudflare Tunnel. It replaced Cloudflare Browser
Rendering entirely, for capability reasons rather than cost:

- **Sessions persist.** Browser Rendering opened a throwaway browser per phase,
  so cookies never survived. The sidecar caches a Chromium context per
  `userId:tenantHost` and writes its cookies to disk, so a login survives both a
  restart and the seven-day review gate. That is the whole reason account-gated
  ATSes (Workday) are reachable at all.
- **No platform caps.** The free Browser Rendering allowance was about 10
  browser-minutes/day, roughly 3-5 arm runs, with 3 concurrent browsers.
- **A real fingerprint.** Datacenter IPs score as bot-like to invisible
  reCAPTCHA. Owning the browser is the "Captcha Layer 3" item from
  [todo.md](todo.md), and it now applies to every run rather than just Workday.

The apply-arm Worker keeps everything durable: the review gate, the
email-verification wait, step retries, and refund policy are Workflows features
we would otherwise rebuild as a queue and state machine on the box. Each browser
phase is one job on the sidecar, so a crash costs a step, never a run. The
sidecar holds no Supabase or Gemini credentials and makes no outbound requests of
its own: the playbook to try, the vision diagnosis, and the resume bytes all
arrive in the request, and the winning strategy comes back for the Worker to
record. That last part is deliberate, not incidental: a service that never
fetches a caller-supplied URL cannot be turned into a fetcher for an
attacker-chosen one.

### Phases are started, not awaited

Cloudflare caps an origin response at 100 seconds, and browser phases routinely
run longer: filling a 24-field Lever form measures ~133s on the KVM1 box, and a
Workday wizard is several pages of that. Waiting inline meant Cloudflare killed
the connection with a 524 and the Worker recorded a transport failure for work
the sidecar had actually COMPLETED.

So `POST /session/ensure`, `/extract`, and `/fill` return a job id immediately
and the Worker polls `GET /jobs/:id` until it settles. Every exchange is short
while the browser takes as long as it needs. Polls back off (5s growing to 20s,
inside a 10-minute budget) because a Worker invocation has a hard subrequest
limit and burning it on status reads would fail a phase for the silliest
possible reason. A job id the sidecar no longer recognizes (it restarted, or the
result aged out) comes back as `job_not_found`, which is not in the
deterministic set, so the Worker simply retries the phase.

`/verify` stays a plain request/response: it is one navigation, and its caller is
the inbound-mail webhook, which wants a prompt answer.

One consequence worth stating plainly: **the Workers Paid upgrade is no longer a
launch blocker.** It only ever bought Browser Rendering minutes. Workflows on the
free plan covers us because WAITING instances do not count toward the concurrency
limit; the real future ceiling is 3,000 workflow steps/day, roughly 300-400 arm
runs/day.

## ATS accounts the arm holds for you

Workday and its kin require a candidate account **per employer tenant**, so the
arm creates one on the user's behalf and never asks them to.

- **The vault** (`site_accounts`, one row per user + tenant host) stores the
  managed alias and a generated 20-character password. It is the most sensitive
  table in the schema, so it is service-role only with **RLS on and no policies**:
  even the owning user cannot read their own row. Passwords are encrypted with
  AES-256-GCM in [src/lib/site-accounts.ts](src/lib/site-accounts.ts) before they
  reach Postgres (`SITE_ACCOUNT_ENC_KEY`), so a database compromise alone yields
  no usable credentials, and GCM's auth tag means a tampered value fails loudly
  instead of being typed into a login form.
- **One account per tenant, deliberately.** Workday creates duplicate candidate
  profiles when identity fields disagree between attempts, so the arm reuses the
  stored credentials and prefers signing in over creating. A unique
  `(user_id, tenant_host)` constraint plus a read-the-winner path makes a
  concurrent dispatch reuse the account rather than register a second one.
- **Locking**: repeated rejected logins (changed password policy, MFA, a captcha
  at sign-in) lock the account after three failures, so future runs fail fast
  instead of burning a browser slot on a doomed login every time.

### The verification loop

Creating an account means the tenant emails a confirmation, so a run has a second
waiting state beside the review gate:

1. The sidecar reports `needs_email_verification`; the run parks at
   `needs_account_verification` (`tenant_host` recorded on the run).
2. The confirmation arrives at the user's managed alias, and the inbound webhook
   extracts the link or one-time code (ATS senders only).
3. The webhook hands it to the sidecar, which completes the confirmation **inside
   the session that created the account**, then marks the vault row verified and
   releases the workflow.

Ordering is deliberate: the mail is stored and forwarded to the user **before**
the browser is touched, so a sidecar outage can never cost them their mail; the
parked run simply times out honestly. The lookup is scoped to a run of that user
actually waiting on a verification, so an old or unsolicited mail cannot drive the
browser. All of it is invisible to the user, whose review gate still shows only
answers and screenshots.

## Managed applicant email

Login-gated ATSes (Workday and friends) require a candidate **account per
employer tenant**, and creating one means receiving a verification mail. So
each user gets a managed mailbox JobArms controls end to end, and never has to
sign up for anything themselves.

- **The alias** (`profiles.applicant_alias`, e.g. `a-7f3k9d2pqr@jobarms.com`)
  is assigned lazily the first time a run needs an account
  ([src/lib/applicant-email.ts](src/lib/applicant-email.ts)); the
  `claim_applicant_alias` RPC makes the assignment atomic and idempotent, and
  a colliding candidate is simply retried.
- **Inbound** flows Cloudflare Email Routing catch-all ->
  [workers/email-inbound](workers/email-inbound) -> `POST /api/email/inbound`
  (shared `EMAIL_INBOUND_SECRET` bearer). Explicit routing rules (hello@) match
  before the catch-all, and non-alias mail keeps forwarding to the team inbox
  exactly as before. Every message is logged to `inbound_emails`, deduped on
  Message-ID so a retried delivery cannot double-store or double-forward.
- **Verification extraction** pulls an account-confirmation link or one-time
  code out of the message, but ONLY when the sender is a known ATS domain
  (`ATS_ACCOUNT_DOMAINS`, subdomain-aware). A lookalike "verify your account"
  mail from anywhere else is stored and forwarded but never becomes something
  an arm will act on.
- **Auto-forwarding**: every message reaching an alias is relayed to the user's
  real inbox. Email Routing can only deliver to *verified* destinations, so the
  relay goes through Resend instead, From the alias with `Reply-To` set to the
  original sender: a recruiter's mail lands in the user's inbox and hitting
  reply goes straight back to the recruiter. A failed forward is a degraded
  notification, never lost mail, since the message is already stored.

#### The forward's From line is load-bearing

It reads `"Dana Recruiter (via JobArms)" <a-7f3k9d2pqr@jobarms.com>`: the
sender's own name, or the local part of their address alone, and **never a full
email address**. Putting the whole address there is the obvious thing to want,
since the point is showing the user who wrote. Don't.

Google lists [using an @gmail.com domain as the display
name](https://support.google.com/mail/answer/81126) among the deceptive
practices it treats as spoofing, and Gmail enforces it by accepting the message
with a `250` and then discarding it. No bounce, nothing in spam, no signal of
any kind. We shipped that header once and forwards silently vanished while every
layer we had reported success. `displayName` in [src/lib/email.ts](src/lib/email.ts)
cuts at the first `@` whatever the source, because plenty of clients set the
display name to the address itself and trusting it would put the domain back.

The same incident is why a send counts as delivered only when the provider says
so: the Resend SDK resolves `{ data, error }` instead of throwing, so ignoring
the return value marks every refused send as successful. Rejections now log
their own reason (provider code and message, never the addresses).

### Branded addresses and domain authentication

Explicit routing rules are matched BEFORE the catch-all, so mail to these
never touches the inbound Worker. All forward to `jobarmsteam@gmail.com`.

| Address | Role |
|---|---|
| `hello@jobarms.com` | Sender for user-facing transactional mail, and a monitored inbox. |
| `support@jobarms.com` | Customer support. Belongs in the footer of user-facing email. |
| `dmarc@jobarms.com` | Receives DMARC aggregate reports. |
| `a-<10 chars>@jobarms.com` | Managed applicant aliases, handled by the catch-all Worker (above). |

Anything else hits the catch-all Worker, which forwards non-alias mail to the
team inbox, so an unrouted address is never silently dropped.

Domain authentication, all three of which must stay in place for transactional
mail to land:

- **SPF** `v=spf1 include:_spf.mx.cloudflare.net ~all` on the root, plus
  `include:amazonses.com` on `send.jobarms.com`, which is the Return-Path
  domain Resend uses.
- **DKIM** published at `resend._domainkey`, signing as `d=jobarms.com`, which
  is what makes DMARC align even though the envelope sender is a subdomain.
- **DMARC** `v=DMARC1; p=none; rua=mailto:dmarc@jobarms.com; fo=1`.
  Deliberately monitoring-only for now. Read a few weeks of aggregate reports
  first, confirm every legitimate sender passes, and only then tighten to
  `p=quarantine`. Skipping that step is how a policy change silently sends
  real user mail to spam.

Manage routing with `wrangler email routing rules list jobarms.com`. Wrangler
auto-loads `.env`, and the `CLOUDFLARE_API_TOKEN` there lacks Email Routing
scope, so prefix with `env -u CLOUDFLARE_API_TOKEN` and `--env-file /dev/null`
to use the OAuth login instead.

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
- **Fill-tactic retry** (`arm_fill_tactics`, see "Arm learning"): a field the
  read-back says did not take is retried with the other way of driving that
  control, then re-verified. The platform learns how to OPERATE a form, where
  playbooks learn how to REACH one.
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

Arm-run metering follows "work done = paid", with outcome-based refunds:

- The slot is reserved at dispatch. The worker refunds it (idempotent
  `refund_arm_run` RPC, `slot_refunded` flag row-locked with the decrement)
  ONLY for system failures: workflow errors that left nothing to show.
- Real work consumes even when the outcome is imperfect: captcha blocks,
  unconfirmed submits, and verification-failed refusals all count, since the
  arm did the full application.
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

## Admin console (/admin)

An operator surface for the whole platform, dark where the product dashboard is
light so it is never ambiguous which one you are looking at.

- **Access is an env allowlist.** `ADMIN_EMAIL` (comma-separated for more than
  one address) is the entire grant; nothing in the database confers admin, so
  there is no row to compromise, and an unset `ADMIN_EMAIL` disables the console
  outright. The admin is an ordinary Supabase account: sign in at `/admin/login`
  with the password `scripts/oneshot/create-admin.ts` set from `ADMIN_PASSWORD`
  (application code never reads that variable).
- **Two gates, one authority.** `src/proxy.ts` keeps signed-out requests off
  `/admin`, but the real check is `getAdminUser()`
  ([src/lib/admin/guard.ts](src/lib/admin/guard.ts)) in the route group's
  layout, which every page and admin API route re-runs server-side.
- **Reads hold the service role** ([src/lib/admin/reads.ts](src/lib/admin/reads.ts)),
  since every table is read-own or service-only. They are bounded: explicit row
  caps, a 30-day window on runs, and head-count requests for the jobs catalog so
  no page pulls a table that grows every half hour. All the arithmetic sits in
  pure functions ([overview.ts](src/lib/admin/overview.ts),
  [run-stats.ts](src/lib/admin/run-stats.ts)) that take rows and return numbers.
- **Every operator mutation is audited** to `admin_audit_log` (RLS on, no
  policies) before the route answers, and the write is fire-and-forget so
  auditing can never take down the action it observes. The trail renders on
  `/admin/system`.
- **`/admin/catalog`** is ingestion health: catalog size, jobs added per day,
  platform mix, per-source freshness, per-board staleness against
  `companies.last_ingested_at`, and whether applications actually come from
  Discover or from pasted links (thousands of ingested jobs nobody applies to
  are a cost, not an asset).
- **`/admin/engagement`** is activation: active users by day, week, and month,
  the signup-to-first-submitted-application funnel, weekly signup cohorts, and
  the engagement segments. Note that "quiet" is ambiguous for this product: the
  best outcome (they got hired) and the worst (they bounced) both look like an
  account that stopped signing in.
- **`/admin/system`** shows configuration as set or unset, never a value, plus
  dependency reachability and when Stripe last wrote a subscription row.
- **`/admin/users`** is the fleet roster (plan, engagement, quota pressure, run
  success rate) and `/admin/users/[id]` is the whole footprint of one account:
  billing, every quota against its own window, applications, runs, resumes,
  remembered questions, vaulted ATS accounts, and managed alias mail.
- **`/admin/runs`** is the fleet run console: filters on status, ATS, and mode,
  a funnel built from the workflow STEP log (how far runs got, not just where
  they are now), median and p95 time per phase, the failure taxonomy parsed out
  of `application_runs.error`, and refund provenance. `/admin/runs/[id]` is
  forensics: the step log, every answer the arm drafted, and signed screenshots.
- **`/admin/ai` and `/admin/revenue`** are the money pages. Every model call is
  written to `ai_spend_events` with the tokens it consumed, by both the app
  (through the single `generateMetered` seam) and the worker, so cost per
  successful application, cost per user, and margin per paying user are actual
  rather than estimated. Unknown models are priced at the primary model's rate,
  which overestimates rather than flatters, and the page says so.
- **`/admin/ats`** is arm health per platform, the self-healing playbooks with
  the decaying ones (failing more than they work) surfaced first, and what the
  platform has learned. The "guiding" flag there is computed by
  `lessonsFromStats`, the same function the dispatch path calls, so the page
  shows the guidance the arm actually gets rather than a second reading of the
  thresholds.
- **Operator actions refuse rather than half-succeed.** Comping a plan is
  refused while Stripe owns the subscription (the next webhook would undo it);
  deleting an account is refused while Stripe is still billing and on the
  operator's own account; storage objects are removed explicitly because the
  Postgres cascade cannot reach them.
- **Privacy holds on the operator surface too.** Profile data is shown as
  counts, the voluntary self-identification vault is reported as populated or
  empty and never read, answer memory lists questions and not answers, and
  vaulted ATS passwords are never selected out of the database.
- Robots disallow `/admin`, and every admin page carries `noindex`.

## Security standards & posture

The platform follows a **deny-by-default** model. New code is expected to
uphold these standards:

- **Row Level Security is on everywhere** with deny-by-default policies.
  Users read/write only their own rows (`profiles`, `resumes`,
  `applications`; read-own on `subscriptions`, `application_runs`,
  `arm_run_usage`, `ai_usage`, `user_answer_memory`).
- **"RLS enabled, no policies" is the deny-all design, not an oversight.**
  Service-only tables (`platform_field_stats`, `arm_playbooks`,
  `site_accounts`, `admin_audit_log`, `ai_spend_events`) and all
  metering/billing writes go exclusively through the Next.js server or the
  worker (service role) after their own auth checks; anon/authenticated
  roles get an unconditional deny at the database layer.
- **DB functions are locked down.** Every RPC (`try_reserve_arm_run`,
  `release_arm_run`, `refund_arm_run`, `try_reserve_ai_call`,
  `release_ai_call`, `record_answer_memory`, `record_field_stats`,
  `record_ai_spend`, trigger
  helpers) revokes EXECUTE from `public`/`anon`/`authenticated` and pins
  `search_path = pg_catalog, public`.
- **Storage is private**: `resumes` and `run-artifacts` buckets use
  owner-folder policies; everything is served via short-lived signed URLs.
  The arm receives a 24h signed resume URL, never bucket access.
- **App and worker authenticate each other** with
  `ARM_WORKER_SHARED_SECRET` bearer on both directions; the ingest worker's
  manual trigger requires `INTERNAL_CRON_SECRET`.
- **Inbound mail is authenticated too**: `/api/email/inbound` requires the
  `EMAIL_INBOUND_SECRET` bearer, and a missing secret throws rather than
  accepting anything. Managed aliases are unguessable (about 8e14 shapes) and
  extraction is gated on the sender domain, so inbound mail can never steer an
  arm on its own.
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

### Test coverage (100%, CI-gated)

Coverage is enforced at **100%** (statements, branches, functions, lines) and
is a hard CI gate: `npm test` runs vitest with `--coverage`, and the v8
`thresholds` in [vitest.config.ts](vitest.config.ts) fail the run (and the
`test` job) if anything in scope drops below 100%. New code must land with the
tests that keep it there.

Coverage scope is the `include` list in the vitest config and grows one layer
at a time as each is brought to full coverage (so the gate is always 100% for
everything measured, never a soft average):

- [x] `src/lib/**` (pure logic + I/O wrappers; external SDKs and `fetch` are
      mocked at the transport seam, matching the hermetic `tests/setup-env.ts`)
- [x] `src/app/api/**` + `src/app/auth/**` route handlers (Supabase, Stripe,
      and the AI libs mocked; each handler's branches exercised via
      `tests/routes/` with the `tests/helpers/supabase.ts` fakes)
- [x] `src/components/**` + all `src/app/**` pages, layouts, the middleware
      (`proxy.ts`), and metadata routes (jsdom + Testing Library; async
      server components are awaited and rendered, `next/font`, `next/og`, and
      Speed Insights mocked). The entire `src` tree is now at 100%.
- [x] `workers/**`: both workers carry their own vitest config with the same
      100% thresholds, run by the Workers Check CI job. The ingest worker
      mocks `fetch`; the apply-arm worker mocks the Cloudflare virtual
      modules, Playwright (a fake Page/locator harness in
      `workers/apply-arm/tests/helpers/fake-page.ts`), and runs the in-page
      extraction callbacks against a crafted fake DOM. Real browser behavior
      is still validated end-to-end by `debug/smoke-arm-run.ts`.

Whole-repo coverage is complete: every phase above is at a literal 100% with
no ignore pragmas.

The unit suite is hermetic: `tests/setup-env.ts` strips every live credential
so no test can reach a real service.

## Workday (the first login-gated ATS)

Workday is where "which ATS did we hand-code" stops being the constraint. Every
employer runs its own tenant (`<tenant>.wdN.myworkdayjobs.com`) with its own
candidate database, so a run has to create an account, confirm it by email, and
then walk a multi-page wizard, all in one session.

- **Detection** is dot-anchored suffix matching in
  [src/lib/ats.ts](src/lib/ats.ts): `host === suffix || host.endsWith("." +
  suffix)`. A bare `endsWith` would also match `notmyworkdayjobs.com`, which for
  an account-gated ATS would mean creating an account on an attacker-chosen page.
- **Metadata** comes from the Candidate Experience Service endpoint the career
  site itself calls (`/wday/cxs/<tenant>/<site>/job<externalPath>`), parsed by
  `parseWorkdayUrl`. Undocumented but public, and far better than scraping a
  JS-rendered page for a tracker row.
- **Account provisioning** happens at dispatch: `ACCOUNT_REQUIRED_ATS` gates it,
  the managed alias is issued, and the tenant credentials are fetched (or
  created) before the run row is written, with the reserved arm-run slot released
  if either step fails so a user is never charged for a run that never started.
- **The wizard** is walked by the sidecar: it extracts each page, accumulates
  every field into ONE review payload deduplicated by name, and on submit replays
  the answers page by page in the same logged-in session.
- **Ingestion** pulls a tenant's postings via the CXS search endpoint. A Workday
  company's `board_token` is `<tenant>.<cluster>/<site>` (e.g. `acme.wd1/Careers`)
  because a posting URL needs all three parts.

## The generic best-effort arm (any link)

Boards without a tuned adapter are not rejected: they dispatch with
`ats: "generic"` (`dispatchAtsOf` in [src/lib/ats.ts](src/lib/ats.ts)), a
deliberate trade of reliability for coverage with three guardrails that hold
at every layer:

- **The user opts in, per link.** The apply form shows the terms (may fail,
  a failed attempt can still use a run) and the create route refuses to
  dispatch without `accept_best_effort` in the body, so a direct API call
  cannot skip the acknowledgment. A retry only proceeds when a prior run
  exists, which is the evidence the terms were accepted at dispatch time.
- **Review-gate only, on any plan.** Enforced in the create and retry routes
  AND re-enforced by the worker (defense in depth): an untuned board never
  submits without a human look.
- **Never account creation.** The generic path refuses the account-vault
  flow even for an ATS someone later marks account-required, and the
  sidecar's generic adapter carries `requiresAccount: false`.

The generic adapter itself does only the universal moves (find a `form`,
click Apply, strict success-text confirmation); everything harder is the
recovery machinery's job. Playbooks and fill tactics are keyed per
domain+ats, so each untuned site the arm visits teaches it that site,
which is what makes best-effort get better with use. `confirmSubmitted` is
deliberately strict: with no known confirmation shape, anything less than
explicit success wording ends as an honest `submit_unconfirmed` (which
consumes the run, exactly what the user acknowledged).

## Adding an ATS adapter (required checklist)

An ATS the arm can drive at full reliability must be wired at EVERY layer;
until then its jobs ride the generic best-effort path above:

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
`GEMINI_API_KEY`, `RENDER_URL`, `RENDER_TOKEN` for apply-arm;
`INTERNAL_CRON_SECRET` for ingest; `EMAIL_INBOUND_SECRET` for email-inbound).
Not a secret and therefore committed in
[wrangler.jsonc](workers/apply-arm/wrangler.jsonc): `APP_BASE_URL`, the app origin
apply-arm calls when a parked run needs its owner emailed.

## Production checklist (high level)

- **Vercel env** (synced by `setup-vercel.ts`): Supabase URL + keys, Stripe
  keys + `STRIPE_WEBHOOK_SECRET` + `STRIPE_PRICE_PREMIUM_MONTHLY` +
  `STRIPE_PRICE_MAX_MONTHLY`, `GEMINI_API_KEY`, `INTERNAL_CRON_SECRET`,
  `ARM_WORKER_SHARED_SECRET`, `ARM_WORKER_URL`, `RESEND_API_KEY`,
  `NEXT_PUBLIC_APP_URL`, `ADMIN_EMAIL` (the admin console is disabled in any
  environment where it is unset).
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
- **Render sidecar**: deploy it (`vps/render/scripts/deploy.sh`), point a
  Cloudflare Tunnel hostname at `127.0.0.1:8085`, and set `RENDER_URL` +
  `RENDER_TOKEN` on the apply-arm worker and in Vercel. Without it arms cannot
  run: there is no browser anywhere else. It currently shares the internal KVM1
  box (`browser.jobarms.com`, its own `cloudflared-jobarms` unit alongside the
  connector already there), capped at one concurrent phase because that box has
  a single vCPU. **The sidecar ships by script, not CI, so "merged" is not
  "live"**: a change under `vps/render/` is not running until you redeploy. See
  "Deploying and verifying the sidecar" below.
- **Cloudflare plan**: the free plan is fine. Workers Paid was only ever needed
  for Browser Rendering minutes; revisit when run volume nears the free tier's
  3,000 workflow steps/day (roughly 300-400 arm runs/day).

## Deploying and verifying the sidecar

CI never touches the box. Anything under `vps/render/` is inert until this runs,
which is the single easiest thing to forget after a green merge.

**Getting in.** KVM1 accepts **publickey only**; password auth is off, so
`HOSTINGER_ROOT_PASSWORD` cannot help and `sshpass` is a dead end. No key on the
laptop is authorized. The working key lives in the **newCoworker** product's
encrypted `vps_ssh_keys` vault, under business `8f3a5c21-7e94-4b6a-9d02-c4e8b1f6a37d`
(NOT the clone business id recorded in `debug/.kvm1-smoke.json`, which has no key
row). Materialize it with newCoworker's own helpers, then delete it afterwards:

```ts
// throwaway in newCoworker/debug/, run with: npx tsx debug/<name>.ts
import { loadEnv } from "./_shared.ts";
loadEnv();
const { getActiveVpsSshKeyForBusiness } = await import("../src/lib/db/vps-ssh-keys.ts");
const key = await getActiveVpsSshKeyForBusiness("8f3a5c21-7e94-4b6a-9d02-c4e8b1f6a37d");
(await import("node:fs")).writeFileSync("/tmp/kvm1_key", key.private_key_pem, { mode: 0o600 });
```

**Deploying.** `deploy.sh` honours `SSH_KEY`, so no agent juggling:

```bash
set -a && source .env && set +a
SSH_KEY=/tmp/kvm1_key RENDER_TOKEN="$RENDER_TOKEN" \
  RENDER_SOLVER_URL="$ARM_WORKER_URL/internal/solve-captcha" \
  RENDER_SOLVER_TOKEN="$SOLVER_SHARED_SECRET" RENDER_MAX_CONCURRENCY=1 \
  bash vps/render/scripts/deploy.sh root@177.7.46.142
```

It is idempotent and ends with a health check. Confirm the code you expect
actually landed (`grep` the built `dist/`), not just that the service is up.

**Verifying a browser change is live.** Two levels, and the first is the one that
catches real bugs:

1. **Drive the deployed build directly on the box.** Import from
   `/opt/jobarms-render/dist/*.js` in a throwaway `.mjs`, `page.setContent()` a
   page shaped like the widget you care about, and assert on real behaviour. This
   is how the fill interlock was proven: a checkbox group that reverts anything
   not driven by its label showed the read-back catching the miss, the interlock
   refusing, the label-tactic retry fixing it, and the right box ending up ticked.
   Delete the probe when done.
2. **Then a real posting through the live API**, `submit: false`. Start a job
   (`POST /fill`), poll `GET /jobs/:id`. Check BOTH directions: correct answers
   must report no mismatches (a check that cries wolf is worse than none), and a
   deliberately impossible answer must be caught.

**Never test the interlock by actually submitting.** If it failed you would send
a junk application to a real employer. Prove the decision (`blocksSubmit`, or a
returned mismatch with `kind: "choice"`) and stop there.

Postings go stale: a URL that 404s or redirect-loops (`ERR_TOO_MANY_REDIRECTS`)
is a closed req, not a regression. Pull a fresh one from the `jobs` table.

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
- `create-admin.ts` - create (or reset the password of) the `ADMIN_EMAIL`
  Supabase account from `ADMIN_PASSWORD`, so `/admin/login` works. Idempotent
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
  (vitest + coverage artifact; the run fails if coverage of the in-scope
  files drops below the 100% threshold), **security** (npm audit, prod deps,
  high+),
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
  Audit complete (plus status events and a 2-hourly sweep that catches app
  checks finishing last) and squash-merges ONLY when every check run on the
  head commit concluded success (skipped, neutral, and cancelled all
  block), every commit status is green, and there are zero unresolved
  review threads. A red check on a major bump blocks it forever, by design.
  Note: merges performed with the workflow token do not trigger a main CI
  run (GitHub recursion prevention), so auto-merged bumps deploy with the
  next regular push to main.

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
2. **Re-anchor every shell OUT of the worktree BEFORE removing it** -
   `cd /Users/brianlane/jobarms` in the session shell (agents: run the next
   command with an explicit `working_directory` on the main checkout). A
   persistent shell left cd'd inside a deleted worktree fails every subsequent
   command - silently no-status, or `spawn /bin/bash ENOENT` - which presents
   as "Execution backend unavailable" and looks like a dead terminal backend
   needing a Cursor restart. It is not the backend; it is the stale cwd. Fix it
   by pointing the next command at the main checkout, not by restarting.
3. **Remove the worktree** from the main repo:
   `git worktree remove /Users/brianlane/jobarms-wt-<name>` then
   `git worktree prune`. Worktrees live at `/Users/brianlane/jobarms-wt-*`.
4. **Delete the merged local branch**: `git branch -d <branch>`.
5. **Verify**: `git worktree list` shows only the main checkout, and
   `ps aux | grep jobarms-wt-` finds nothing.

## Roadmap

The full phased build plan lives in [todo.md](todo.md). Phases 0-6, the tier
system (pricing table above), and the ATS-agnostic expansion (browser sidecar,
managed applicant email, account vault, Workday, captcha solving) are built. Open
items: deploying the sidecar and running the live Workday smoke, the
residential-proxy work for invisible captchas, and the launch checklist (Stripe
live keys + live webhook).
