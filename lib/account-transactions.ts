import "server-only";

import { AccountType, type AccountBase } from "plaid";

import {
  ACCOUNT_TRANSACTIONS_PAGE_SIZE,
  pageOf,
  sortNewestFirst,
  type AccountTransaction,
  type AccountTransactionsPage,
} from "@/lib/account-history";
import { categoryLabel, type CashTransaction } from "@/lib/cashflow";
import { getSnapTradeCredentials, listPlaidItems, type PlaidItem } from "@/lib/linked-accounts";
import { listFinancialAccounts } from "@/lib/plaid";
import { loadPlaidInvestmentLedger, loadSnapTradeLedger } from "@/lib/portfolio-data";
import { cachedRead, type ProviderCache, type ReadOptions } from "@/lib/provider-cache";
import { canFetchMoreHistory, readItemTransactions } from "@/lib/spending";

// The account isn't one of the user's, or no longer exists.
export class AccountNotFoundError extends Error {}

type History = Pick<AccountTransactionsPage, "notice" | "coverage"> & { transactions: AccountTransaction[] };

const ACCOUNT_ID_PATTERN = /^(plaid|snaptrade):([A-Za-z0-9_-]+)$/;
const ACCOUNTS_CACHE_MS = 15 * 60_000;

// Which bank connection each Plaid account belongs to, so paging through a
// list doesn't ask Plaid for every connection's accounts each time.
const plaidAccountsCache: ProviderCache<AccountBase[]> = new Map();

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

async function findPlaidAccount(
  userId: string,
  plaidAccountId: string,
): Promise<{ item: PlaidItem; account: AccountBase }> {
  const items = await listPlaidItems(userId);
  const results = await Promise.allSettled(
    items.map((item) =>
      cachedRead(plaidAccountsCache, `${userId}:${item.itemId}`, ACCOUNTS_CACHE_MS, () =>
        listFinancialAccounts(item.accessToken),
      ),
    ),
  );
  let failed = false;

  for (const [index, result] of results.entries()) {
    if (result.status === "rejected") {
      failed = true;
      continue;
    }

    const account = result.value.find((candidate) => candidate.account_id === plaidAccountId);

    if (account !== undefined) {
      return { item: items[index], account };
    }
  }

  // A connection that couldn't be read may be the one with this account.
  throw failed ? new Error("Plaid accounts couldn't be loaded") : new AccountNotFoundError();
}

async function plaidHistory(userId: string, plaidAccountId: string, options: ReadOptions): Promise<History> {
  const { item, account } = await findPlaidAccount(userId, plaidAccountId);
  const accountId = `plaid:${account.account_id}`;

  if (account.type === AccountType.Investment || account.type === AccountType.Brokerage) {
    try {
      return {
        transactions: await loadPlaidInvestmentLedger(userId, item, accountId, options),
        notice: null,
        coverage: "Plaid shares up to 24 months of investment activity.",
      };
    } catch {
      // Connections without investment data still have bank-style
      // transactions for the account.
    }
  }

  const history = await readItemTransactions(userId, item, options);
  const bank = item.institutionName ?? "this bank";
  const shortHistory = canFetchMoreHistory(item);

  return {
    transactions: history.transactions
      .filter((transaction) => transaction.accountId === account.account_id)
      .map((transaction) => fromCashTransaction(transaction, accountId)),
    notice: shortHistory
      ? `${bank} was connected with only about 6 months of history. Reconnect it on the Spending page to see up to 24 months.`
      : history.historicalComplete
        ? null
        : `Plaid is still fetching older transactions from ${bank}. More will show up later.`,
    coverage: shortHistory
      ? "That's all the history this connection has. Reconnect it on the Spending page for up to 24 months."
      : "Plaid shares up to 24 months of history, so older transactions aren't available.",
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
      : await plaidHistory(userId, providerId, options);

  return {
    ...pageOf(sortNewestFirst(history.transactions), offset, limit),
    notice: history.notice,
    coverage: history.coverage,
  };
}
