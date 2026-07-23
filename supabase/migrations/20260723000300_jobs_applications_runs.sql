-- Phase 3 schema: jobs, applications, application_runs (arm sessions).

create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  source text not null default 'manual', -- 'manual' | 'ingest:greenhouse' | 'ingest:lever' | ...
  company text not null default '',
  title text not null default '',
  location text not null default '',
  url text not null,
  ats text not null default 'unknown'
    check (ats in ('greenhouse', 'lever', 'ashby', 'workable', 'unknown')),
  description text not null default '',
  raw jsonb,
  created_at timestamptz not null default now()
);

create unique index jobs_url_idx on public.jobs (url);

alter table public.jobs enable row level security;
-- Jobs are a shared catalog: readable by any signed-in user, written by
-- service role only (manual apply + ingestion both go through the server).
create policy jobs_select_authenticated on public.jobs
  for select using (auth.role() = 'authenticated');

-- ---------------------------------------------------------------------------
create table public.applications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  job_id uuid not null references public.jobs (id) on delete restrict,
  status text not null default 'saved'
    check (status in ('saved', 'applying', 'needs_review', 'applied',
                      'interviewing', 'offer', 'rejected', 'withdrawn', 'failed')),
  resume_id uuid references public.resumes (id) on delete set null,
  cover_letter text,
  notes text not null default '',
  source text not null default 'arm' check (source in ('arm', 'manual')),
  applied_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index applications_user_idx on public.applications (user_id, created_at desc);
create unique index applications_user_job_idx on public.applications (user_id, job_id);

alter table public.applications enable row level security;

create policy applications_select_own on public.applications
  for select using (auth.uid() = user_id);
create policy applications_insert_own on public.applications
  for insert with check (auth.uid() = user_id);
create policy applications_update_own on public.applications
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy applications_delete_own on public.applications
  for delete using (auth.uid() = user_id);

create trigger applications_set_updated_at
  before update on public.applications
  for each row execute function public.set_updated_at();

-- resumes.application_id FK (declared in Phase 2, wired here)
alter table public.resumes
  add constraint resumes_application_fk
  foreign key (application_id) references public.applications (id) on delete set null;

-- ---------------------------------------------------------------------------
-- application_runs — one row per arm session. Users see their runs; ONLY the
-- arm (service role) writes them.
-- ---------------------------------------------------------------------------
create table public.application_runs (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.applications (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'needs_review', 'approved',
                      'submitting', 'submitted', 'failed', 'canceled')),
  autonomy text not null default 'review_gate'
    check (autonomy in ('review_gate', 'full_auto')),
  steps jsonb not null default '[]'::jsonb,      -- [{at, step, detail}]
  form_fields jsonb,                             -- extracted form structure
  answers jsonb,                                 -- field label -> answer the arm filled
  screenshots jsonb not null default '[]'::jsonb,-- storage paths in run-artifacts
  error text,
  workflow_instance_id text,                     -- Cloudflare Workflows instance
  month_key text not null,                       -- metering slot to release on early failure
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index application_runs_app_idx on public.application_runs (application_id, created_at desc);
create index application_runs_user_idx on public.application_runs (user_id, created_at desc);

alter table public.application_runs enable row level security;

create policy application_runs_select_own on public.application_runs
  for select using (auth.uid() = user_id);
-- writes: service role only (the arm + app server)

create trigger application_runs_set_updated_at
  before update on public.application_runs
  for each row execute function public.set_updated_at();
