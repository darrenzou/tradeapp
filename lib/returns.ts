import "server-only";

import { holdingReturns, returnRate, tickerFromKey, type HoldingReturn } from "@/lib/appreciation";
import { classifyHolding, type AssetClass } from "@/lib/asset-classes";
import { loadCloses, loadInvestmentHistory } from "@/lib/investment-history";
import { marketToday } from "@/lib/pnl-history";
import type { ReadOptions } from "@/lib/provider-cache";

export const RETURN_RANGES = ["1M", "3M", "YTD", "1Y", "3Y", "All"] as const;

export type ReturnRange = (typeof RETURN_RANGES)[number];

export type ClassReturn = {
  id: AssetClass;
  gain: number;
  // Fraction, or null when nothing in the class could be valued.
  rate: number | null;
};

export type ReturnsData = {
  range: ReturnRange;
  // The close the period is measured from, and today.
  start: string;
  end: string;
  gain: number;
  rate: number | null;
  // Holding classes with something valued, in ASSET_CLASSES order (cash
  // is reported separately).
  classes: ClassReturn[];
  // Interest paid on uninvested brokerage cash during the period.
  cashInterest: number;
  // Positions that couldn't be valued (no market prices or history).
  missing: number;
  // History starts after `start` for some accounts.
  partial: boolean;
  issues: string[];
};

const DAY_MS = 86_400_000;

function shiftMonths(date: string, months: number): string {
  const day = new Date(`${date}T00:00:00Z`);
  day.setUTCMonth(day.getUTCMonth() - months);
  return day.toISOString().slice(0, 10);
}

function daysBefore(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) - days * DAY_MS).toISOString().slice(0, 10);
}

function rangeStart(range: ReturnRange, today: string, earliest: string): string {
  switch (range) {
    case "1M":
      return shiftMonths(today, 1);
    case "3M":
      return shiftMonths(today, 3);
    case "YTD":
      return `${Number(today.slice(0, 4)) - 1}-12-31`;
    case "1Y":
      return shiftMonths(today, 12);
    case "3Y":
      return shiftMonths(today, 36);
    case "All":
      // The day before the oldest transaction history.
      return daysBefore(earliest, 1);
  }
}

// What the portfolio's holdings gained over the range, overall and by asset
// class, including dividends.
export async function loadReturns(userId: string, range: ReturnRange, options: ReadOptions = {}): Promise<ReturnsData> {
  const issues: string[] = [];
  const today = marketToday();
  const { history, positions, securities } = await loadInvestmentHistory(userId, issues, options);
  const earliest = [...history.historyStarts.values()].sort()[0] ?? today;
  const start = rangeStart(range, today, earliest);
  // A couple of weeks earlier, so the opening close is found across holidays.
  const closes = await loadCloses(positions, daysBefore(start, 15), today);
  const result = holdingReturns(
    { positions, activities: history.activities, historyStarts: history.historyStarts, closes, today },
    start,
  );

  const byClass = new Map<AssetClass, HoldingReturn[]>();

  for (const holding of result.holdings) {
    const security = securities.get(holding.key) ?? {
      ticker: tickerFromKey(holding.key),
      name: holding.key,
      // Sold out of since: a ticker not on the fund list is most likely a stock.
      securityType: "equity",
    };
    const { mix } = classifyHolding(security);

    for (const [id, share] of Object.entries(mix) as [AssetClass, number][]) {
      const list = byClass.get(id) ?? [];
      list.push({
        key: holding.key,
        gain: holding.gain * share,
        startValue: holding.startValue * share,
        invested: holding.invested * share,
      });
      byClass.set(id, list);
    }
  }

  const cashInterest = history.cash
    .filter((activity) => activity.type === "interest" && activity.symbol === null && activity.date > start)
    .reduce((sum, activity) => sum + activity.amount, 0);

  return {
    range,
    start,
    end: today,
    gain: result.holdings.reduce((sum, holding) => sum + holding.gain, 0),
    rate: returnRate(result.holdings),
    classes: (["us", "intl", "bonds", "other"] as const)
      .filter((id) => byClass.has(id))
      .map((id) => ({
        id,
        gain: byClass.get(id)!.reduce((sum, holding) => sum + holding.gain, 0),
        rate: returnRate(byClass.get(id)!),
      })),
    cashInterest,
    missing: result.missing,
    partial: result.partial,
    issues,
  };
}
