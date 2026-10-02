import "server-only";

import { getDailyCloses, type DailyClose } from "@/lib/alpaca";
import { positionsWithHistory, type AppreciationPosition } from "@/lib/appreciation";
import { liveTicker } from "@/lib/live-valuation";
import { cachedRead, type ProviderCache, type ReadOptions } from "@/lib/provider-cache";
import { loadActivityHistory, loadLinkedPortfolio, loadLivePrices } from "@/lib/portfolio-data";

const PRICE_CACHE_MS = 6 * 60 * 60_000;

// Past closes change only once a day, so they're cached per server instance.
const priceCache: ProviderCache<Map<string, DailyClose[]>> = new Map();

export type InvestmentHistory = Awaited<ReturnType<typeof loadInvestmentHistory>>;

// Every position held now or in the brokerage transaction history, valued at
// live prices where available, with that history and what each holding is.
export async function loadInvestmentHistory(userId: string, issues: string[], options: ReadOptions) {
  const portfolio = await loadLinkedPortfolio(userId, issues);
  const [prices, history] = await Promise.all([
    loadLivePrices(portfolio.holdings, issues),
    loadActivityHistory(userId, portfolio.sources, issues, options),
  ]);

  const byLot = new Map<string, AppreciationPosition>();
  // Name and security type by holding key, for sorting into asset classes.
  const securities = new Map<string, { ticker: string | null; name: string; securityType: string | null }>();

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
    securities.set(holding.key, {
      ticker: holding.ticker ?? null,
      name: holding.name,
      securityType: holding.securityType ?? null,
    });
  }

  return {
    portfolio,
    history,
    positions: positionsWithHistory([...byLot.values()], history.activities),
    securities,
  };
}

// Daily closes for the positions' tickers from `start` to `today`. Throws
// when they can't be loaded.
export async function loadCloses(
  positions: AppreciationPosition[],
  start: string,
  today: string,
): Promise<Map<string, DailyClose[]>> {
  const symbols = [...new Set(positions.flatMap((position) => position.ticker ?? []))].sort();

  if (symbols.length === 0) {
    return new Map();
  }

  return cachedRead(priceCache, `${start}:${symbols.join(",")}`, PRICE_CACHE_MS, () =>
    getDailyCloses(symbols, start, today),
  );
}
