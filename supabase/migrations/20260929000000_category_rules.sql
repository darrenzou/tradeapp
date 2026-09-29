-- Categories users picked on the Spending page, replacing Plaid's. match_key
-- is "transaction:<id>" for one transaction or "similar:<key>" for every
-- transaction like it (same account, direction, and other party; see
-- similarKey in lib/cashflow.ts). Only the server reads these, using the
-- service-role key, like the provider credentials.

create table if not exists public.category_rules (
  user_id uuid not null references auth.users (id) on delete cascade,
  match_key text not null,
  category text not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, match_key)
);

alter table public.category_rules enable row level security;

revoke all on public.category_rules from anon, authenticated;
