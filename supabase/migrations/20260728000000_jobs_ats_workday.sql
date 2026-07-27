-- `jobs.ats` never learned 'workday': the check constraint predates the
-- Workday adapter, so pasting or ingesting a Workday posting fails the job
-- upsert (the insert returns nothing and the route answers
-- job_upsert_failed) and a run never starts.
--
-- 'generic' is NOT added, deliberately: it is a dispatch concept (which
-- adapter drives the run), never a detected value stored on a job row.
alter table public.jobs drop constraint jobs_ats_check;
alter table public.jobs add constraint jobs_ats_check
  check (ats in ('greenhouse', 'lever', 'workday', 'ashby', 'workable', 'unknown'));
