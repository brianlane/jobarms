-- Runs can now park waiting for an ATS account email to be verified.
--
-- Login-gated ATSes make the arm create a candidate account before it can even
-- see the form, and the tenant confirms that account by email. The run therefore
-- has a second waiting state alongside the review gate: the workflow parks, the
-- inbound-email webhook completes the confirmation through the sidecar, and the
-- run resumes.

-- `needs_account_verification` joins the allowed run states.
alter table public.application_runs
  drop constraint if exists application_runs_status_check;

alter table public.application_runs
  add constraint application_runs_status_check
  check (status in ('queued', 'running', 'needs_account_verification', 'needs_review',
                    'approved', 'submitting', 'submitted', 'failed', 'canceled'));

-- The tenant this run is applying on, e.g. 'acme.wd1.myworkdayjobs.com'.
-- Denormalized onto the run so the inbound-email webhook can resolve "which
-- tenant is this user's parked run waiting on" with one indexed lookup, without
-- re-deriving it from the job URL.
alter table public.application_runs
  add column if not exists tenant_host text;

-- The webhook's exact query: this user's newest run in the waiting state.
create index if not exists application_runs_pending_verification_idx
  on public.application_runs (user_id, created_at desc)
  where status = 'needs_account_verification';
