-- Candidate accounts the arm holds on employer ATS tenants.
--
-- Workday (and every ATS like it) gives each employer its own tenant with its
-- own candidate database, so applying means creating an account there first.
-- The arm does that with the user's managed applicant alias and a generated
-- password, and the user never sees or manages either.
--
-- Posture: this is the most sensitive table in the schema, so it is
-- SERVICE-ROLE ONLY. RLS is enabled with NO policies, which is the deny-all
-- design used by `platform_field_stats` and `arm_playbooks`: anon and
-- authenticated get an unconditional deny at the database layer, and even the
-- owning user cannot read their own row. Passwords are additionally encrypted
-- by the app (AES-256-GCM, key in SITE_ACCOUNT_ENC_KEY) before they ever reach
-- Postgres, so a database compromise alone does not yield usable credentials.

create table if not exists public.site_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- The ATS tenant hostname, e.g. 'acme.wd1.myworkdayjobs.com'. One account per
  -- user per tenant is the whole point: reusing one avoids the duplicate
  -- candidate profiles Workday creates when identity fields do not match.
  tenant_host text not null,
  ats text not null,
  -- The managed alias the account was registered with (denormalized from
  -- profiles so a later alias change cannot orphan the credentials).
  email text not null,
  -- AES-256-GCM payload: 'v1:<iv-b64>:<tag-b64>:<ciphertext-b64>'. Never a
  -- plaintext password, and never logged.
  password_encrypted text not null,
  status text not null default 'pending_verification'
    check (status in ('pending_verification', 'verified', 'locked')),
  -- Set once the tenant confirms the email, so later runs skip the wait.
  verified_at timestamptz,
  -- Bookkeeping for diagnosing a tenant that keeps rejecting a login.
  login_failures integer not null default 0,
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, tenant_host)
);

create index if not exists site_accounts_user_idx
  on public.site_accounts (user_id, tenant_host);

alter table public.site_accounts enable row level security;
-- Deliberately NO policies: deny-all. Every read and write goes through the
-- Next.js server or the apply-arm worker (service role) after its own auth check.

create trigger site_accounts_set_updated_at
  before update on public.site_accounts
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- mark_site_account_verified - flip to verified once the tenant confirms
-- ---------------------------------------------------------------------------
-- Idempotent: a duplicate verification mail (or a retried delivery) must not
-- move verified_at or resurrect a locked account.
create or replace function public.mark_site_account_verified(
  p_user_id uuid,
  p_tenant_host text
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_updated integer;
begin
  update public.site_accounts
  set status = 'verified',
      verified_at = coalesce(verified_at, now()),
      login_failures = 0
  where user_id = p_user_id
    and tenant_host = p_tenant_host
    and status <> 'locked';

  get diagnostics v_updated = row_count;
  return v_updated > 0;
end;
$$;
revoke execute on function public.mark_site_account_verified(uuid, text)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- record_site_account_failure - count rejected logins and lock at the ceiling
-- ---------------------------------------------------------------------------
-- A tenant that keeps refusing our credentials is a dead end (changed password
-- policy, MFA, a captcha at sign-in). Locking after a few tries stops every
-- future run from burning a browser slot re-trying the same doomed login.
create or replace function public.record_site_account_failure(
  p_user_id uuid,
  p_tenant_host text,
  p_max_failures integer default 3
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_status text;
begin
  update public.site_accounts
  set login_failures = login_failures + 1,
      status = case
        when login_failures + 1 >= p_max_failures then 'locked'
        else status
      end
  where user_id = p_user_id and tenant_host = p_tenant_host
  returning status into v_status;

  return v_status;
end;
$$;
revoke execute on function public.record_site_account_failure(uuid, text, integer)
  from public, anon, authenticated;
