-- Harden the shared-catalog read policies off the deprecated auth.role().
--
-- The jobs + companies "readable by any signed-in user" policies used
-- `auth.role() = 'authenticated'`. auth.role() is deprecated in recent
-- Supabase/PostgREST and a future upgrade could turn these into deny-all
-- (Discover silently empties). `(select auth.uid()) is not null` is the
-- durable equivalent: a real signed-in user always has a uid, the anon role
-- never does. The subselect also lets Postgres cache the call per statement.

drop policy if exists jobs_select_authenticated on public.jobs;
create policy jobs_select_authenticated on public.jobs
  for select using ((select auth.uid()) is not null);

drop policy if exists companies_select_authenticated on public.companies;
create policy companies_select_authenticated on public.companies
  for select using ((select auth.uid()) is not null);
