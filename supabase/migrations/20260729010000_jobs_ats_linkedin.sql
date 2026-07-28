-- Allow 'linkedin' in the shared jobs catalog.
--
-- The LinkedIn arm (single Easy Apply runs and search-driven batches) records
-- LinkedIn postings in public.jobs, but jobs_ats_check predates the integration
-- and rejected the value: the insert failed, the follow-up read found no row,
-- and every LinkedIn application died (job_upsert_failed on the app path,
-- system_failed per card on the batch path).
--
-- companies_ats_check stays as is: it gates the ingest sources, and there is no
-- LinkedIn ingest.
alter table public.jobs drop constraint jobs_ats_check;
alter table public.jobs add constraint jobs_ats_check
  check (ats in ('greenhouse', 'lever', 'workday', 'ashby', 'dayforce', 'linkedin',
                 'workable', 'unknown'));
