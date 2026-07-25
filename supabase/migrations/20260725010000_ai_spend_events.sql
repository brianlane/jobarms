-- AI spend ledger: one row per model call, with the tokens it actually used.
--
-- Why a ledger and not a counter: ai_usage already counts CALLS per quota
-- window, which is what the gates need, but a call is not a cost. A resume parse
-- with a 12-page PDF and a one-line cover letter are both "1 call" and differ by
-- two orders of magnitude in tokens. Cost per successful application, margin per
-- paying user, and "who is underwater" are all unanswerable without the tokens.
--
-- Day-keyed (`day`, not just created_at) so the admin surfaces can sum an
-- arbitrary calendar window cheaply, including historical months, which the
-- period-keyed quota rows cannot do.
--
-- Posture: RLS on with NO policies, the deny-all design. The app and the worker
-- both write through the service role after their own auth checks; nobody reads
-- this but the admin console.

create table public.ai_spend_events (
  id uuid primary key default gen_random_uuid(),
  -- Nullable: platform-level calls (a vision recovery diagnosis that is not
  -- billable to one person) still belong in the ledger.
  user_id uuid references auth.users (id) on delete set null,
  run_id uuid references public.application_runs (id) on delete set null,
  -- What the call was for. Deliberately WIDER than ai_usage.kind: the arm's own
  -- surfaces (answer generation, vision recovery) are real cost even though they
  -- carry no user-facing quota.
  kind text not null,
  -- The model that actually served the call, which is not always the primary
  -- one: a capacity fallback is a different price, and the fallback RATE is
  -- itself a signal worth seeing.
  model text not null default '',
  used_fallback boolean not null default false,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  -- Millionths of a dollar. Integer on purpose: money in floats drifts.
  cost_micros bigint not null default 0,
  day date not null default (now() at time zone 'utc')::date,
  created_at timestamptz not null default now()
);

create index ai_spend_events_day_idx on public.ai_spend_events (day desc);
create index ai_spend_events_user_day_idx on public.ai_spend_events (user_id, day desc);
create index ai_spend_events_run_idx on public.ai_spend_events (run_id);

alter table public.ai_spend_events enable row level security;
-- RLS on, no policies: service role only.

-- Insert one ledger row. A function rather than a plain insert so the worker can
-- reach it over the RPC endpoint it already uses for every other write, and so
-- `day` is stamped by the DATABASE clock rather than trusted from a caller.
create or replace function public.record_ai_spend(
  p_user_id uuid,
  p_run_id uuid,
  p_kind text,
  p_model text,
  p_used_fallback boolean,
  p_input_tokens integer,
  p_output_tokens integer,
  p_cost_micros bigint
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  insert into public.ai_spend_events (
    user_id, run_id, kind, model, used_fallback,
    input_tokens, output_tokens, cost_micros, day
  )
  values (
    p_user_id, p_run_id, coalesce(p_kind, 'unknown'), coalesce(p_model, ''),
    coalesce(p_used_fallback, false), greatest(coalesce(p_input_tokens, 0), 0),
    greatest(coalesce(p_output_tokens, 0), 0), greatest(coalesce(p_cost_micros, 0), 0),
    (now() at time zone 'utc')::date
  );
end;
$$;
revoke execute on function public.record_ai_spend(uuid, uuid, text, text, boolean, integer, integer, bigint)
  from public, anon, authenticated;
