-- Phase 2 schema: resumes + private storage buckets.

create table public.resumes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null default 'base' check (kind in ('base', 'tailored')),
  base_resume_id uuid references public.resumes (id) on delete set null,
  application_id uuid, -- FK added in the applications migration (Phase 3)
  file_name text not null default '',
  storage_path text not null,
  mime_type text not null default 'application/pdf',
  parsed jsonb,               -- Gemini-extracted structured resume
  parse_status text not null default 'pending'
    check (parse_status in ('pending', 'parsed', 'failed')),
  parse_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index resumes_user_idx on public.resumes (user_id, created_at desc);

alter table public.resumes enable row level security;

create policy resumes_select_own on public.resumes
  for select using (auth.uid() = user_id);
create policy resumes_insert_own on public.resumes
  for insert with check (auth.uid() = user_id);
create policy resumes_update_own on public.resumes
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy resumes_delete_own on public.resumes
  for delete using (auth.uid() = user_id);

create trigger resumes_set_updated_at
  before update on public.resumes
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Private storage buckets. Objects are keyed <user_id>/<uuid>.<ext>, so the
-- owner-folder policies below give users access to exactly their own files.
-- The arm (service role) bypasses RLS for signed-URL generation.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('resumes', 'resumes', false), ('run-artifacts', 'run-artifacts', false)
on conflict (id) do nothing;

create policy resumes_bucket_select_own on storage.objects
  for select using (
    bucket_id = 'resumes' and auth.uid()::text = (storage.foldername(name))[1]
  );
create policy resumes_bucket_insert_own on storage.objects
  for insert with check (
    bucket_id = 'resumes' and auth.uid()::text = (storage.foldername(name))[1]
  );
create policy resumes_bucket_delete_own on storage.objects
  for delete using (
    bucket_id = 'resumes' and auth.uid()::text = (storage.foldername(name))[1]
  );

-- run-artifacts (arm screenshots): users read their own; only the arm writes.
create policy run_artifacts_select_own on storage.objects
  for select using (
    bucket_id = 'run-artifacts' and auth.uid()::text = (storage.foldername(name))[1]
  );
