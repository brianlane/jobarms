-- Dayforce joins the tuned ATSes, so both catalog constraints must accept it.
--
-- jobs.ats: add 'dayforce' (a pasted or ingested Dayforce posting otherwise
-- fails the job upsert with job_upsert_failed and never starts a run).
alter table public.jobs drop constraint jobs_ats_check;
alter table public.jobs add constraint jobs_ats_check
  check (ats in ('greenhouse', 'lever', 'workday', 'ashby', 'dayforce', 'workable', 'unknown'));

-- companies.ats: the original check never included 'workday' (its ingest
-- fetcher shipped without widening the constraint, so a Workday company row
-- was silently unrepresentable) and now also needs 'dayforce'. Add both.
alter table public.companies drop constraint companies_ats_check;
alter table public.companies add constraint companies_ats_check
  check (ats in ('greenhouse', 'lever', 'ashby', 'workable', 'workday', 'dayforce'));
