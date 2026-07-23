-- AI-call metering (resume parses, tailoring, cover letters), mirroring the
-- arm_run_usage design: row-locked monthly reservation, service-role only.

create table public.ai_usage (
  user_id uuid not null references auth.users (id) on delete cascade,
  month_key text not null, -- 'YYYY-MM'
  kind text not null check (kind in ('resume_parse', 'tailor_resume', 'cover_letter')),
  used integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, month_key, kind)
);

alter table public.ai_usage enable row level security;

create policy ai_usage_select_own on public.ai_usage
  for select using (auth.uid() = user_id);
-- writes: only through the functions below (service_role)

-- Atomically reserve one AI call against the monthly cap for its kind.
-- p_limit < 0 means unlimited. Returns false when the cap is spent.
create or replace function public.try_reserve_ai_call(
  p_user_id uuid,
  p_month_key text,
  p_kind text,
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
  insert into public.ai_usage (user_id, month_key, kind, used)
  values (p_user_id, p_month_key, p_kind, 0)
  on conflict (user_id, month_key, kind) do nothing;

  select used into v_used
  from public.ai_usage
  where user_id = p_user_id and month_key = p_month_key and kind = p_kind
  for update;

  if p_limit >= 0 and v_used >= p_limit then
    return false;
  end if;

  update public.ai_usage
  set used = used + 1, updated_at = now()
  where user_id = p_user_id and month_key = p_month_key and kind = p_kind;

  return true;
end;
$$;
revoke execute on function public.try_reserve_ai_call(uuid, text, text, integer)
  from public, anon, authenticated;

-- Release a reserved call when the operation failed before doing useful work.
create or replace function public.release_ai_call(
  p_user_id uuid,
  p_month_key text,
  p_kind text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  update public.ai_usage
  set used = greatest(used - 1, 0), updated_at = now()
  where user_id = p_user_id and month_key = p_month_key and kind = p_kind;
end;
$$;
revoke execute on function public.release_ai_call(uuid, text, text)
  from public, anon, authenticated;
