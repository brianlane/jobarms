-- Fair metering: idempotent slot refunds + cancellation provenance.
-- Policy (README/plans.ts): user behavior consumes, system failure refunds.

alter table public.application_runs
  add column canceled_by text check (canceled_by in ('user', 'system')),
  add column slot_refunded boolean not null default false;

-- Idempotent refund keyed by run id: row-locks the run, no-ops if already
-- refunded, otherwise flags it and decrements the usage counter in the same
-- transaction. Worker failures, user-cancel cleanup, and retry cleanup can
-- all call this without ever double-crediting.
create or replace function public.refund_arm_run(p_run_id uuid)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_user uuid;
  v_key text;
  v_refunded boolean;
begin
  select user_id, month_key, slot_refunded
    into v_user, v_key, v_refunded
  from public.application_runs
  where id = p_run_id
  for update;

  if v_user is null or v_refunded then
    return false;
  end if;

  update public.application_runs
  set slot_refunded = true
  where id = p_run_id;

  update public.arm_run_usage
  set runs_used = greatest(runs_used - 1, 0), updated_at = now()
  where user_id = v_user and month_key = v_key;

  return true;
end;
$$;
revoke execute on function public.refund_arm_run(uuid) from public, anon, authenticated;
