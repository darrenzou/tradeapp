import "server-only";

import { AccountType, type AccountBase, type Transaction } from "plaid";

import { getDailyCloses, type DailyClose } from "@/lib/alpaca";
import {
  positionsWithHistory,
  yearlyAppreciation,
  type AppreciationPosition,
  type YearAppreciation,
} from "@/lib/appreciation";
import { buildCashflow, type CashTransaction, type Cashflow } from "@/lib/cashflow";
import { listPlaidItems, type PlaidItem } from "@/lib/linked-accounts";
import { liveTicker } from "@/lib/live-valuation";
import { PLAID_MAX_TRANSACTION_DAYS, listAllTransactions } from "@/lib/plaid";
import { loadActivityHistory, loadLinkedPortfolio, loadLivePrices } from "@/lib/portfolio-data";

// How far back the Spending page looks.
export const SPENDING_HISTORY_MONTHS = 36;

export type HistoryCoverage = {
  // First day of the page's 3-year window.
  windowStart: string;
  // Oldest posted transaction across all banks and cards, if any.
  earliest: string | null;
  // Oldest transaction at each bank, oldest first.
  institutions: { name: string; earliest: string | null }[];
  // Plaid is still fetching older history for at least one bank.
  stillLoading: boolean;
  maxPlaidMonths: number;
};

export type SpendingData = Cashflow & {
  coverage: HistoryCoverage;
  years: YearAppreciation[];
  today: string;
  hasBanks: boolean;
  issues: string[];
};

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

async function loadAppreciation(
  userId: string,
  years: number[],
  today: string,
  issues: string[],
): Promise<YearAppreciation[]> {
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

  const positions = positionsWithHistory([...byLot.values()], history.activities);
  const symbols = positions.flatMap((position) => position.ticker ?? []).sort();
  let closes = new Map<string, DailyClose[]>();

  if (symbols.length > 0) {
    // A couple of weeks before the first year so its opening close is found
    // even across holidays.
    const start = `${years[0] - 1}-12-15`;

    try {
      closes = await cached(priceCache, `${start}:${symbols.join(",")}`, PRICE_CACHE_MS, () =>
        getDailyCloses(symbols, start, today),
      );
    } catch {
      issues.push("Past stock prices couldn't be loaded, so stock appreciation isn't shown.");
      return years.map((year) => ({ year, amount: null, status: "unavailable", note: null }));
    }
  }

  return yearlyAppreciation({
    positions,
    activities: history.activities,
    historyStarts: history.historyStarts,
    closes,
    years,
    today,
  });
}

export async function loadSpending(userId: string): Promise<SpendingData> {
  const issues: string[] = [];
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const endMonth = isoMonth(now);
  const windowStartDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (SPENDING_HISTORY_MONTHS - 1), 1));
  const startMonth = isoMonth(windowStartDate);
  const firstYear = windowStartDate.getUTCFullYear();
  const years = Array.from({ length: now.getUTCFullYear() - firstYear + 1 }, (_, index) => firstYear + index);

  const items = await listPlaidItems(userId);
  const [itemResults, appreciation] = await Promise.all([
    Promise.allSettled(
      items.map((item) => cached(transactionCache, `${userId}:${item.itemId}`, CACHE_MS, () => loadItemTransactions(item))),
    ),
    loadAppreciation(userId, years, today, issues).catch(() => {
      issues.push("Investment history couldn't be loaded, so stock appreciation isn't shown.");
      return years.map((year): YearAppreciation => ({ year, amount: null, status: "unavailable", note: null }));
    }),
  ]);

  const transactions: CashTransaction[] = [];
  const institutions: HistoryCoverage["institutions"] = [];
  let stillLoading = false;

  itemResults.forEach((result, index) => {
    const name = items[index].institutionName ?? "Bank";

    if (result.status === "rejected") {
      issues.push(`Transactions from ${name} couldn't be loaded right now. It may need to be reconnected.`);
      return;
    }

    const posted = result.value.transactions.filter((transaction) => !transaction.pending);
    transactions.push(...result.value.transactions);
    stillLoading ||= !result.value.historicalComplete;
    institutions.push({
      name,
      earliest: posted.reduce<string | null>(
        (earliest, transaction) => (earliest === null || transaction.date < earliest ? transaction.date : earliest),
        null,
      ),
    });
  });

  institutions.sort((a, b) => (a.earliest ?? "9999").localeCompare(b.earliest ?? "9999"));

  return {
    ...buildCashflow(transactions, startMonth, endMonth),
    coverage: {
      windowStart: `${startMonth}-01`,
      earliest: institutions.find((institution) => institution.earliest !== null)?.earliest ?? null,
      institutions,
      stillLoading,
      maxPlaidMonths: Math.round(PLAID_MAX_TRANSACTION_DAYS / 30.4),
    },
    years: appreciation,
    today,
    hasBanks: items.length > 0,
    issues: [...new Set(issues)],
  };
}
