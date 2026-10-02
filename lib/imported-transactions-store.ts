import "server-only";

import { createAdminClient } from "@/lib/auth";
import type { ImportedTransaction } from "@/lib/imported-transactions";

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
// them), so importing a newer download doesn't double anything.
export async function replaceImportedTransactions(
  userId: string,
  accountKey: string,
  transactions: ImportedTransaction[],
): Promise<void> {
  const client = createAdminClient();
  const { error } = await client
    .from("imported_transactions")
    .delete()
    .eq("user_id", userId)
    .eq("account_key", accountKey);

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
