import "server-only";

import { AccountType, type AccountBase, type Transaction } from "plaid";

import { getDailyCloses, type DailyClose } from "@/lib/alpaca";
import {
  positionsWithHistory,
  monthlyAppreciation,
  yearlyAppreciation,
  type MonthAppreciation,
  type AppreciationPosition,
  type YearAppreciation,
} from "@/lib/appreciation";
import {
  buildCashflow,
  listMonthTransactions,
  monthRange,
  type CashTransaction,
  type Cashflow,
  type MonthTotals,
  type MonthTransaction,
} from "@/lib/cashflow";
import { listPlaidItems, type PlaidItem } from "@/lib/linked-accounts";
import { liveTicker } from "@/lib/live-valuation";
import { PLAID_MAX_TRANSACTION_DAYS, listAllTransactions } from "@/lib/plaid";
import {
  loadActivityHistory,
  loadLinkedPortfolio,
  loadLivePrices,
  type BrokerageCashActivity,
} from "@/lib/portfolio-data";

// How far back the Spending page looks.
export const SPENDING_HISTORY_MONTHS = 36;

export type HistoryCoverage = {
  // First day of the page's 3-year window.
  windowStart: string;
  // Oldest posted transaction across all banks and cards, if any.
  earliest: string | null;
  // Oldest transaction at each bank, oldest first. canFetchMore marks banks
  // linked when the app asked Plaid for only 180 days: reconnecting them
  // fetches up to 24 months.
  institutions: { itemId: string; name: string; earliest: string | null; canFetchMore: boolean }[];
  // Plaid is still fetching older history for at least one bank.
  stillLoading: boolean;
  maxPlaidMonths: number;
};

export type SpendingData = Cashflow & {
  coverage: HistoryCoverage;
  years: YearAppreciation[];
  // Stock appreciation for each month of the window, oldest first.
  monthAppreciation: MonthAppreciation[];
  today: string;
  hasBanks: boolean;
  issues: string[];
};

// Banks linked from this day on asked Plaid for its full 24 months.
const FULL_HISTORY_REQUESTED_SINCE = "2026-09-29";

const CACHE_MS = 15 * 60_000;
const PRICE_CACHE_MS = 6 * 60 * 60_000;

// Bank history changes at most a few times a day, so each Item's
// transactions are cached per server instance, like investment activity.
const transactionCache = new Map<
  string,
  { expires: number; value: Promise<{ transactions: CashTransaction[]; historicalComplete: boolean }> }
>();
const priceCache = new Map<string, { expires: number; value: Promise<Map<string, DailyClose[]>> }>();

function cached<T>(
  cache: Map<string, { expires: number; value: Promise<T> }>,
  key: string,
  ttl: number,
  load: () => Promise<T>,
): Promise<T> {
  const now = Date.now();
  const entry = cache.get(key);

  if (entry !== undefined && entry.expires > now) {
    return entry.value;
  }

  const value = load();
  cache.set(key, { expires: now + ttl, value });
  value.catch(() => cache.delete(key));
  return value;
}

const ACCOUNT_KINDS: Partial<Record<AccountType, CashTransaction["accountKind"]>> = {
  [AccountType.Depository]: "depository",
  [AccountType.Credit]: "credit",
  [AccountType.Loan]: "loan",
  [AccountType.Investment]: "investment",
  [AccountType.Brokerage]: "investment",
};

function toCashTransaction(transaction: Transaction, accounts: Map<string, AccountBase>): CashTransaction {
  const account = accounts.get(transaction.account_id);
  const suffix = account?.mask ? ` ••${account.mask}` : "";

  return {
    id: transaction.transaction_id,
    accountId: transaction.account_id,
    accountKind: (account && ACCOUNT_KINDS[account.type]) ?? "other",
    accountName: account ? `${account.name}${suffix}` : "Account",
    date: transaction.date,
    amount: transaction.amount,
    name: transaction.merchant_name ?? transaction.name,
    primary: transaction.personal_finance_category?.primary ?? null,
    detailed: transaction.personal_finance_category?.detailed ?? null,
    pending: transaction.pending,
    currency: transaction.iso_currency_code ?? transaction.unofficial_currency_code ?? "USD",
  };
}

async function loadItemTransactions(item: PlaidItem) {
  const history = await listAllTransactions(item.accessToken);
  const accounts = new Map(history.accounts.map((account) => [account.account_id, account]));

  return {
    transactions: history.transactions.map((transaction) => toCashTransaction(transaction, accounts)),
    historicalComplete: history.historicalComplete,
  };
}

function isoMonth(date: Date): string {
  return date.toISOString().slice(0, 7);
}

type Appreciation = { years: YearAppreciation[]; months: MonthAppreciation[] };

// Stock appreciation, plus cash that moved in or out of brokerage accounts
// (dividends and interest count as income; money added or withdrawn matches
// the bank side of the transfer).
type Investments = { appreciation: Appreciation; brokerageCash: CashTransaction[] };

function unavailable(years: number[], months: string[]): Appreciation {
  return {
    years: years.map((year) => ({ year, amount: null, status: "unavailable", note: null })),
    months: months.map((month) => ({ month, amount: null, status: "unavailable", note: null })),
  };
}

const BROKERAGE_CASH_CATEGORIES: Record<BrokerageCashActivity["type"], { primary: string; detailed: string }> = {
  dividend: { primary: "INCOME", detailed: "INCOME_DIVIDENDS" },
  interest: { primary: "INCOME", detailed: "INCOME_INTEREST_EARNED" },
  contribution: { primary: "TRANSFER_IN", detailed: "TRANSFER_IN_INVESTMENT_AND_RETIREMENT_FUNDS" },
  withdrawal: { primary: "TRANSFER_OUT", detailed: "TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS" },
};

const BROKERAGE_CASH_NAMES: Record<BrokerageCashActivity["type"], string> = {
  dividend: "Dividend",
  interest: "Interest",
  contribution: "Money added",
  withdrawal: "Withdrawal",
};

// A brokerage cash movement in the same shape (and sign) as a Plaid bank
// transaction, so it is classified and totaled the same way.
function toBrokerageTransaction(activity: BrokerageCashActivity, accountNames: Map<string, string>): CashTransaction {
  const label = BROKERAGE_CASH_NAMES[activity.type];

  return {
    id: activity.id,
    accountId: activity.accountId,
    accountKind: "brokerage",
    accountName: accountNames.get(activity.accountId) ?? "Brokerage account",
    date: activity.date,
    amount: -activity.amount,
    name: activity.symbol ? `${activity.symbol} ${label.toLowerCase()}` : label,
    ...BROKERAGE_CASH_CATEGORIES[activity.type],
    pending: false,
    currency: "USD",
  };
}

async function loadInvestments(
  userId: string,
  years: number[],
  months: string[],
  today: string,
  issues: string[],
): Promise<Investments> {
  const portfolio = await loadLinkedPortfolio(userId, issues);
  const [prices, history] = await Promise.all([
    loadLivePrices(portfolio.holdings, issues),
    loadActivityHistory(userId, portfolio.sources, issues),
  ]);

  const byLot = new Map<string, AppreciationPosition>();

  for (const holding of portfolio.holdings) {
    if (holding.isCash) {
      continue;
    }

    const ticker = liveTicker(holding);
    const quote = ticker === null ? undefined : prices.quotes.get(ticker);
    const value =
      quote !== undefined && holding.institutionValue !== null
        ? holding.quantity * quote.price
        : holding.institutionValue ?? holding.quantity * (holding.institutionPrice ?? 0);
    const lot = `${holding.accountId}|${holding.key}`;
    const position = byLot.get(lot) ?? {
      accountId: holding.accountId,
      key: holding.key,
      ticker,
      quantity: 0,
      currentValue: 0,
    };

    position.quantity += holding.quantity;
    position.currentValue += value;
    byLot.set(lot, position);
  }

  const accountNames = new Map(
    portfolio.accounts.map((account) => [account.id, account.institution ? `${account.institution} ${account.name}` : account.name]),
  );
  const brokerageCash = history.cash.map((activity) => toBrokerageTransaction(activity, accountNames));
  const positions = positionsWithHistory([...byLot.values()], history.activities);
  const symbols = positions.flatMap((position) => position.ticker ?? []).sort();
  let closes = new Map<string, DailyClose[]>();

  if (symbols.length > 0) {
    // A couple of weeks before the first year so its opening close is found
    // even across holidays. The same range serves every month in it.
    const start = `${years[0] - 1}-12-15`;

    try {
      closes = await cached(priceCache, `${start}:${symbols.join(",")}`, PRICE_CACHE_MS, () =>
        getDailyCloses(symbols, start, today),
      );
    } catch {
      issues.push("Past stock prices couldn't be loaded, so stock appreciation isn't shown.");
      return { appreciation: unavailable(years, months), brokerageCash };
    }
  }

  const input = { positions, activities: history.activities, historyStarts: history.historyStarts, closes, today };

  return {
    appreciation: { years: yearlyAppreciation({ ...input, years }), months: monthlyAppreciation(input, months) },
    brokerageCash,
  };
}

function noInvestments(years: number[], months: string[], issues: string[]): Investments {
  issues.push("Investment history couldn't be loaded, so stock appreciation and brokerage dividends aren't shown.");
  return { appreciation: unavailable(years, months), brokerageCash: [] };
}

function yearsOf(firstYear: number, now: Date): number[] {
  return Array.from({ length: now.getUTCFullYear() - firstYear + 1 }, (_, index) => firstYear + index);
}

type BankTransactions = {
  transactions: CashTransaction[];
  institutions: HistoryCoverage["institutions"];
  stillLoading: boolean;
  hasBanks: boolean;
};

// Every linked bank's and card's transactions, with how far back each goes.
async function loadBankTransactions(userId: string, issues: string[]): Promise<BankTransactions> {
  const items = await listPlaidItems(userId);
  const results = await Promise.allSettled(
    items.map((item) => cached(transactionCache, `${userId}:${item.itemId}`, CACHE_MS, () => loadItemTransactions(item))),
  );
  const transactions: CashTransaction[] = [];
  const institutions: HistoryCoverage["institutions"] = [];
  let stillLoading = false;

  results.forEach((result, index) => {
    const item = items[index];
    const name = item.institutionName ?? "Bank";

    if (result.status === "rejected") {
      issues.push(`Transactions from ${name} couldn't be loaded right now. It may need to be reconnected.`);
      return;
    }

    const posted = result.value.transactions.filter((transaction) => !transaction.pending);
    transactions.push(...result.value.transactions);
    stillLoading ||= !result.value.historicalComplete;
    institutions.push({
      itemId: item.itemId,
      name,
      earliest: posted.reduce<string | null>(
        (earliest, transaction) => (earliest === null || transaction.date < earliest ? transaction.date : earliest),
        null,
      ),
      canFetchMore: item.createdAt !== undefined && item.createdAt < FULL_HISTORY_REQUESTED_SINCE,
    });
  });

  institutions.sort((a, b) => (a.earliest ?? "9999").localeCompare(b.earliest ?? "9999"));

  return { transactions, institutions, stillLoading, hasBanks: items.length > 0 };
}

function spendingWindow(now: Date) {
  const windowStartDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (SPENDING_HISTORY_MONTHS - 1), 1));
  return { startMonth: isoMonth(windowStartDate), endMonth: isoMonth(now), firstYear: windowStartDate.getUTCFullYear() };
}

function coverageOf(bank: BankTransactions, startMonth: string): HistoryCoverage {
  return {
    windowStart: `${startMonth}-01`,
    earliest: bank.institutions.find((institution) => institution.earliest !== null)?.earliest ?? null,
    institutions: bank.institutions,
    stillLoading: bank.stillLoading,
    maxPlaidMonths: Math.round(PLAID_MAX_TRANSACTION_DAYS / 30.4),
  };
}

export async function loadSpending(userId: string): Promise<SpendingData> {
  const issues: string[] = [];
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const { startMonth, endMonth, firstYear } = spendingWindow(now);
  const years = yearsOf(firstYear, now);
  const months = monthRange(startMonth, endMonth);

  const [bank, { appreciation, brokerageCash }] = await Promise.all([
    loadBankTransactions(userId, issues),
    loadInvestments(userId, years, months, today, issues).catch(() => noInvestments(years, months, issues)),
  ]);

  return {
    ...buildCashflow([...bank.transactions, ...brokerageCash], startMonth, endMonth),
    coverage: coverageOf(bank, startMonth),
    years: appreciation.years,
    monthAppreciation: appreciation.months,
    today,
    hasBanks: bank.hasBanks,
    issues: [...new Set(issues)],
  };
}

export type SpendingMonthData = {
  month: string;
  totals: MonthTotals;
  transactions: MonthTransaction[];
  stockAppreciation: MonthAppreciation;
  // Neighboring months inside the page's window, for paging.
  previousMonth: string | null;
  nextMonth: string | null;
  coverage: HistoryCoverage;
  hasBanks: boolean;
  issues: string[];
};

// One month's transactions, for the month detail page. Null when the month
// is outside the page's 3-year window.
export async function loadSpendingMonth(userId: string, month: string): Promise<SpendingMonthData | null> {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const { startMonth, endMonth, firstYear } = spendingWindow(now);

  if (month < startMonth || month > endMonth) {
    return null;
  }

  const issues: string[] = [];
  const years = yearsOf(firstYear, now);
  const [bank, { appreciation, brokerageCash }] = await Promise.all([
    loadBankTransactions(userId, issues),
    loadInvestments(userId, years, [month], today, issues).catch(() => noInvestments(years, [month], issues)),
  ]);
  const months = monthRange(startMonth, endMonth);
  const index = months.indexOf(month);
  const transactions = [...bank.transactions, ...brokerageCash];
  const totals = buildCashflow(transactions, month, month).months[0];

  return {
    month,
    totals,
    transactions: listMonthTransactions(transactions, month),
    stockAppreciation: appreciation.months[0],
    previousMonth: months[index - 1] ?? null,
    nextMonth: months[index + 1] ?? null,
    coverage: coverageOf(bank, startMonth),
    hasBanks: bank.hasBanks,
    issues: [...new Set(issues)],
  };
}
