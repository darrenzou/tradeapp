import "server-only";

import { AccountType, type AccountBase } from "plaid";

import {
  ACCOUNT_TRANSACTIONS_PAGE_SIZE,
  pageOf,
  sortNewestFirst,
  type AccountTransaction,
  type AccountTransactionsPage,
} from "@/lib/account-history";
import { plaidAccountName } from "@/lib/account-dedupe";
import { categoryLabel, type CashTransaction } from "@/lib/cashflow";
import {
  findImportedAccount,
  importedAccountName,
  loadImportedTransactions,
} from "@/lib/imported-transactions-store";
import { getSnapTradeCredentials, listPlaidItems, type PlaidItem } from "@/lib/linked-accounts";
import { plaidSettingsKeys } from "@/lib/overview-settings";
import { listFinancialAccounts } from "@/lib/plaid";
import { loadPlaidInvestmentLedger, loadSnapTradeLedger } from "@/lib/portfolio-data";
import { cachedRead, type ProviderCache, type ReadOptions } from "@/lib/provider-cache";
import { canFetchMoreHistory, importedCashTransaction, importsByAccount, readItemTransactions } from "@/lib/spending";

// The account isn't one of the user's, or no longer exists.
export class AccountNotFoundError extends Error {}

type History = Pick<AccountTransactionsPage, "notice" | "coverage" | "imported"> & {
  transactions: AccountTransaction[];
};

const ACCOUNT_ID_PATTERN = /^(plaid|snaptrade|import):([A-Za-z0-9_-]+)$/;
const ACCOUNTS_CACHE_MS = 15 * 60_000;

// Which bank connection each Plaid account belongs to, so paging through a
// list doesn't ask Plaid for every connection's accounts each time.
const plaidAccountsCache: ProviderCache<AccountBase[]> = new Map();

const dateFormatter = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

// "2026-07-03" as "Jul 3, 2026".
function dateLabel(date: string): string {
  return dateFormatter.format(new Date(`${date}T00:00:00Z`));
}

function fromCashTransaction(transaction: CashTransaction, accountId: string): AccountTransaction {
  return {
    id: transaction.id,
    accountId,
    date: transaction.date,
    description: transaction.name,
    detail: transaction.primary === null ? null : categoryLabel(transaction.primary),
    // Plaid amounts are positive when money leaves the account.
    amount: -transaction.amount,
    currency: transaction.currency,
    pending: transaction.pending,
  };
}

export type PlaidAccountMatch = {
  item: PlaidItem;
  account: AccountBase;
  // The key imported transactions are stored under (see plaidSettingsKeys).
  settingsKey: string;
};

// One of the user's Plaid accounts, with the connection it belongs to.
export async function findPlaidAccount(userId: string, plaidAccountId: string): Promise<PlaidAccountMatch> {
  const items = await listPlaidItems(userId);
  const results = await Promise.allSettled(
    items.map((item) =>
      cachedRead(plaidAccountsCache, `${userId}:${item.itemId}`, ACCOUNTS_CACHE_MS, () =>
        listFinancialAccounts(item.accessToken),
      ),
    ),
  );
  let failed = false;
  let found: { item: PlaidItem; account: AccountBase } | null = null;

  for (const [index, result] of results.entries()) {
    if (result.status === "rejected") {
      failed = true;
      continue;
    }

    const account = result.value.find((candidate) => candidate.account_id === plaidAccountId);

    if (account !== undefined) {
      found = { item: items[index], account };
    }
  }

  if (found !== null) {
    const keys = plaidSettingsKeys(
      results.flatMap((result, index) =>
        result.status === "fulfilled"
          ? result.value.map((account) => ({
              accountId: account.account_id,
              institution: items[index].institutionName ?? "Bank",
              name: plaidAccountName(account),
            }))
          : [],
      ),
    );

    return { ...found, settingsKey: keys.get(plaidAccountId)! };
  }

  // A connection that couldn't be read may be the one with this account.
  throw failed ? new Error("Plaid accounts couldn't be loaded") : new AccountNotFoundError();
}

async function plaidHistory(userId: string, plaidAccountId: string, options: ReadOptions): Promise<History> {
  const { item, account, settingsKey } = await findPlaidAccount(userId, plaidAccountId);
  const accountId = `plaid:${account.account_id}`;

  if (account.type === AccountType.Investment || account.type === AccountType.Brokerage) {
    try {
      return {
        transactions: await loadPlaidInvestmentLedger(userId, item, accountId, options),
        notice: null,
        coverage: "Plaid shares up to 24 months of investment activity.",
        imported: null,
      };
    } catch {
      // Connections without investment data still have bank-style
      // transactions for the account.
    }
  }

  const [history, imported] = await Promise.all([
    readItemTransactions(userId, item, options),
    loadImportedTransactions(userId, []),
  ]);
  const bank = item.institutionName ?? "this bank";
  const shortHistory = canFetchMoreHistory(item);
  // Only this account's imports, already keyed to it.
  const own = imported.get(settingsKey) ?? [];
  const older =
    importsByAccount([{ item, history }], new Map([[settingsKey, own]]), new Map([[account.account_id, settingsKey]])).get(
      account.account_id,
    ) ?? [];

  return {
    transactions: [
      ...history.transactions.filter((transaction) => transaction.accountId === account.account_id),
      ...older,
    ].map((transaction) => fromCashTransaction(transaction, accountId)),
    imported: own.length,
    notice: shortHistory
      ? `${bank} was connected with only about 6 months of history. Reconnect it on the Spending page to see up to 24 months.`
      : history.historicalComplete
        ? null
        : `Plaid is still fetching older transactions from ${bank}. More will show up later.`,
    coverage:
      older.length > 0
        ? `Transactions through ${dateLabel(older.reduce((latest, { date }) => (date > latest ? date : latest), ""))} come from the file you imported.`
        : shortHistory
          ? "That's all the history this connection has. Reconnect it on the Spending page for up to 24 months."
          : "That's all the history Plaid has for this account.",
  };
}

async function importedHistory(userId: string, accountId: string): Promise<History> {
  const [account, imported] = await Promise.all([
    findImportedAccount(userId, accountId),
    loadImportedTransactions(userId, []),
  ]);

  if (account === null) {
    throw new AccountNotFoundError();
  }

  const rows = imported.get(accountId) ?? [];
  const kind = account.kind === "credit" ? "credit" : "depository";

  return {
    transactions: rows.map((transaction) =>
      fromCashTransaction(
        importedCashTransaction(transaction, { accountId, name: importedAccountName(account), kind }),
        accountId,
      ),
    ),
    notice: null,
    coverage: "These come from the file you imported. Import a newer download to bring the account up to date.",
    imported: rows.length,
  };
}

async function snapTradeHistory(userId: string, snaptradeAccountId: string, options: ReadOptions): Promise<History> {
  const credentials = await getSnapTradeCredentials(userId);

  if (credentials === null) {
    throw new AccountNotFoundError();
  }

  return {
    transactions: await loadSnapTradeLedger(userId, credentials, snaptradeAccountId, options),
    notice: null,
    coverage: "SnapTrade updates brokerage activity once a day. How far back it goes depends on the brokerage.",
    imported: null,
  };
}

// One page of an account's transactions, newest first.
export async function loadAccountTransactions(
  userId: string,
  accountId: string,
  offset: number,
  options: ReadOptions = {},
  limit = ACCOUNT_TRANSACTIONS_PAGE_SIZE,
): Promise<AccountTransactionsPage> {
  const match = ACCOUNT_ID_PATTERN.exec(accountId);

  if (match === null) {
    throw new AccountNotFoundError();
  }

  const [, source, providerId] = match;
  const history =
    source === "snaptrade"
      ? await snapTradeHistory(userId, providerId, options)
      : source === "import"
        ? await importedHistory(userId, accountId)
        : await plaidHistory(userId, providerId, options);

  return {
    ...pageOf(sortNewestFirst(history.transactions), offset, limit),
    notice: history.notice,
    coverage: history.coverage,
    imported: history.imported,
  };
}
