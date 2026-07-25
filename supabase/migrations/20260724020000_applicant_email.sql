-- Per-user managed applicant email (the "AI email" an arm applies with) plus
-- the inbound mail log that backs verification and auto-forwarding.
--
-- Why: ATSes like Workday require a candidate ACCOUNT per employer tenant, and
-- creating one means receiving a verification mail. The arm therefore needs a
-- mailbox JobArms controls. Cloudflare Email Routing catches everything at
-- jobarms.com and an Email Worker posts it to /api/email/inbound.
--
-- Posture: the alias lives on the user's own profile row (read-own like the
-- rest of it); inbound_emails is read-own with service-role-only writes.

-- ---------------------------------------------------------------------------
-- profiles.applicant_alias - the managed local part, e.g. 'a-7f3k9d2p'
-- ---------------------------------------------------------------------------
-- Nullable + unique: assigned lazily the first time a run needs an account, so
-- existing users need no backfill and users who never touch a login-gated ATS
-- never get one. UNIQUE is what makes inbound routing unambiguous.
alter table public.profiles
  add column if not exists applicant_alias text unique;

-- ---------------------------------------------------------------------------
-- inbound_emails - every message that arrived at a user's managed alias
-- ---------------------------------------------------------------------------
create table if not exists public.inbound_emails (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  alias text not null,
  from_address text not null default '',
  from_domain text not null default '',
  subject text not null default '',
  body_text text not null default '',
  -- Dedupe key: Cloudflare retries a delivery when our webhook returns non-2xx,
  -- so the same Message-ID must never create a second row (or a second forward).
  message_id text not null,
  -- Extracted by the route when the sender looks like an ATS account mail.
  verification_link text,
  verification_code text,
  forwarded boolean not null default false,
  created_at timestamptz not null default now(),
  unique (user_id, message_id)
);

create index if not exists inbound_emails_user_created_idx
  on public.inbound_emails (user_id, created_at desc);

-- Verification lookups hit "newest unconsumed mail for this alias from this
-- sender domain", which is exactly this index.
create index if not exists inbound_emails_alias_domain_idx
  on public.inbound_emails (alias, from_domain, created_at desc);

alter table public.inbound_emails enable row level security;

create policy inbound_emails_select_own on public.inbound_emails
  for select using (auth.uid() = user_id);
-- writes: service_role only (the inbound webhook), no policies by design

-- ---------------------------------------------------------------------------
-- claim_applicant_alias - atomically assign an alias to a user
-- ---------------------------------------------------------------------------
-- Returns the EXISTING alias when the user already has one (idempotent), else
-- writes the candidate and returns it. A unique-violation means a concurrent
-- caller or another user took that candidate; we return null so the caller
-- generates a fresh one and retries rather than handing back a duplicate.
create or replace function public.claim_applicant_alias(
  p_user_id uuid,
  p_candidate text
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_existing text;
begin
  select applicant_alias into v_existing
  from public.profiles
  where id = p_user_id
  for update;

  if v_existing is not null then
    return v_existing;
  end if;

  begin
    update public.profiles
    set applicant_alias = p_candidate
    where id = p_user_id;
  exception
    when unique_violation then
      return null;
  end;

  return p_candidate;
end;
$$;
revoke execute on function public.claim_applicant_alias(uuid, text)
  from public, anon, authenticated;
