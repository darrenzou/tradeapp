// Funds without market prices of their own (401(k) trust funds, mutual
// funds) that track an index an ETF also tracks are priced by that ETF's
// daily moves: its closes, adjusted for dividends since such funds reinvest
// them, scaled so the latest matches the fund's reported price. Only the
// day-to-day moves come from the ETF, so they're estimates. Pure, so it runs
// in scripts and tests.

import type { DailyClose } from "./alpaca";
import type { AppreciationPosition } from "./appreciation";

export type Security = { ticker: string | null; name: string; securityType: string | null };

// Mutual fund tickers of S&P 500 index funds, for funds reported by ticker.
const SP500_TICKERS = new Set([
  "FXAIX",
  "FUSEX",
  "FUSVX",
  "VFIAX",
  "VFINX",
  "SWPPX",
  "PREIX",
  "SNXFX",
  "USSPX",
  "WFSPX",
  "BSPAX",
  "BSPIX",
  "MDSRX",
]);
// "S&P 500 Index Fund", "BlackRock S&P500 Index Non-Lendable Fund M",
// "SP 500 Index"; not "Russell 2500".
const SP500_NAME = /\bS\s*&\s*P\s*500\b|\bSP\s?500\b|\bS&P500\b/i;
// Funds named after the S&P 500 that don't move with it.
const NOT_THE_INDEX =
  /equal|growth|value|\bex[-\s]|completion|extended|leverag|inverse|ultra|short|bear|\b[23]x\b|esg|dividend|low vol|momentum|quality|covered|buffer|enhanced|sector/i;

export const SP500_SYMBOL = "SPY";

// The ETF whose daily moves price a fund, or null when it tracks none we know.
export function indexProxy(security: Security): string | null {
  const ticker = security.ticker?.trim().toUpperCase() ?? "";

  if (SP500_TICKERS.has(ticker)) {
    return SP500_SYMBOL;
  }

  return SP500_NAME.test(security.name) && !NOT_THE_INDEX.test(security.name) ? SP500_SYMBOL : null;
}

// The price series name for a fund priced by an index, distinct from any
// ticker.
export function proxySeries(key: string): string {
  return `~${key}`;
}

// The ETF tracking each unpriced position's index, by holding key.
export function fundIndexes(
  positions: AppreciationPosition[],
  securities: Map<string, Security>,
): Map<string, string> {
  const indexes = new Map<string, string>();

  for (const position of positions) {
    const security = securities.get(position.key);
    const symbol = position.ticker === null && security ? indexProxy(security) : null;

    if (symbol !== null) {
      indexes.set(position.key, symbol);
    }
  }

  return indexes;
}

// The last close before `date`.
function closeBefore(closes: DailyClose[], date: string): number | null {
  let found: number | null = null;

  for (const close of closes) {
    if (close.date >= date) {
      break;
    }
    found = close.close;
  }

  return found;
}

// Prices the funds in `indexes` from their index's closes: each gets a
// series of the index's closes scaled so the close before `today` (when the
// fund's reported price is from) matches that price. Positions priced this
// way get the series as their ticker. Funds with no shares held now have no
// price to scale to, so they stay unpriced.
export function priceFundsByIndex(
  positions: AppreciationPosition[],
  indexes: Map<string, string>,
  indexCloses: Map<string, DailyClose[]>,
  today: string,
): { positions: AppreciationPosition[]; closes: Map<string, DailyClose[]>; funds: Set<string> } {
  const closes = new Map<string, DailyClose[]>();
  const funds = new Set<string>();

  for (const position of positions) {
    const symbol = indexes.get(position.key);
    const series = symbol === undefined ? undefined : indexCloses.get(symbol);

    if (series === undefined || closes.has(proxySeries(position.key)) || position.quantity <= 0) {
      continue;
    }

    const indexPrice = closeBefore(series, today);
    const fundPrice = position.currentValue / position.quantity;

    if (indexPrice === null || !(fundPrice > 0)) {
      continue;
    }

    const scale = fundPrice / indexPrice;
    closes.set(
      proxySeries(position.key),
      series.map((close) => ({ date: close.date, close: close.close * scale })),
    );
    funds.add(position.key);
  }

  return {
    positions: positions.map((position) =>
      funds.has(position.key) ? { ...position, ticker: proxySeries(position.key) } : position,
    ),
    closes,
    funds,
  };
}
