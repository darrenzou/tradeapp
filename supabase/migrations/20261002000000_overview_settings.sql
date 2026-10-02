-- How each user arranged the Overview in Edit accounts: nicknames, hidden
-- and removed accounts, hiding $0 balances, combining savings and
-- investments, and the order of sections and accounts. One JSON document per
-- user (see OverviewSettings in lib/overview-settings.ts). Only the server
-- reads it, using the service-role key, like the category rules.

create table if not exists public.overview_settings (
  user_id uuid primary key references auth.users (id) on delete cascade,
  settings jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.overview_settings enable row level security;

revoke all on public.overview_settings from anon, authenticated;
