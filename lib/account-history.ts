// One account's transaction history as the Overview's account screen lists
// it: bank and card transactions from Plaid, and brokerage activity from
// SnapTrade or Plaid. Pure, so it runs in scripts and tests as well as on the
// server.

import type { InvestmentTransaction, Security } from "plaid";
import type { AccountUniversalActivity } from "snaptrade-typescript-sdk";

export type AccountTransaction = {
  id: string;
  // LinkedAccount id, e.g. "plaid:…" or "snaptrade:…".
  accountId: string;
  // YYYY-MM-DD
  date: string;
  // "Whole Foods", "Bought AAPL", "AAPL dividend".
  description: string;
  // A second line: the spending category, shares and price, or the
  // brokerage's own wording.
  detail: string | null;
  // From the account's side: positive when money came in (a paycheck, a
  // card payment, a sale), negative when it left (a purchase, a buy).
  amount: number;
  currency: string;
  pending: boolean;
};

export type AccountTransactionsPage = {
  transactions: AccountTransaction[];
  // Offset of the next page, or null when these reach the oldest.
  nextOffset: number | null;
  total: number;
  // Something the user can act on, such as reconnecting a bank for more
  // history. Shown above the list.
  notice: string | null;
  // How far back the history goes. Shown at the end of the list.
  coverage: string | null;
  // How many transactions the user imported from a bank file for this
  // account, or null when the account doesn't take imports (brokerages).
  imported: number | null;
};

export const ACCOUNT_TRANSACTIONS_PAGE_SIZE = 50;

const sharesFormatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 });

function money(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency}`;
  }
}

function titleCase(value: string): string {
  const words = value.replace(/_/g, " ").toLowerCase().trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function sharesAt(units: number, price: number | null | undefined, currency: string): string {
  const shares = `${sharesFormatter.format(Math.abs(units))} ${Math.abs(units) === 1 ? "share" : "shares"}`;
  return price ? `${shares} at ${money(price, currency)}` : shares;
}

const SNAPTRADE_LABELS: Record<string, string> = {
  BUY: "Buy",
  SELL: "Sell",
  DIVIDEND: "Dividend",
  SUBSTITUTE_DIVIDEND: "Payment in lieu of dividend",
  CONTRIBUTION: "Money added",
  WITHDRAWAL: "Withdrawal",
  REI: "Dividend reinvested",
  STOCK_DIVIDEND: "Stock dividend",
  INTEREST: "Interest",
  FEE: "Fee",
  TAX: "Tax",
  OPTIONEXPIRATION: "Option expired",
  OPTIONASSIGNMENT: "Option assigned",
  OPTIONEXERCISE: "Option exercised",
  TRANSFER: "Transfer",
  EXTERNAL_ASSET_TRANSFER_IN: "Transfer in",
  EXTERNAL_ASSET_TRANSFER_OUT: "Transfer out",
  SPLIT: "Stock split",
  ADJUSTMENT: "Adjustment",
};

// A SnapTrade activity; null when it has no date.
export function fromSnapTradeActivity(
  activity: AccountUniversalActivity,
  accountId: string,
  index: number,
): AccountTransaction | null {
  const date = (activity.trade_date ?? activity.settlement_date)?.slice(0, 10);

  if (!date) {
    return null;
  }

  const type = activity.type ?? "";
  const label = SNAPTRADE_LABELS[type] ?? (type ? titleCase(type) : "Activity");
  const currency = activity.currency?.code ?? "USD";
  const symbol = activity.option_symbol?.ticker ?? activity.symbol?.symbol ?? null;
  const units = activity.units ?? 0;
  const raw = activity.description?.trim() || null;
  let description: string;
  let detail: string | null;

  if ((type === "BUY" || type === "SELL") && symbol) {
    description = `${type === "BUY" ? "Bought" : "Sold"} ${symbol}`;
    detail = units ? sharesAt(units, activity.price, currency) : raw;
  } else if (symbol) {
    description = `${symbol} ${label.toLowerCase()}`;
    detail = raw;
  } else {
    // Cash moves carry the brokerage's own wording, such as the payroll
    // company behind a direct deposit.
    description = raw ?? label;
    detail = raw === null ? null : label;
  }

  return {
    id: activity.id ?? `${accountId}:${date}:${type}:${index}`,
    accountId,
    date,
    description,
    detail,
    // SnapTrade amounts are already from the account's side.
    amount: activity.amount ?? 0,
    currency,
    pending: false,
  };
}

// A Plaid investment transaction (brokerages SnapTrade doesn't support).
export function fromPlaidInvestmentTransaction(
  transaction: InvestmentTransaction,
  security: Security | undefined,
): AccountTransaction {
  const currency = transaction.iso_currency_code ?? transaction.unofficial_currency_code ?? "USD";
  const ticker = security?.ticker_symbol ?? null;
  const isTrade = transaction.type === "buy" || transaction.type === "sell";
  const subtype = titleCase(String(transaction.subtype));

  return {
    id: `plaid:${transaction.investment_transaction_id}`,
    accountId: `plaid:${transaction.account_id}`,
    date: transaction.date,
    description: isTrade && ticker ? `${transaction.type === "buy" ? "Bought" : "Sold"} ${ticker}` : transaction.name,
    detail: isTrade && transaction.quantity ? sharesAt(transaction.quantity, transaction.price, currency) : subtype,
    // Plaid amounts are positive when cash leaves the account.
    amount: -transaction.amount,
    currency,
    pending: false,
  };
}

// Newest first; pending transactions lead, since they are the most recent.
export function sortNewestFirst(transactions: AccountTransaction[]): AccountTransaction[] {
  return [...transactions].sort(
    (a, b) => Number(b.pending) - Number(a.pending) || b.date.localeCompare(a.date) || a.id.localeCompare(b.id),
  );
}

export function pageOf(
  sorted: AccountTransaction[],
  offset: number,
  limit = ACCOUNT_TRANSACTIONS_PAGE_SIZE,
): Pick<AccountTransactionsPage, "transactions" | "nextOffset" | "total"> {
  const transactions = sorted.slice(offset, offset + limit);
  const end = offset + transactions.length;

  return { transactions, nextOffset: end < sorted.length ? end : null, total: sorted.length };
}
