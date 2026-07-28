-- Search-driven Easy Apply batches: one row per "apply to N LinkedIn matches"
-- request. The arm searches LinkedIn itself, then applies to each result in one
-- held session, each application still metered as an arm run.
--
-- Posture: read-own like applications/runs; ONLY the app server and the
-- apply-arm worker (service role) write it, same as application_runs.

create table public.apply_batches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  status text not null default 'queued'
    check (status in ('queued', 'searching', 'running', 'needs_login_code',
                      'completed', 'failed', 'canceled')),
  -- The search the arm runs on LinkedIn.
  keywords text not null default '',
  location text not null default '',
  remote boolean not null default false,
  -- What the user asked for, what metering actually granted, and progress.
  requested integer not null default 0,
  reserved integer not null default 0,
  processed integer not null default 0,   -- jobs attempted
  applied integer not null default 0,     -- confirmed submissions
  failed integer not null default 0,      -- per-job failures (kept, batch continues)
  -- Slots actually spent on work (submitted, or failed AFTER real application
  -- work like a captcha). Cancel and finalize release `reserved - consumed`,
  -- so system failures and never-attempted jobs are never charged.
  consumed integer not null default 0,
  -- The meter key the reservation was made under, so unused slots release to the
  -- same window even if the month rolls over mid-batch.
  month_key text not null default '',
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index apply_batches_user_idx on public.apply_batches (user_id, created_at desc);

alter table public.apply_batches enable row level security;

create policy apply_batches_select_own on public.apply_batches
  for select using (auth.uid() = user_id);
-- writes: service role only (the app server + the apply-arm worker)

create trigger apply_batches_set_updated_at
  before update on public.apply_batches
  for each row execute function public.set_updated_at();

-- Which batch a run belongs to, when it was dispatched by one. Null for the
-- ordinary single-application runs. `set null` so deleting a batch never
-- cascades away the run history the tracker shows.
alter table public.application_runs
  add column if not exists batch_id uuid references public.apply_batches (id) on delete set null;

create index if not exists application_runs_batch_idx
  on public.application_runs (batch_id, created_at desc);

-- ---------------------------------------------------------------------------
-- try_reserve_arm_runs - reserve UP TO p_count slots at once, returning the
-- number actually granted (0..p_count). The batch caps its search at whatever
-- it gets, so a user near their monthly cap simply applies to fewer jobs
-- instead of being refused outright. p_limit < 0 means unlimited.
-- ---------------------------------------------------------------------------
create or replace function public.try_reserve_arm_runs(
  p_user_id uuid,
  p_month_key text,
  p_limit integer,
  p_count integer
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_used integer;
  v_grant integer;
begin
  if p_count <= 0 then
    return 0;
  end if;

  insert into public.arm_run_usage (user_id, month_key, runs_used)
  values (p_user_id, p_month_key, 0)
  on conflict (user_id, month_key) do nothing;

  select runs_used into v_used
  from public.arm_run_usage
  where user_id = p_user_id and month_key = p_month_key
  for update;

  if p_limit < 0 then
    v_grant := p_count;
  else
    v_grant := least(p_count, greatest(p_limit - v_used, 0));
  end if;

  if v_grant > 0 then
    update public.arm_run_usage
    set runs_used = runs_used + v_grant, updated_at = now()
    where user_id = p_user_id and month_key = p_month_key;
  end if;

  return v_grant;
end;
$$;
revoke execute on function public.try_reserve_arm_runs(uuid, text, integer, integer)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- release_arm_runs - hand back p_count reserved-but-unused slots (a batch that
-- found fewer jobs than it reserved, or whose jobs died from system failures).
-- Never lets the counter go negative.
-- ---------------------------------------------------------------------------
create or replace function public.release_arm_runs(
  p_user_id uuid,
  p_month_key text,
  p_count integer
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if p_count <= 0 then
    return;
  end if;
  update public.arm_run_usage
  set runs_used = greatest(runs_used - p_count, 0), updated_at = now()
  where user_id = p_user_id and month_key = p_month_key;
end;
$$;
revoke execute on function public.release_arm_runs(uuid, text, integer)
  from public, anon, authenticated;
