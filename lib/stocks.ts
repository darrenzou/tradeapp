import "server-only";

import { buildStocksSummary, type StocksSummary } from "@/lib/portfolio";
import {
  loadActivityHistory,
  loadLinkedPortfolio,
  loadLivePrices,
} from "@/lib/portfolio-data";
import type { ReadOptions } from "@/lib/provider-cache";

export type StocksData = StocksSummary & {
  pricesAsOf: string | null;
  hasAccounts: boolean;
  issues: string[];
};

export async function loadStocks(userId: string, options: ReadOptions = {}): Promise<StocksData> {
  const issues: string[] = [];
  const portfolio = await loadLinkedPortfolio(userId, issues);
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
    issues,
  };
}
