-- Answers the form did not accept, read back after filling.
--
-- Nothing compared what the arm intended with what the form actually held, which
-- is how a US sanctions question ended up ticked opposite to the approved answer
-- on a run that reported success at every layer. The sidecar now reads the form
-- back and the disagreements land here, so the review screen can mark the exact
-- field instead of showing a vague warning and leaving the user to find it.
--
-- Shape: [{name, label, expected, actual}]. Empty array means the read-back
-- agreed; null means the run predates this or never got as far as filling.
alter table public.application_runs
  add column if not exists fill_mismatches jsonb;

comment on column public.application_runs.fill_mismatches is
  'Answers the form did not accept: [{name,label,expected,actual}]. Empty = agreed.';
