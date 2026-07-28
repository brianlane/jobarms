-- A LinkedIn sign-in can answer a fresh-browser login with a one-time PIN sent
-- to the user's own email or phone. We cannot read that, so the run parks and
-- the user types the code in the dashboard. `needs_login_code` is that waiting
-- state, joining the allowed run states.
alter table public.application_runs
  drop constraint if exists application_runs_status_check;

alter table public.application_runs
  add constraint application_runs_status_check
  check (status in ('queued', 'running', 'needs_account_verification', 'needs_login_code',
                    'needs_review', 'approved', 'submitting', 'submitted', 'failed', 'canceled'));
