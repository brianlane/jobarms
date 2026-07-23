-- Phase 1 schema: profiles, subscriptions, arm-run usage metering.
-- Posture: RLS on everywhere, deny-by-default. Users read/write only their
-- own rows; billing + metering writes go through service_role only.

-- ---------------------------------------------------------------------------
-- updated_at helper
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
revoke execute on function public.set_updated_at() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- profiles — the "one profile" that powers every application
-- ---------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null default '',
  full_name text not null default '',
  phone text not null default '',
  location text not null default '',
  headline text not null default '',
  summary text not null default '',
  links jsonb not null default '{}'::jsonb,        -- {linkedin, github, portfolio, ...}
  work_history jsonb not null default '[]'::jsonb, -- [{company, title, start, end, bullets[]}]
  education jsonb not null default '[]'::jsonb,    -- [{school, degree, field, start, end}]
  skills jsonb not null default '[]'::jsonb,       -- ["TypeScript", ...]
  eeo jsonb not null default '{}'::jsonb,          -- voluntary self-id answers vault
  preferences jsonb not null default '{}'::jsonb,  -- {salary_floor, locations[], remote, visa_sponsorship, ...}
  arm_autonomy text not null default 'review_gate'
    check (arm_autonomy in ('review_gate', 'full_auto')),
  onboarding_complete boolean not null default false,
  welcome_sent boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy profiles_select_own on public.profiles
  for select using (auth.uid() = id);
create policy profiles_insert_own on public.profiles
  for insert with check (auth.uid() = id);
create policy profiles_update_own on public.profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);
-- no delete policy: account deletion is a service-role operation

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- subscriptions — Stripe state cache (one row per user, written by webhook)
-- ---------------------------------------------------------------------------
create table public.subscriptions (
  user_id uuid primary key references auth.users (id) on delete cascade,
  stripe_customer_id text unique,
  stripe_subscription_id text,
  plan text not null default 'free' check (plan in ('free', 'premium')),
  status text not null default 'none',
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.subscriptions enable row level security;

create policy subscriptions_select_own on public.subscriptions
  for select using (auth.uid() = user_id);
-- writes: service_role only (no insert/update/delete policies)

create trigger subscriptions_set_updated_at
  before update on public.subscriptions
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- new-user bootstrap: every auth user gets a profile + free subscription row
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, coalesce(new.email, ''))
  on conflict (id) do nothing;

  insert into public.subscriptions (user_id)
  values (new.id)
  on conflict (user_id) do nothing;

  return new;
end;
$$;
revoke execute on function public.handle_new_user() from public, anon, authenticated;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- arm_run_usage — monthly metering for the free tier
-- ---------------------------------------------------------------------------
create table public.arm_run_usage (
  user_id uuid not null references auth.users (id) on delete cascade,
  month_key text not null, -- 'YYYY-MM'
  runs_used integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, month_key)
);

alter table public.arm_run_usage enable row level security;

create policy arm_run_usage_select_own on public.arm_run_usage
  for select using (auth.uid() = user_id);
-- writes: only through the reserve/release functions below (service_role)

-- Atomically reserve one arm run against the monthly cap. p_limit < 0 means
-- unlimited (premium). Returns false when the cap is already spent — the
-- caller must refuse to start the run.
create or replace function public.try_reserve_arm_run(
  p_user_id uuid,
  p_month_key text,
  p_limit integer
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_used integer;
begin
  insert into public.arm_run_usage (user_id, month_key, runs_used)
  values (p_user_id, p_month_key, 0)
  on conflict (user_id, month_key) do nothing;

  select runs_used into v_used
  from public.arm_run_usage
  where user_id = p_user_id and month_key = p_month_key
  for update;

  if p_limit >= 0 and v_used >= p_limit then
    return false;
  end if;

  update public.arm_run_usage
  set runs_used = runs_used + 1, updated_at = now()
  where user_id = p_user_id and month_key = p_month_key;

  return true;
end;
$$;
revoke execute on function public.try_reserve_arm_run(uuid, text, integer)
  from public, anon, authenticated;

-- Release a reserved slot when a run fails before doing any real work
-- (never lets the counter go negative).
create or replace function public.release_arm_run(
  p_user_id uuid,
  p_month_key text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  update public.arm_run_usage
  set runs_used = greatest(runs_used - 1, 0), updated_at = now()
  where user_id = p_user_id and month_key = p_month_key;
end;
$$;
revoke execute on function public.release_arm_run(uuid, text)
  from public, anon, authenticated;
