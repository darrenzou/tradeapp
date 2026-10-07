// The Stocks page's holdings as they stood at the close of a past market
// day: shares worked back from today through the transaction history,
// priced at that day's close, with cost basis rolled back the same way
// (average cost: purchases add their cost, sales take out shares at the
// average). Each holding's day P&L uses the P&L calendar's measure, so the
// rows add up to the calendar's figure for that day. Pure, so it runs in
// scripts and tests.

import type { DailyClose } from "./alpaca";
import { tickerFromKey } from "./appreciation";
import { proxySeries } from "./fund-proxies";
import { liveTicker, type Quote } from "./live-valuation";
import type { LinkedAccount } from "./net-worth";
import { buildStocksSummary, type InvestmentActivity, type PortfolioHolding, type StocksSummary } from "./portfolio";

export type DayHoldings = StocksSummary & {
  // YYYY-MM-DD, a market day, and the market day before it.
  date: string;
  previousDate: string | null;
  // Holdings held that day that couldn't be valued (no daily prices or no
  // history reaching back that far), so they aren't shown.
  missing: number;
  // Funds shown that are priced by the daily moves of an index they track.
  indexed: number;
};

export type DayHoldingsData = DayHoldings & { issues: string[] };

type Input = {
  date: string;
  previousDate: string | null;
  // Today's holdings and accounts, as on the Stocks page.
  accounts: LinkedAccount[];
  holdings: PortfolioHolding[];
  holdingsLoaded: Set<string>;
  activities: InvestmentActivity[];
  historyStarts: Map<string, string>;
  // Includes a series for each fund in `indexed`, by proxySeries(key).
  closes: Map<string, DailyClose[]>;
  // Keys of funds without market prices priced by an index they track.
  indexed?: Set<string>;
};

const SHARE_TOLERANCE = 1e-4;
const DAY_MS = 86_400_000;

function previousDay(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10);
}

// The last close on or before `date`.
function closeOn(closes: DailyClose[] | undefined, date: string): number | null {
  let found: number | null = null;

  for (const close of closes ?? []) {
    if (close.date > date) {
      break;
    }
    found = close.close;
  }

  return found;
}

type Lot = {
  accountId: string;
  key: string;
  name: string;
  // The price series: a ticker, or a fund's index series.
  ticker: string | null;
  // As reported, for display.
  reportedTicker: string | null;
  securityType: string | null;
  indexed: boolean;
  quantity: number;
  // Null when any part of the position's cost isn't reported.
  costBasis: number | null;
};

// Rolls a position's shares and cost back past `activities` (all after the
// day), newest first, at average cost.
function rollBack(lot: Lot, newestFirst: InvestmentActivity[]): { shares: number; cost: number | null } {
  let shares = lot.quantity;
  let cost = lot.costBasis;

  for (const activity of newestFirst) {
    if (activity.shareChange === 0) {
      continue;
    }

    if (activity.shareChange < 0 || activity.valueAtCost) {
      // A sale took shares out at the average cost, and shares moved in
      // without a price came in at it: undo either at that average.
      const average = cost !== null && Math.abs(shares) > SHARE_TOLERANCE ? cost / shares : null;
      shares -= activity.shareChange;
      cost = average === null ? null : average * shares;
    } else {
      // A purchase (or a split, which costs nothing).
      shares -= activity.shareChange;
      cost = cost === null ? null : cost + Math.min(0, activity.cashFlow);
    }
  }

  return { shares, cost: cost !== null && cost < -0.005 ? null : cost };
}

export function holdingsOnDay(input: Input): DayHoldings {
  const { date, previousDate } = input;
  const accountsById = new Map(input.accounts.map((account) => [account.id, account]));
  const lots = new Map<string, Lot>();

  for (const holding of input.holdings) {
    const account = accountsById.get(holding.accountId);

    if (holding.isCash || account?.kind !== "investment" || !input.holdingsLoaded.has(holding.accountId)) {
      continue;
    }

    const id = `${holding.accountId}|${holding.key}`;
    const ticker = liveTicker(holding);
    const indexed = ticker === null && (input.indexed?.has(holding.key) ?? false);
    const lot = lots.get(id) ?? {
      accountId: holding.accountId,
      key: holding.key,
      name: holding.name,
      ticker: indexed ? proxySeries(holding.key) : ticker,
      reportedTicker: holding.ticker,
      securityType: holding.securityType,
      indexed,
      quantity: 0,
      costBasis: 0,
    };

    lot.quantity += holding.quantity;
    lot.costBasis = lot.costBasis === null || holding.costBasis === null ? null : lot.costBasis + holding.costBasis;
    lots.set(id, lot);
  }

  // Positions sold out of since still have history.
  for (const activity of input.activities) {
    const id = `${activity.accountId}|${activity.key}`;

    if (!lots.has(id)) {
      lots.set(id, {
        accountId: activity.accountId,
        key: activity.key,
        name: activity.key,
        ticker: tickerFromKey(activity.key),
        reportedTicker: tickerFromKey(activity.key),
        securityType: "equity",
        indexed: false,
        quantity: 0,
        costBasis: 0,
      });
    }
  }

  const activitiesByLot = new Map<string, InvestmentActivity[]>();

  for (const activity of input.activities) {
    const id = `${activity.accountId}|${activity.key}`;
    const list = activitiesByLot.get(id) ?? [];
    list.push(activity);
    activitiesByLot.set(id, list);
  }

  const holdings: PortfolioHolding[] = [];
  const quotes = new Map<string, Quote>();
  const dayPnlByKey = new Map<string, number>();
  // Index-priced funds' change in price, which has no quote.
  const dayChangeByKey = new Map<string, number>();
  const indexedKeys = new Set<string>();
  const accounts = new Map<string, LinkedAccount>();
  let base = 0;
  let missing = 0;

  for (const [id, lot] of lots) {
    const activities = (activitiesByLot.get(id) ?? []).sort((a, b) => b.date.localeCompare(a.date));
    const later = activities.filter((activity) => activity.date > date);
    const { shares, cost } = rollBack(lot, later);
    const tolerance = Math.max(SHARE_TOLERANCE, Math.abs(lot.quantity) * SHARE_TOLERANCE);
    const sinceBefore = previousDate === null ? [] : activities.filter((a) => a.date > previousDate && a.date <= date);
    const heldBefore =
      previousDate === null
        ? 0
        : rollBack(
            lot,
            activities.filter((activity) => activity.date > previousDate),
          ).shares;

    // Not held that day, and nothing happened to it that day.
    if (Math.abs(shares) <= tolerance && Math.abs(heldBefore) <= tolerance && sinceBefore.length === 0) {
      continue;
    }

    const historyStart = input.historyStarts.get(lot.accountId);
    const closes = lot.ticker === null ? undefined : input.closes.get(lot.ticker);
    const close = closeOn(closes, date);

    // Shares are known only from the day before the history starts.
    if (historyStart === undefined || date < previousDay(historyStart) || close === null || lot.ticker === null) {
      missing += 1;
      continue;
    }

    const held = Math.abs(shares) <= tolerance ? 0 : shares;
    const previousClose = previousDate === null ? null : closeOn(closes, previousDate);

    holdings.push({
      accountId: lot.accountId,
      key: lot.key,
      name: lot.name,
      ticker: lot.indexed ? lot.reportedTicker : lot.ticker,
      securityType: lot.indexed ? lot.securityType : lot.securityType === "etf" ? "etf" : "equity",
      quantity: held,
      institutionValue: held * close,
      institutionPrice: close,
      costBasis: held === 0 ? 0 : cost,
      isCash: false,
    });

    if (lot.indexed) {
      indexedKeys.add(lot.key);
      if (previousClose !== null) {
        dayChangeByKey.set(lot.key, close / previousClose - 1);
      }
    } else {
      quotes.set(lot.ticker, { price: close, previousClose, asOf: date });
    }
    const account = accountsById.get(lot.accountId);
    accounts.set(lot.accountId, {
      id: lot.accountId,
      source: account?.source ?? "plaid",
      name: account?.name ?? "Account",
      institution: account?.institution ?? "",
      currency: "USD",
      kind: "investment",
      // Past cash balances aren't known: only the holdings are valued.
      balance: 0,
    });

    // The calendar's measure: change from the previous close plus sales less
    // purchases and dividends that day.
    if (previousDate !== null && previousClose !== null && previousDate >= previousDay(historyStart)) {
      const start = Math.abs(heldBefore) <= tolerance ? 0 : heldBefore * previousClose;
      let flows = 0;
      let income = 0;

      for (const activity of sinceBefore) {
        if (activity.shareChange === 0) {
          income += activity.cashFlow;
        } else if (activity.valueAtCost) {
          flows -= activity.shareChange * (closeOn(closes, activity.date) ?? close);
        } else {
          flows += activity.cashFlow;
        }
      }

      dayPnlByKey.set(lot.key, (dayPnlByKey.get(lot.key) ?? 0) + held * close - start + flows + income);
      base += start + Math.max(0, -flows);
    }
  }

  const summary = buildStocksSummary({
    accounts: [...accounts.values()],
    holdings,
    holdingsLoaded: new Set(accounts.keys()),
    quotes,
    activities: input.activities.filter((activity) => activity.date <= date),
    historyStarts: input.historyStarts,
    today: date,
  });
  const dayPnl = [...dayPnlByKey.values()].reduce((sum, value) => sum + value, 0);

  return {
    ...summary,
    rows: summary.rows.map((row) => ({
      ...row,
      dayPnl: dayPnlByKey.get(row.key) ?? null,
      dayChangePercent: dayChangeByKey.get(row.key) ?? row.dayChangePercent,
    })),
    dayPnl,
    dayPnlPercent: base > 0 ? dayPnl / base : null,
    date,
    previousDate,
    missing,
    indexed: indexedKeys.size,
  };
}
