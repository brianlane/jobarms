-- Atomic append helpers for the run step log and screenshot list.
--
-- The worker previously did read-modify-write on these jsonb columns
-- (getRun then updateRun with the whole array). The workflow is a single
-- sequential writer today, but a retried step interleaving with another
-- writer could drop entries. Appending inside one UPDATE makes it safe:
-- Postgres row-locks the tuple and re-evaluates `col || new` against the
-- latest committed version, so concurrent appends serialize instead of
-- overwriting. Service-role only, like every other run write.

create or replace function public.append_run_step(
  p_run_id uuid,
  p_step jsonb
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  update public.application_runs
  set steps = coalesce(steps, '[]'::jsonb) || jsonb_build_array(p_step),
      updated_at = now()
  where id = p_run_id;
end;
$$;
revoke execute on function public.append_run_step(uuid, jsonb)
  from public, anon, authenticated;

create or replace function public.append_run_screenshot(
  p_run_id uuid,
  p_path text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  update public.application_runs
  set screenshots = coalesce(screenshots, '[]'::jsonb) || jsonb_build_array(to_jsonb(p_path)),
      updated_at = now()
  where id = p_run_id;
end;
$$;
revoke execute on function public.append_run_screenshot(uuid, text)
  from public, anon, authenticated;
