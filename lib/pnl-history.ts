import "server-only";

import { dailyPnl, marketDaysFrom, type DailyPnlData } from "@/lib/daily-pnl";
import { holdingsOnDay, type DayHoldingsData } from "@/lib/day-holdings";
import { fundIndexes, priceFundsByIndex } from "@/lib/fund-proxies";
import { loadAdjustedCloses, loadCloses, loadInvestmentHistory, type InvestmentHistory } from "@/lib/investment-history";
import type { ReadOptions } from "@/lib/provider-cache";

// Always priced, so the market's open days are known even when the
// portfolio's own symbols are thinly traded.
const MARKET_SYMBOL = "SPY";
// The calendar reaches back at most this many years.
const MAX_YEARS = 5;
const DAY_MS = 86_400_000;

// Today in New York, where market days are counted.
export function marketToday(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(now);
}

function daysBefore(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) - days * DAY_MS).toISOString().slice(0, 10);
}

// Closes for the positions from `start` to `today`, with funds that track an
// index priced by its daily moves (their tickers become that series).
async function loadPricing(investments: InvestmentHistory, start: string, today: string) {
  const indexes = fundIndexes(investments.positions, investments.securities);
  const [closes, indexCloses] = await Promise.all([
    loadCloses(investments.positions, start, today, [MARKET_SYMBOL]),
    loadAdjustedCloses([...indexes.values()], start, today),
  ]);
  const priced = priceFundsByIndex(investments.positions, indexes, indexCloses, marketToday());

  return { positions: priced.positions, closes: new Map([...closes, ...priced.closes]), indexed: priced.funds };
}

// The portfolio's P&L on each market day its transaction history covers,
// for the P&L calendar.
export async function loadDailyPnl(userId: string, options: ReadOptions = {}): Promise<DailyPnlData> {
  const issues: string[] = [];
  const today = marketToday();
  const investments = await loadInvestmentHistory(userId, issues, options);
  const { history } = investments;
  const earliest = [...history.historyStarts.values()].sort()[0] ?? today;
  const limit = `${Number(today.slice(0, 4)) - MAX_YEARS}-01-01`;
  // A couple of weeks before the history starts, so the opening close is
  // found across holidays.
  const start = daysBefore(earliest < limit ? limit : earliest, 15);
  const { positions, closes, indexed } = await loadPricing(investments, start, today);
  const result = dailyPnl({
    positions,
    activities: history.activities,
    historyStarts: history.historyStarts,
    closes,
    marketDays: marketDaysFrom(closes, today),
    today,
  });

  return { today, ...result, indexed: indexed.size, issues };
}

// A day the holdings can't be shown for, with why.
export class DayUnavailableError extends Error {}

// The Stocks page's holdings as they stood at the close of a past market
// day, for a day tapped on the P&L calendar.
export async function loadHoldingsOnDay(userId: string, date: string, options: ReadOptions = {}): Promise<DayHoldingsData> {
  const issues: string[] = [];

  if (date > marketToday()) {
    throw new DayUnavailableError("That day hasn't happened yet.");
  }

  const investments = await loadInvestmentHistory(userId, issues, options);
  const { portfolio, history } = investments;
  // From a couple of weeks back, so the previous market day's close is found
  // across holidays, through today, so index-priced funds scale to their
  // current price.
  const { closes, indexed } = await loadPricing(investments, daysBefore(date, 15), marketToday());
  const marketDays = marketDaysFrom(closes, date);

  if (marketDays.at(-1) !== date) {
    throw new DayUnavailableError("The market was closed that day.");
  }

  const result = holdingsOnDay({
    date,
    previousDate: marketDays.at(-2) ?? null,
    accounts: portfolio.accounts,
    holdings: portfolio.holdings,
    holdingsLoaded: portfolio.holdingsLoaded,
    activities: history.activities,
    historyStarts: history.historyStarts,
    closes,
    indexed,
  });

  return { ...result, issues };
}
