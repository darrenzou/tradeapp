import "server-only";

import { createAdminClient } from "@/lib/auth";
import type { ImportedTransaction } from "@/lib/imported-transactions";
import type { LinkedAccount } from "@/lib/net-worth";

// Postgres and PostgREST codes for a table that doesn't exist.
const MISSING_TABLE_CODES = new Set(["42P01", "PGRST205"]);
const INSERT_BATCH = 500;

// This user's imported transactions by account key. Until the migration runs
// there's nothing to load, and that isn't reported.
export async function loadImportedTransactions(
  userId: string,
  issues: string[],
): Promise<Map<string, ImportedTransaction[]>> {
  const byAccount = new Map<string, ImportedTransaction[]>();
  const { data, error } = await createAdminClient()
    .from("imported_transactions")
    .select("account_key, id, date, description, amount")
    .eq("user_id", userId)
    .limit(50_000);

  if (error) {
    if (!MISSING_TABLE_CODES.has(error.code)) {
      issues.push("Transactions you imported couldn't be loaded right now.");
    }

    return byAccount;
  }

  for (const row of data) {
    const list = byAccount.get(row.account_key) ?? [];
    list.push({ id: row.id, date: row.date, description: row.description, amount: Number(row.amount) });
    byAccount.set(row.account_key, list);
  }

  return byAccount;
}

// Replaces the account's imported transactions with these (none removes
// them), so importing a newer download doesn't double anything. With
// keepOutside, only the ones in the new file's date range are replaced, so a
// month's statement adds to the ones imported before it.
export async function replaceImportedTransactions(
  userId: string,
  accountKey: string,
  transactions: ImportedTransaction[],
  { keepOutside = false }: { keepOutside?: boolean } = {},
): Promise<void> {
  const client = createAdminClient();
  const dates = transactions.map((transaction) => transaction.date).sort();
  let remove = client.from("imported_transactions").delete().eq("user_id", userId).eq("account_key", accountKey);

  if (keepOutside && dates.length > 0) {
    remove = remove.gte("date", dates[0]).lte("date", dates[dates.length - 1]);
  }

  const { error } = await remove;

  if (error) {
    throw new Error("Failed to remove imported transactions");
  }

  for (let start = 0; start < transactions.length; start += INSERT_BATCH) {
    const { error: insertError } = await client.from("imported_transactions").insert(
      transactions.slice(start, start + INSERT_BATCH).map((transaction) => ({
        user_id: userId,
        account_key: accountKey,
        ...transaction,
      })),
    );

    if (insertError) {
      throw new Error("Failed to save imported transactions");
    }
  }
}

// An account added from a bank file rather than through Plaid.
export type ImportedAccount = {
  // "import:<uuid>", also its key in imported_transactions.
  id: string;
  institution: string;
  name: string;
  mask: string | null;
  kind: "cash" | "credit";
  balance: number | null;
};

const ACCOUNT_ID = /^import:([0-9a-f-]{36})$/;

export function importedAccountUuid(accountId: string): string | null {
  return ACCOUNT_ID.exec(accountId)?.[1] ?? null;
}

// "Checking ••0042", like a Plaid account's name.
export function importedAccountName(account: Pick<ImportedAccount, "name" | "mask">): string {
  return account.mask ? `${account.name} ••${account.mask}` : account.name;
}

// This user's accounts added from bank files. Until the migration runs
// there are none, and that isn't reported.
export async function loadImportedAccounts(userId: string, issues: string[]): Promise<ImportedAccount[]> {
  const { data, error } = await createAdminClient()
    .from("imported_accounts")
    .select("id, institution, name, mask, kind, balance")
    .eq("user_id", userId)
    .order("created_at");

  if (error) {
    if (!MISSING_TABLE_CODES.has(error.code)) {
      issues.push("Accounts you added from a bank file couldn't be loaded right now.");
    }

    return [];
  }

  return data.map((row) => ({
    id: `import:${row.id}`,
    institution: row.institution,
    name: row.name,
    mask: row.mask,
    kind: row.kind === "credit" ? "credit" : "cash",
    balance: row.balance === null ? null : Number(row.balance),
  }));
}

// One of this user's accounts added from a bank file, or null.
export async function findImportedAccount(userId: string, accountId: string): Promise<ImportedAccount | null> {
  const uuid = importedAccountUuid(accountId);

  if (uuid === null) {
    return null;
  }

  const accounts = await loadImportedAccounts(userId, []);
  return accounts.find((account) => account.id === accountId) ?? null;
}

// As the Overview lists it. Without a balance in the file it shows $0.
export function importedLinkedAccount(account: ImportedAccount): LinkedAccount {
  return {
    id: account.id,
    source: "import",
    name: importedAccountName(account),
    institution: account.institution,
    kind: account.kind,
    balance: Math.abs(account.balance ?? 0),
    currency: "USD",
  };
}

export async function createImportedAccount(
  userId: string,
  account: Omit<ImportedAccount, "id">,
  balanceDate: string | null,
): Promise<string> {
  const { data, error } = await createAdminClient()
    .from("imported_accounts")
    .insert({
      user_id: userId,
      institution: account.institution,
      name: account.name,
      mask: account.mask,
      kind: account.kind,
      balance: account.balance,
      balance_date: account.balance === null ? null : balanceDate,
    })
    .select("id")
    .single();

  if (error || data === null) {
    throw new Error("Failed to add the account");
  }

  return `import:${data.id}`;
}

// A newer file's balance replaces the older one; an older file's doesn't.
export async function updateImportedBalance(
  userId: string,
  accountId: string,
  balance: number | null,
  balanceDate: string | null,
): Promise<void> {
  const uuid = importedAccountUuid(accountId);

  if (uuid === null || balance === null) {
    return;
  }

  const { error } = await createAdminClient()
    .from("imported_accounts")
    .update({ balance, balance_date: balanceDate })
    .eq("user_id", userId)
    .eq("id", uuid)
    .or(balanceDate === null ? "balance_date.is.null" : `balance_date.is.null,balance_date.lte.${balanceDate}`);

  if (error) {
    throw new Error("Failed to update the balance");
  }
}

// Removes the account and its transactions.
export async function deleteImportedAccount(userId: string, accountId: string): Promise<void> {
  const uuid = importedAccountUuid(accountId);

  if (uuid === null) {
    return;
  }

  await replaceImportedTransactions(userId, accountId, []);
  const { error } = await createAdminClient().from("imported_accounts").delete().eq("user_id", userId).eq("id", uuid);

  if (error) {
    throw new Error("Failed to remove the account");
  }
}
