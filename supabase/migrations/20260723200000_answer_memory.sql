-- Arm learning, two layers:
--  1. user_answer_memory: per-user reusable answers, captured from review-gate
--     approvals (edited answers are the strongest signal). Fed back into that
--     user's future runs only.
--  2. platform_field_stats: anonymous, aggregated field behavior across ALL
--     users per ATS: how often a question appears / gets skipped / gets
--     edited, plus option-choice counts for NON-SENSITIVE select/radio
--     questions only. No free text is ever aggregated platform-wide.

create table public.user_answer_memory (
  user_id uuid not null references auth.users (id) on delete cascade,
  question_key text not null,           -- normalized label
  label text not null default '',       -- last seen human label
  answer text not null default '',
  source text not null default 'approved' check (source in ('approved', 'user_edited')),
  times_used integer not null default 1,
  updated_at timestamptz not null default now(),
  primary key (user_id, question_key)
);

alter table public.user_answer_memory enable row level security;

create policy user_answer_memory_select_own on public.user_answer_memory
  for select using (auth.uid() = user_id);
-- writes: service role only

create table public.platform_field_stats (
  ats text not null,
  question_key text not null,
  label_example text not null default '',
  field_type text not null default 'text',
  times_seen integer not null default 0,
  times_skipped integer not null default 0,
  times_edited integer not null default 0,
  option_counts jsonb not null default '{}'::jsonb, -- option text -> approved count (non-sensitive select/radio only)
  updated_at timestamptz not null default now(),
  primary key (ats, question_key)
);

alter table public.platform_field_stats enable row level security;
-- RLS on, no policies: service role only (aggregated data feeds prompts, not UI)

-- Atomic batch upsert of a user's answer memory from one approval.
-- entries: [{question_key, label, answer, source}]
create or replace function public.record_answer_memory(
  p_user_id uuid,
  p_entries jsonb
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  entry jsonb;
begin
  for entry in select * from jsonb_array_elements(p_entries) loop
    insert into public.user_answer_memory (user_id, question_key, label, answer, source)
    values (
      p_user_id,
      entry->>'question_key',
      coalesce(entry->>'label', ''),
      coalesce(entry->>'answer', ''),
      coalesce(entry->>'source', 'approved')
    )
    on conflict (user_id, question_key) do update set
      label = excluded.label,
      answer = excluded.answer,
      -- a user edit always wins; an approval never downgrades an edit
      source = case
        when excluded.source = 'user_edited' then 'user_edited'
        else public.user_answer_memory.source
      end,
      times_used = public.user_answer_memory.times_used + 1,
      updated_at = now();
  end loop;
end;
$$;
revoke execute on function public.record_answer_memory(uuid, jsonb)
  from public, anon, authenticated;

-- Atomic batch update of platform field stats from one approval.
-- updates: [{question_key, label, field_type, skipped, edited, chosen_option}]
create or replace function public.record_field_stats(
  p_ats text,
  p_updates jsonb
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  u jsonb;
  v_option text;
begin
  for u in select * from jsonb_array_elements(p_updates) loop
    v_option := u->>'chosen_option';

    insert into public.platform_field_stats
      (ats, question_key, label_example, field_type, times_seen, times_skipped, times_edited, option_counts)
    values (
      p_ats,
      u->>'question_key',
      coalesce(u->>'label', ''),
      coalesce(u->>'field_type', 'text'),
      1,
      case when (u->>'skipped')::boolean then 1 else 0 end,
      case when (u->>'edited')::boolean then 1 else 0 end,
      case when v_option is not null then jsonb_build_object(v_option, 1) else '{}'::jsonb end
    )
    on conflict (ats, question_key) do update set
      label_example = excluded.label_example,
      field_type = excluded.field_type,
      times_seen = public.platform_field_stats.times_seen + 1,
      times_skipped = public.platform_field_stats.times_skipped
        + case when (u->>'skipped')::boolean then 1 else 0 end,
      times_edited = public.platform_field_stats.times_edited
        + case when (u->>'edited')::boolean then 1 else 0 end,
      option_counts = case
        when v_option is not null then
          jsonb_set(
            public.platform_field_stats.option_counts,
            array[v_option],
            to_jsonb(coalesce((public.platform_field_stats.option_counts->>v_option)::int, 0) + 1)
          )
        else public.platform_field_stats.option_counts
      end,
      updated_at = now();
  end loop;
end;
$$;
revoke execute on function public.record_field_stats(text, jsonb)
  from public, anon, authenticated;
