-- Bank and card accounts added from a CSV downloaded from the bank instead
-- of through Plaid. Their transactions are in imported_transactions under
-- account_key 'import:<id>'. Only the server reads these, using the
-- service-role key, like the category rules.
--   name: the nickname given when importing, or "Checking" / "Credit card".
--   mask: the account's last four digits.
--   kind: 'cash' for a bank account, 'credit' for a credit card.
--   balance: from the file's balance column, as of balance_date; null when
--     the file has none. Credit card balances are the amount owed.

create table if not exists public.imported_accounts (
  user_id uuid not null references auth.users (id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  institution text not null,
  name text not null,
  mask text,
  kind text not null check (kind in ('cash', 'credit')),
  balance numeric(14, 2),
  balance_date date,
  created_at timestamptz not null default now(),
  primary key (user_id, id)
);

alter table public.imported_accounts enable row level security;

revoke all on public.imported_accounts from anon, authenticated;
