-- Each user's app settings, one row per user. Only the server reads it,
-- using the service-role key, like the category rules.
--   overview: how they arranged the Overview in Edit accounts (nicknames,
--     hidden and removed accounts, hiding $0 balances, combining savings and
--     investments, the order of sections and accounts); see
--     OverviewSettings in lib/overview-settings.ts.
--   allocation_targets: the asset class mix they aim for, from Set targets;
--     see AllocationTargets in lib/allocation-targets.ts. Null until set.

create table if not exists public.user_settings (
  user_id uuid primary key references auth.users (id) on delete cascade,
  overview jsonb not null default '{}'::jsonb,
  allocation_targets jsonb,
  updated_at timestamptz not null default now()
);

alter table public.user_settings enable row level security;

revoke all on public.user_settings from anon, authenticated;
