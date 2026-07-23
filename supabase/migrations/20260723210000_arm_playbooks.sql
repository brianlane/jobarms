-- Self-healing arm playbooks: when vision recovery finds the real
-- application form on a site (wrong page shape, lazy embeds, apply buttons),
-- the winning strategy is recorded per domain+ats. Every future run on that
-- domain applies the known fix FIRST, so the platform heals itself with use.

create table public.arm_playbooks (
  domain text not null,
  ats text not null,
  strategy jsonb not null,          -- {action: 'click'|'iframe'|'scroll', click_text?: string}
  success_count integer not null default 1,
  failure_count integer not null default 0,
  last_success_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (domain, ats)
);

alter table public.arm_playbooks enable row level security;
-- RLS on, no policies: service role only (the worker reads/writes directly)

-- Record a successful recovery strategy (upsert + increment).
create or replace function public.record_arm_playbook(
  p_domain text,
  p_ats text,
  p_strategy jsonb
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  insert into public.arm_playbooks (domain, ats, strategy)
  values (p_domain, p_ats, p_strategy)
  on conflict (domain, ats) do update set
    strategy = excluded.strategy,
    success_count = public.arm_playbooks.success_count + 1,
    last_success_at = now(),
    updated_at = now();
end;
$$;
revoke execute on function public.record_arm_playbook(text, text, jsonb)
  from public, anon, authenticated;

-- Record that the stored strategy failed (so stale playbooks decay).
create or replace function public.record_arm_playbook_failure(
  p_domain text,
  p_ats text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  update public.arm_playbooks
  set failure_count = failure_count + 1, updated_at = now()
  where domain = p_domain and ats = p_ats;
end;
$$;
revoke execute on function public.record_arm_playbook_failure(text, text)
  from public, anon, authenticated;
