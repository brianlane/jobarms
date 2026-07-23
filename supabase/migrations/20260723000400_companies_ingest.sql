-- Phase 6 schema: tracked companies for the ingestion worker.

create table public.companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  ats text not null check (ats in ('greenhouse', 'lever', 'ashby', 'workable')),
  board_token text not null, -- greenhouse board / lever slug / ashby board / workable account
  active boolean not null default true,
  last_ingested_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index companies_ats_token_idx on public.companies (ats, board_token);

alter table public.companies enable row level security;

-- Curated catalog: readable by signed-in users, written by service role only.
create policy companies_select_authenticated on public.companies
  for select using (auth.role() = 'authenticated');
