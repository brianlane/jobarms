-- Admin audit trail: every operator action (comp a plan, refund a run slot,
-- delete a user, impersonate) records who did what to which target, so the
-- /admin/system log answers "who changed this?" without grepping server logs.
--
-- Posture matches platform_field_stats and arm_playbooks: RLS on with NO
-- policies, which is the deny-all design. Only the Next.js server holding the
-- service role writes and reads it, after its own admin check.

create table public.admin_audit_log (
  id uuid primary key default gen_random_uuid(),
  admin_email text not null,
  action text not null,                -- snake_case verb, e.g. 'comp_plan'
  target_user_id uuid references auth.users (id) on delete set null,
  target_run_id uuid references public.application_runs (id) on delete set null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index admin_audit_log_created_idx on public.admin_audit_log (created_at desc);
create index admin_audit_log_target_user_idx
  on public.admin_audit_log (target_user_id, created_at desc);

alter table public.admin_audit_log enable row level security;
-- RLS on, no policies: service role only (see the README security section).

-- ---------------------------------------------------------------------------
-- Indexes for the fleet-wide admin reads. Every user-facing query is already
-- covered by a (user_id, created_at) index; the admin surfaces slice by status
-- and by time across ALL users, which those indexes cannot serve.
-- ---------------------------------------------------------------------------
create index application_runs_status_created_idx
  on public.application_runs (status, created_at desc);
create index application_runs_created_idx
  on public.application_runs (created_at desc);
create index applications_status_created_idx
  on public.applications (status, created_at desc);
create index jobs_created_idx on public.jobs (created_at desc);
