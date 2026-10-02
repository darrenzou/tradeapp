import "server-only";

import { AccountSubtype, AccountType, type AccountBase, type Security } from "plaid";

import { findDuplicateAccounts, plaidAccountIdentity, plaidAccountName, type AccountIdentity } from "@/lib/account-dedupe";
import {
  fromPlaidInvestmentTransaction,
  fromSnapTradeActivity,
  type AccountTransaction,
} from "@/lib/account-history";
import { getLatestStockQuotes, type StockQuote } from "@/lib/alpaca";
import { getSnapTradeCredentials, listPlaidItems, type PlaidItem } from "@/lib/linked-accounts";
import { liveAdjustments, liveTicker, type LiveAdjustment } from "@/lib/live-valuation";
import type { AccountKind, LinkedAccount } from "@/lib/net-worth";
import {
  getInvestmentHoldings,
  listFinancialAccounts,
  listInvestmentTransactions,
} from "@/lib/plaid";
import type { InvestmentActivity, PortfolioHolding } from "@/lib/portfolio";
import { cachedRead, type ProviderCache, type ReadOptions } from "@/lib/provider-cache";
import {
  getBrokerageAccountPositions,
  listAccountActivities,
  listBrokerageAccounts,
  type SnapTradeUserCredentials,
} from "@/lib/snaptrade";

// Everything linked for a user, with balances as the providers report them.
export type LinkedPortfolio = {
  brokerageConnected: boolean;
  plaidConnectionCount: number;
  accounts: LinkedAccount[];
  holdings: PortfolioHolding[];
  // Investment accounts whose holdings were loaded; the others have only a balance.
  holdingsLoaded: Set<string>;
  sources: {
    snaptrade: { credentials: SnapTradeUserCredentials; accountIds: string[] } | null;
    // Plaid items with investment holdings, the only ones with investment history.
    plaidInvestmentItems: PlaidItem[];
    // Second copies of accounts linked through more than one connection,
    // such as a joint account linked from both owners' logins. They are left
    // out of accounts and holdings, and their history is skipped too.
    duplicateAccountIds: Set<string>;
  };
};

export type LivePrices = {
  quotes: Map<string, StockQuote>;
  adjustments: Map<string, LiveAdjustment>;
  // Time of the newest live quote used, when any holdings were repriced.
  pricesAsOf: string | null;
};

// Cash that moved in or out of a brokerage account (SnapTrade or Plaid):
// dividends and interest paid, and money added or withdrawn.
export type BrokerageCashActivity = {
  id: string;
  // LinkedAccount id, e.g. "snaptrade:…" or "plaid:…".
  accountId: string;
  date: string;
  type: "dividend" | "interest" | "contribution" | "withdrawal";
  // From the account's side: positive when money arrived in the account.
  amount: number;
  symbol: string | null;
  // The brokerage's own description, e.g. "DIRECT DEPOSIT ACME PAYROLL".
  description: string | null;
};

export type ActivityHistory = {
  activities: InvestmentActivity[];
  cash: BrokerageCashActivity[];
  // Earliest date each account's history covers, keyed by LinkedAccount id.
  historyStarts: Map<string, string>;
};

const PLAID_KINDS: Partial<Record<AccountType, AccountKind>> = {
  [AccountType.Depository]: "cash",
  [AccountType.Credit]: "credit",
  [AccountType.Loan]: "loan",
  [AccountType.Investment]: "investment",
  [AccountType.Brokerage]: "investment",
  [AccountType.Other]: "other",
};

// SnapTrade instrument kinds that trade as US-listed shares; other kinds keep
// their own name so they are not live-priced.
const SNAPTRADE_SECURITY_TYPES: Record<string, string> = {
  stock: "equity",
  adr: "equity",
  etf: "etf",
};

const PLAID_HISTORY_DAYS = 730;
const ACTIVITY_CACHE_MS = 15 * 60_000;
const DAY_MS = 86_400_000;

type ProviderAccounts = {
  accounts: LinkedAccount[];
  // One per account, for spotting the same account in two connections.
  identities: AccountIdentity[];
  holdings: PortfolioHolding[];
  holdingsLoaded: string[];
};

function isoDate(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

function holdingKey(ticker: string | null | undefined, name: string): string {
  return ticker?.trim().toUpperCase() || name;
}

function isPlaidCash(security: Security | undefined): boolean {
  return security?.type === "cash" || security?.is_cash_equivalent === true;
}

async function loadSnapTradeHoldings(
  credentials: SnapTradeUserCredentials,
  snaptradeAccountId: string,
): Promise<PortfolioHolding[] | null> {
  try {
    const { results } = await getBrokerageAccountPositions(credentials, snaptradeAccountId);

    return results.flatMap((position): PortfolioHolding[] => {
      const units = Number(position.units);
      const price = Number(position.price);
      const averageCost = position.cost_basis == null ? NaN : Number(position.cost_basis);
      const instrument = position.instrument;
      const ticker = "symbol" in instrument ? instrument.symbol : null;
      const name = ("description" in instrument ? instrument.description : null) ?? ticker ?? "Unknown security";

      // Totals are in US dollars; Alpaca quotes are US listings only.
      if (position.currency !== "USD" || !Number.isFinite(units) || !Number.isFinite(price)) {
        return [];
      }

      return [{
        accountId: `snaptrade:${snaptradeAccountId}`,
        key: holdingKey(ticker, name),
        ticker,
        name,
        securityType: SNAPTRADE_SECURITY_TYPES[instrument.kind] ?? instrument.kind,
        quantity: units,
        institutionPrice: price,
        institutionValue: units * price,
        // SnapTrade reports cost basis per share.
        costBasis: Number.isFinite(averageCost) ? averageCost * units : null,
        isCash: position.cash_equivalent === true,
      }];
    });
  } catch {
    return null;
  }
}

async function loadBrokerageAccounts(
  userId: string,
  issues: string[],
): Promise<ProviderAccounts & { credentials: SnapTradeUserCredentials | null }> {
  const credentials = await getSnapTradeCredentials(userId);

  if (credentials === null) {
    return { credentials, accounts: [], identities: [], holdings: [], holdingsLoaded: [] };
  }

  let brokerageAccounts: Awaited<ReturnType<typeof listBrokerageAccounts>>;

  try {
    brokerageAccounts = await listBrokerageAccounts(credentials);
  } catch {
    issues.push("Brokerage accounts couldn't be loaded right now.");
    return { credentials, accounts: [], identities: [], holdings: [], holdingsLoaded: [] };
  }

  const accounts: LinkedAccount[] = [];
  const identities: AccountIdentity[] = [];
  let missingBalance = false;

  for (const account of brokerageAccounts) {
    if (account.status === "closed" || account.status === "archived") {
      continue;
    }

    const total = account.balance?.total;

    if (typeof total?.amount !== "number" || !Number.isFinite(total.amount)) {
      missingBalance = true;
      continue;
    }

    const isCreditLine = account.account_category === "LOC";

    accounts.push({
      id: `snaptrade:${account.id}`,
      source: "snaptrade",
      name: account.name ?? "Brokerage account",
      institution: account.institution_name,
      kind: isCreditLine ? "loan" : account.account_category === "DEPOSIT" ? "cash" : "investment",
      balance: isCreditLine ? Math.abs(total.amount) : total.amount,
      currency: total.currency ?? "USD",
    });
    identities.push({
      id: `snaptrade:${account.id}`,
      source: "snaptrade",
      connection: account.brokerage_authorization,
      institution: account.institution_name,
      type: account.account_category ?? account.raw_type ?? "",
      number: account.number,
      persistentId: account.institution_account_id ?? null,
    });
  }

  if (missingBalance) {
    issues.push("Some brokerage balances are still syncing and aren't included yet.");
  }

  const investmentAccounts = accounts.filter((account) => account.kind === "investment");
  const loaded = await Promise.all(
    investmentAccounts.map((account) =>
      loadSnapTradeHoldings(credentials, account.id.slice("snaptrade:".length)),
    ),
  );

  return {
    credentials,
    accounts,
    identities,
    holdings: loaded.flatMap((holdings) => holdings ?? []),
    holdingsLoaded: investmentAccounts.flatMap((account, index) =>
      loaded[index] === null ? [] : [account.id],
    ),
  };
}

function toLinkedAccount(item: PlaidItem, account: AccountBase): LinkedAccount | null {
  const kind = PLAID_KINDS[account.type];
  const current = account.balances.current;

  if (kind === undefined || current === null) {
    return null;
  }

  return {
    id: `plaid:${account.account_id}`,
    source: "plaid",
    name: plaidAccountName(account),
    institution: item.institutionName ?? "Bank",
    kind,
    balance: current,
    currency:
      account.balances.iso_currency_code ??
      account.balances.unofficial_currency_code ??
      "USD",
  };
}

// Brokerage cash management accounts, such as Merrill's CMA, can come
// through Plaid as depository accounts whose balance is the whole account,
// securities included, while their securities also come back as holdings.
function isBrokerageCashAccount(account: AccountBase): boolean {
  return account.type === AccountType.Depository && account.subtype === AccountSubtype.CashManagement;
}

async function loadPlaidItem(item: PlaidItem): Promise<ProviderAccounts> {
  const plaidAccounts = await listFinancialAccounts(item.accessToken);
  const accounts = plaidAccounts.flatMap((account) => toLinkedAccount(item, account) ?? []);
  const linked = new Set(accounts.map((account) => account.id));
  const identities = plaidAccounts
    .map((account) => plaidAccountIdentity(item, account))
    .filter((identity) => linked.has(identity.id));
  const mayHaveHoldings =
    accounts.some((account) => account.kind === "investment") || plaidAccounts.some(isBrokerageCashAccount);

  if (!mayHaveHoldings) {
    return { accounts, identities, holdings: [], holdingsLoaded: [] };
  }

  try {
    const data = await getInvestmentHoldings(item.accessToken);
    const securities = new Map(data.securities.map((security) => [security.security_id, security]));
    const holdings = data.holdings.flatMap((holding): PortfolioHolding[] => {
      const security = securities.get(holding.security_id);
      const currency = holding.iso_currency_code ?? security?.iso_currency_code ?? "USD";

      if (currency !== "USD") {
        return [];
      }

      const ticker = security?.ticker_symbol ?? null;
      const name = security?.name ?? ticker ?? "Unknown security";

      return [{
        accountId: `plaid:${holding.account_id}`,
        key: holdingKey(ticker, name),
        ticker,
        name,
        securityType: security?.type ?? null,
        quantity: holding.quantity,
        institutionPrice: holding.institution_price,
        institutionValue: holding.institution_value ?? null,
        costBasis: holding.cost_basis ?? null,
        isCash: isPlaidCash(security),
      }];
    });
    // An account with holdings is valued as an investment account, by its
    // positions plus uninvested cash, whatever type Plaid gives it. Counting
    // its balance as bank cash would count its securities a second time.
    const withHoldings = new Set(holdings.map((holding) => holding.accountId));
    const valued = accounts.map((account) =>
      account.kind === "cash" && withHoldings.has(account.id) ? { ...account, kind: "investment" as const } : account,
    );
    const investmentIds = valued.filter((account) => account.kind === "investment").map((account) => account.id);
    return { accounts: valued, identities, holdings, holdingsLoaded: investmentIds };
  } catch {
    // Items linked before investment consent was requested, or institutions
    // without holdings data, keep the institution-reported balance.
    return { accounts, identities, holdings: [], holdingsLoaded: [] };
  }
}

async function loadPlaidAccounts(
  userId: string,
  issues: string[],
): Promise<ProviderAccounts & { items: PlaidItem[]; itemHasHoldings: boolean[] }> {
  const items = await listPlaidItems(userId);
  const results = await Promise.allSettled(items.map(loadPlaidItem));
  const merged: ProviderAccounts & { items: PlaidItem[]; itemHasHoldings: boolean[] } = {
    items: [],
    itemHasHoldings: [],
    accounts: [],
    identities: [],
    holdings: [],
    holdingsLoaded: [],
  };

  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      merged.items.push(items[index]);
      merged.itemHasHoldings.push(result.value.holdingsLoaded.length > 0);
      merged.accounts.push(...result.value.accounts);
      merged.identities.push(...result.value.identities);
      merged.holdings.push(...result.value.holdings);
      merged.holdingsLoaded.push(...result.value.holdingsLoaded);
    } else {
      const institution = items[index]?.institutionName ?? "A bank";
      issues.push(`${institution} couldn't be loaded right now. It may need to be reconnected.`);
    }
  });

  return merged;
}

export async function loadLinkedPortfolio(
  userId: string,
  issues: string[],
): Promise<LinkedPortfolio> {
  const [brokerage, plaid] = await Promise.all([
    loadBrokerageAccounts(userId, issues),
    loadPlaidAccounts(userId, issues),
  ]);

  const allLoaded = new Set([...brokerage.holdingsLoaded, ...plaid.holdingsLoaded]);
  // When the same account is linked twice, keep the copy whose holdings
  // loaded, then the one from the older connection (items are listed oldest
  // first). The sort is stable, so it keeps that order otherwise.
  const identities = [...brokerage.identities, ...plaid.identities].sort(
    (a, b) => Number(allLoaded.has(b.id)) - Number(allLoaded.has(a.id)),
  );
  const duplicateAccountIds = new Set(findDuplicateAccounts(identities).keys());
  const isKept = (accountId: string) => !duplicateAccountIds.has(accountId);

  return {
    brokerageConnected: brokerage.credentials !== null,
    plaidConnectionCount: plaid.items.length,
    accounts: [...brokerage.accounts, ...plaid.accounts].filter((account) => isKept(account.id)),
    holdings: [...brokerage.holdings, ...plaid.holdings].filter((holding) => isKept(holding.accountId)),
    holdingsLoaded: new Set([...allLoaded].filter(isKept)),
    sources: {
      snaptrade:
        brokerage.credentials === null
          ? null
          : {
              credentials: brokerage.credentials,
              accountIds: brokerage.holdingsLoaded.filter(isKept).map((id) => id.slice("snaptrade:".length)),
            },
      plaidInvestmentItems: plaid.items.filter((item, index) => plaid.itemHasHoldings[index]),
      duplicateAccountIds,
    },
  };
}

// Fetches one batch of live Alpaca quotes for every stock and ETF holding.
export async function loadLivePrices(
  holdings: PortfolioHolding[],
  issues: string[],
): Promise<LivePrices> {
  const symbols = holdings.flatMap((holding) => liveTicker(holding) ?? []);
  let quotes = new Map<string, StockQuote>();

  if (symbols.length > 0) {
    try {
      quotes = await getLatestStockQuotes(symbols);
    } catch {
      issues.push("Live prices are unavailable right now. Investment values are from the last update.");
    }
  }

  const adjustments = liveAdjustments(holdings, quotes);
  const asOfTimes = [...adjustments.values()].map((adjustment) => adjustment.asOf).sort();

  return { quotes, adjustments, pricesAsOf: asOfTimes.at(-1) ?? null };
}

// One source's history as cached: the parsed history, plus every
// transaction as the Overview's account screen lists it.
type SourceHistory = ActivityHistory & { ledger: AccountTransaction[] };

// Transaction history changes at most daily, so it is cached per server
// instance to keep the once-a-minute live refresh cheap.
const activityCache: ProviderCache<SourceHistory> = new Map();

const SNAPTRADE_TRADE_TYPES = new Set(["BUY", "SELL", "REI"]);
const SNAPTRADE_INCOME_TYPES = new Set([
  "DIVIDEND",
  "SUBSTITUTE_DIVIDEND",
  "RETURN_OF_CAPITAL",
  "DISTRIBUTION",
  "INTEREST",
  "TAX",
  "FEE",
]);

const SNAPTRADE_CASH_TYPES: Record<string, BrokerageCashActivity["type"]> = {
  DIVIDEND: "dividend",
  SUBSTITUTE_DIVIDEND: "dividend",
  INTEREST: "interest",
  CONTRIBUTION: "contribution",
  WITHDRAWAL: "withdrawal",
};

async function loadSnapTradeActivities(
  credentials: SnapTradeUserCredentials,
  snaptradeAccountId: string,
): Promise<SourceHistory> {
  const accountId = `snaptrade:${snaptradeAccountId}`;
  const raw = await listAccountActivities(credentials, snaptradeAccountId);
  const activities: InvestmentActivity[] = [];
  const cash: BrokerageCashActivity[] = [];
  const ledger = raw.flatMap((activity, index) => fromSnapTradeActivity(activity, accountId, index) ?? []);
  let earliest: string | null = null;

  for (const activity of raw) {
    const date = (activity.trade_date ?? activity.settlement_date)?.slice(0, 10);

    if (!date) {
      continue;
    }

    if (earliest === null || date.localeCompare(earliest) < 0) {
      earliest = date;
    }

    const ticker = activity.symbol?.symbol;
    const type = activity.type ?? "";
    const units = activity.units ?? 0;
    const amount = activity.amount ?? 0;
    const cashType = SNAPTRADE_CASH_TYPES[type];

    if (cashType !== undefined && amount !== 0 && (activity.currency?.code ?? "USD") === "USD") {
      cash.push({
        id: `snaptrade:${activity.id ?? `${snaptradeAccountId}:${date}:${type}:${amount}:${cash.length}`}`,
        accountId,
        date,
        type: cashType,
        amount,
        symbol: ticker ?? null,
        description: activity.description || null,
      });
    }

    if (!ticker || activity.option_symbol || (activity.currency?.code ?? "USD") !== "USD") {
      continue;
    }

    const key = holdingKey(ticker, ticker);

    // SnapTrade amounts are from the account's side (a buy is negative),
    // which is also the investor's side of a holding's cash flow.
    if (SNAPTRADE_TRADE_TYPES.has(type)) {
      activities.push({
        accountId,
        key,
        date,
        shareChange: units,
        cashFlow: amount - (activity.fee ?? 0),
        // Recurring buys come through as ordinary buys; REI is a reinvested dividend.
        purchase: type !== "SELL" && units > 0,
      });
    } else if (SNAPTRADE_INCOME_TYPES.has(type)) {
      activities.push({ accountId, key, date, shareChange: 0, cashFlow: amount });
    } else if (type.includes("TRANSFER")) {
      // Shares moved in count as money invested at the transfer price, or at
      // average cost when the brokerage reports no price.
      const price = activity.price ?? 0;
      activities.push({ accountId, key, date, shareChange: units, cashFlow: -units * price, valueAtCost: price === 0 });
    } else if (units !== 0) {
      // Splits, stock dividends, spinoffs, and mergers change shares only.
      activities.push({ accountId, key, date, shareChange: units, cashFlow: 0 });
    }
  }

  return {
    activities,
    cash,
    historyStarts: earliest === null ? new Map() : new Map([[accountId, earliest]]),
    ledger,
  };
}

// Plaid cash subtypes that are income or money moved in or out. Fund capital
// gain distributions count as dividends. "transfer" goes either way, so its
// direction comes from the amount's sign.
const PLAID_CASH_SUBTYPES: Record<string, BrokerageCashActivity["type"] | "transfer"> = {
  dividend: "dividend",
  "qualified dividend": "dividend",
  "non-qualified dividend": "dividend",
  "long-term capital gain": "dividend",
  "short-term capital gain": "dividend",
  interest: "interest",
  contribution: "contribution",
  deposit: "contribution",
  withdrawal: "withdrawal",
  transfer: "transfer",
};

async function loadPlaidActivities(item: PlaidItem): Promise<SourceHistory> {
  const now = Date.now();
  const startDate = isoDate(now - PLAID_HISTORY_DAYS * DAY_MS);
  const data = await listInvestmentTransactions(item.accessToken, startDate, isoDate(now));
  const securities = new Map(data.securities.map((security) => [security.security_id, security]));
  const activities: InvestmentActivity[] = [];
  const cash: BrokerageCashActivity[] = [];
  // The request covers the full window for every investment account in the
  // item, including accounts with no transactions in it.
  const accountIds = new Set<string>(
    data.accounts
      .filter((account) => account.type === AccountType.Investment || account.type === AccountType.Brokerage)
      .map((account) => `plaid:${account.account_id}`),
  );

  for (const transaction of data.investment_transactions) {
    const accountId = `plaid:${transaction.account_id}`;
    accountIds.add(accountId);

    const security = transaction.security_id === null ? undefined : securities.get(transaction.security_id);
    const cashType = transaction.type === "cash" ? PLAID_CASH_SUBTYPES[transaction.subtype] : undefined;

    if (cashType !== undefined && transaction.amount !== 0 && (transaction.iso_currency_code ?? "USD") === "USD") {
      // Plaid amounts are positive when cash leaves the account.
      const amount = -transaction.amount;
      cash.push({
        id: `plaid:${transaction.investment_transaction_id}`,
        accountId,
        date: transaction.date,
        type: cashType === "transfer" ? (amount > 0 ? "contribution" : "withdrawal") : cashType,
        amount,
        symbol: security !== undefined && !isPlaidCash(security) ? security.ticker_symbol : null,
        description: transaction.name || null,
      });
    }

    if (
      security === undefined ||
      isPlaidCash(security) ||
      (transaction.iso_currency_code ?? "USD") !== "USD"
    ) {
      continue;
    }

    const key = holdingKey(security.ticker_symbol, security.name ?? "Unknown security");
    const base = { accountId, key, date: transaction.date };

    // Plaid amounts are positive when cash leaves the account (a buy), the
    // opposite of the investor's cash flow; fees are reported separately.
    switch (transaction.type) {
      case "buy":
      case "sell":
        activities.push({
          ...base,
          shareChange: transaction.quantity,
          cashFlow: -transaction.amount - (transaction.fees ?? 0),
          // Plaid's buy type includes recurring buys, 401(k) contributions,
          // and dividend reinvestments.
          purchase: transaction.type === "buy" && transaction.quantity > 0,
        });
        break;
      case "cash":
      case "fee":
        activities.push({ ...base, shareChange: 0, cashFlow: -transaction.amount });
        break;
      case "transfer":
        activities.push({
          ...base,
          shareChange: transaction.quantity,
          cashFlow: -transaction.quantity * transaction.price,
          valueAtCost: !transaction.price,
        });
        break;
      default:
        break;
    }
  }

  return {
    activities,
    cash,
    historyStarts: new Map([...accountIds].map((accountId) => [accountId, startDate])),
    ledger: data.investment_transactions.map((transaction) =>
      fromPlaidInvestmentTransaction(
        transaction,
        transaction.security_id === null ? undefined : securities.get(transaction.security_id),
      ),
    ),
  };
}

function readSnapTradeHistory(
  userId: string,
  credentials: SnapTradeUserCredentials,
  snaptradeAccountId: string,
  { fresh }: ReadOptions,
): Promise<SourceHistory> {
  return cachedRead(
    activityCache,
    `${userId}:snaptrade:${snaptradeAccountId}`,
    ACTIVITY_CACHE_MS,
    () => loadSnapTradeActivities(credentials, snaptradeAccountId),
    { fresh },
  );
}

function readPlaidInvestmentHistory(userId: string, item: PlaidItem, { fresh }: ReadOptions): Promise<SourceHistory> {
  return cachedRead(activityCache, `${userId}:plaid:${item.itemId}`, ACTIVITY_CACHE_MS, () => loadPlaidActivities(item), {
    fresh,
  });
}

// Every activity in one SnapTrade account, as its transaction list shows it.
// Shares the cached read with the Stocks and Spending pages.
export async function loadSnapTradeLedger(
  userId: string,
  credentials: SnapTradeUserCredentials,
  snaptradeAccountId: string,
  options: ReadOptions = {},
): Promise<AccountTransaction[]> {
  return (await readSnapTradeHistory(userId, credentials, snaptradeAccountId, options)).ledger;
}

// Every investment transaction in one account of a Plaid item, from the last
// 24 months. Rejects when the item has no investment data.
export async function loadPlaidInvestmentLedger(
  userId: string,
  item: PlaidItem,
  accountId: string,
  options: ReadOptions = {},
): Promise<AccountTransaction[]> {
  const { ledger } = await readPlaidInvestmentHistory(userId, item, options);
  return ledger.filter((transaction) => transaction.accountId === accountId);
}

// Loads transaction history for every account with holdings. An account whose
// history can't be loaded is left out, and its holdings show no IRR.
export async function loadActivityHistory(
  userId: string,
  sources: LinkedPortfolio["sources"],
  issues: string[],
  options: ReadOptions = {},
): Promise<ActivityHistory> {
  const loads: Promise<SourceHistory>[] = [
    ...(sources.snaptrade?.accountIds ?? []).map((accountId) =>
      readSnapTradeHistory(userId, sources.snaptrade!.credentials, accountId, options),
    ),
    ...sources.plaidInvestmentItems.map((item) => readPlaidInvestmentHistory(userId, item, options)),
  ];

  const results = await Promise.allSettled(loads);
  const history: ActivityHistory = { activities: [], cash: [], historyStarts: new Map() };
  let failed = false;

  for (const result of results) {
    if (result.status === "fulfilled") {
      history.activities.push(
        ...result.value.activities.filter((activity) => !sources.duplicateAccountIds.has(activity.accountId)),
      );
      history.cash.push(...result.value.cash.filter((entry) => !sources.duplicateAccountIds.has(entry.accountId)));
      for (const [accountId, start] of result.value.historyStarts) {
        if (!sources.duplicateAccountIds.has(accountId)) {
          history.historyStarts.set(accountId, start);
        }
      }
    } else {
      failed = true;
    }
  }

  if (failed) {
    issues.push("Some transaction history couldn't be loaded, so a few returns aren't shown.");
  }

  return history;
}
