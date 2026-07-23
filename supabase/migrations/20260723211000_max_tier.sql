-- Add the 'max' tier to the subscriptions.plan check constraint.
alter table public.subscriptions
  drop constraint if exists subscriptions_plan_check;
alter table public.subscriptions
  add constraint subscriptions_plan_check
  check (plan in ('free', 'premium', 'max'));
