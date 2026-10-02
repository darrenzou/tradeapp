import "server-only";

import type { AllocationTargets } from "@/lib/allocation-targets";
import { buildStocksSummary, type StocksSummary } from "@/lib/portfolio";
import {
  loadActivityHistory,
  loadLinkedPortfolio,
  loadLivePrices,
} from "@/lib/portfolio-data";
import type { ReadOptions } from "@/lib/provider-cache";
import { loadAllocationTargets } from "@/lib/user-settings-store";

export type StocksData = StocksSummary & {
  pricesAsOf: string | null;
  hasAccounts: boolean;
  // From Set targets; null until the user sets them.
  targets: AllocationTargets | null;
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

  return {
    ...buildStocksSummary({
      accounts: portfolio.accounts,
      holdings: portfolio.holdings,
      holdingsLoaded: portfolio.holdingsLoaded,
      quotes: prices.quotes,
      activities: history.activities,
      historyStarts: history.historyStarts,
      today: new Date().toISOString().slice(0, 10),
    }),
    pricesAsOf: prices.pricesAsOf,
    hasAccounts: portfolio.accounts.length > 0,
    targets,
    issues,
  };
}
