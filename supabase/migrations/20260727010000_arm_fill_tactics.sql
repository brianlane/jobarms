-- How to OPERATE a form on a given site, learned with use.
--
-- arm_playbooks already remembers how to REACH a form. This is the other half:
-- sites disagree about how a control wants to be driven. A custom widget can
-- leave its real input hidden and wire every behaviour to the visible label, so
-- ticking the input does nothing while clicking the label works.
--
-- The arm no longer has to know that in advance. It fills, reads the form back,
-- and when a field did not take it tries the other way and looks again. Whatever
-- worked lands here, and later runs on that domain lead with it instead of
-- rediscovering it every time.
--
-- One row per (domain, ats, kind), because a site can want one thing for its
-- checkboxes and another for its text fields.

create table public.arm_fill_tactics (
  domain text not null,
  ats text not null,
  kind text not null check (kind in ('choice', 'text')),
  tactic text not null check (tactic in ('control', 'label', 'type', 'set')),
  success_count integer not null default 1,
  failure_count integer not null default 0,
  last_success_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (domain, ats, kind)
);

alter table public.arm_fill_tactics enable row level security;
-- RLS on, no policies: service role only (the worker reads/writes directly)

-- Record a tactic that worked (upsert + increment), mirroring arm_playbooks.
create or replace function public.record_fill_tactic(
  p_domain text,
  p_ats text,
  p_kind text,
  p_tactic text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  insert into public.arm_fill_tactics (domain, ats, kind, tactic)
  values (p_domain, p_ats, p_kind, p_tactic)
  on conflict (domain, ats, kind) do update set
    -- A different winner replaces the stored one: the site changed, or the last
    -- guess was luck. Counting successes of the CURRENT tactic keeps that honest.
    tactic = excluded.tactic,
    success_count = case
      when public.arm_fill_tactics.tactic = excluded.tactic
        then public.arm_fill_tactics.success_count + 1
      else 1
    end,
    -- Carrying the old tactic's failures onto a new one would bury it on arrival:
    -- the reader retires anything failing more than it succeeds, so a fresh
    -- winner inheriting a long losing record would be ignored from its first day.
    failure_count = case
      when public.arm_fill_tactics.tactic = excluded.tactic
        then public.arm_fill_tactics.failure_count
      else 0
    end,
    last_success_at = now(),
    updated_at = now();
end;
$$;
revoke execute on function public.record_fill_tactic(text, text, text, text)
  from public, anon, authenticated;

-- Count a stored tactic against itself once it stops working.
--
-- Without this the staleness rule is decoration: failure_count could only ever be
-- zero, so a tactic that no longer works on a site would be applied on every run
-- forever. This is what eventually retires it, exactly as the playbook failure
-- counter retires a recovery strategy that has stopped landing.
create or replace function public.record_fill_tactic_failure(
  p_domain text,
  p_ats text,
  p_kind text
)
returns void
language sql
security definer
set search_path = pg_catalog, public
as $$
  update public.arm_fill_tactics
     set failure_count = failure_count + 1,
         updated_at = now()
   where domain = p_domain and ats = p_ats and kind = p_kind;
$$;
revoke execute on function public.record_fill_tactic_failure(text, text, text)
  from public, anon, authenticated;
