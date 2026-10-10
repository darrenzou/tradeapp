-- Bank transactions a user imported from a CSV downloaded from their bank,
-- for history older than Plaid shares. Only the server reads these, using
-- the service-role key, like the category rules.
--   account_key: the account they belong to, as Edit accounts keys it
--     (provider|bank|account name; see accountKey in lib/overview-settings.ts),
--     so they stay with the account after a Plaid reconnect.
--   amount: Plaid's sign, positive when money left the account.

create table if not exists public.imported_transactions (
  user_id uuid not null references auth.users (id) on delete cascade,
  account_key text not null,
  id text not null,
  date date not null,
  description text not null,
  amount numeric(14, 2) not null,
  created_at timestamptz not null default now(),
  primary key (user_id, account_key, id)
);

alter table public.imported_transactions enable row level security;

revoke all on public.imported_transactions from anon, authenticated;
