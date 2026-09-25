-- Provider credentials for linked brokerage (SnapTrade) and bank/card (Plaid)
-- accounts. Only the server reads these, using the service-role key, so row
-- level security is enabled with no policies and client roles have no grants.

create table if not exists public.snaptrade_users (
  user_id uuid primary key references auth.users (id) on delete cascade,
  snaptrade_user_id text not null unique,
  snaptrade_user_secret text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.plaid_items (
  item_id text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  access_token text not null,
  institution_name text,
  created_at timestamptz not null default now()
);

create index if not exists plaid_items_user_id_idx on public.plaid_items (user_id);

alter table public.snaptrade_users enable row level security;
alter table public.plaid_items enable row level security;

revoke all on public.snaptrade_users from anon, authenticated;
revoke all on public.plaid_items from anon, authenticated;
