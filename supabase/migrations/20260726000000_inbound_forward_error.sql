-- Why a forward did not reach its owner.
--
-- `forwarded` records THAT a relay failed and nothing recorded why, so the admin
-- panel could raise an alarm but not answer it, and the operator had to go read
-- function logs to learn anything. The provider's own code (invalid_from_address,
-- daily_quota_exceeded, and friends) is the whole diagnostic, so it is kept next
-- to the row it belongs to.
--
-- Null means either "delivered" or "not attempted yet"; `forwarded` is what
-- distinguishes those two. Deliberately free text: it holds a provider code we
-- do not control and must not be a constraint that rejects a message.
alter table public.inbound_emails
  add column if not exists forward_error text;

comment on column public.inbound_emails.forward_error is
  'Provider reason a forward was refused. Null when it succeeded or has not run.';
