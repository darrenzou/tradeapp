import "server-only";

import type { AllocationTargets } from "@/lib/allocation-targets";
import { buildStocksSummary, type StocksSummary } from "@/lib/portfolio";
import {
  loadActivityHistory,
  loadLinkedPortfolio,
  loadLivePrices,
} from "@/lib/portfolio-data";
import type { ReadOptions } from "@/lib/provider-cache";
import { summarizeContributions, type RetirementContributions } from "@/lib/retirement-contributions";
import { loadAllocationTargets } from "@/lib/user-settings-store";

export type StocksData = StocksSummary & {
  pricesAsOf: string | null;
  hasAccounts: boolean;
  // From Set targets; null until the user sets them.
  targets: AllocationTargets | null;
  // This calendar year's money into 401(k) and Roth IRA accounts. Missing
  // from copies saved before it existed.
  contributions?: RetirementContributions;
  issues: string[];
};

export async function loadStocks(userId: string, options: ReadOptions = {}): Promise<StocksData> {
  const issues: string[] = [];
  const [portfolio, targets] = await Promise.all([
    loadLinkedPortfolio(userId, issues),
    loadAllocationTargets(userId, issues),
  ]);
  const [prices, history] = await Promise.all([
    loadLivePrices(portfolio.holdings, issues),
    loadActivityHistory(userId, portfolio.sources, issues, options),
  ]);
  const today = new Date().toISOString().slice(0, 10);

  return {
    ...buildStocksSummary({
      accounts: portfolio.accounts,
      holdings: portfolio.holdings,
      holdingsLoaded: portfolio.holdingsLoaded,
      quotes: prices.quotes,
      activities: history.activities,
      historyStarts: history.historyStarts,
      today,
    }),
    contributions: summarizeContributions(
      portfolio.accounts,
      [...history.cash.filter((entry) => entry.type === "contribution"), ...history.fundContributions],
      Number(today.slice(0, 4)),
      new Set(history.historyStarts.keys()),
    ),
    pricesAsOf: prices.pricesAsOf,
    hasAccounts: portfolio.accounts.length > 0,
    targets,
    issues,
  };
}
