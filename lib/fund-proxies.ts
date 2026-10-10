// Funds without market prices of their own (401(k) trust funds, mutual
// funds) that track an index an ETF also tracks (the S&P 500, the Dow, the
// Nasdaq, international, bonds...) are priced by that ETF's
// daily moves: its closes, adjusted for dividends since such funds reinvest
// them, scaled so the latest matches the fund's reported price. Only the
// day-to-day moves come from the ETF, so they're estimates. Pure, so it runs
// in scripts and tests.

import type { DailyClose } from "./alpaca";
import type { AppreciationPosition } from "./appreciation";

export type Security = { ticker: string | null; name: string; securityType: string | null };

// Indexes a fund can track, with an ETF that tracks the same one, most
// specific first ("S&P 500 Growth" before "S&P 500"). `name` matches the
// fund's name; `tickers` are index mutual funds reported by ticker. Names
// that aren't an index's own (e.g. "Emerging Markets") count only for a fund
// called an index fund, not an actively managed one.
type IndexProxy = { symbol: string; name: RegExp; generic?: boolean; tickers?: string[] };

const SP500 = String.raw`(?:S\s*&\s*P|\bSP)\s?500\b`;

const INDEX_PROXIES: IndexProxy[] = [
  // Bonds first: "Total International Bond Index" isn't a stock fund.
  { symbol: "BNDX", name: /international bond|bond.*\bex[-\s.]?u\.?s\b|global.*\bex[-\s.]?u\.?s\b.*bond/i, generic: true, tickers: ["VTABX"] },
  {
    symbol: "BND",
    name: /aggregate bond|\bagg(?:regate)?\b.*bond|total bond|bond market index|u\.?s\.? aggregate|bloomberg (?:u\.?s\.? )?agg/i,
    generic: true,
    tickers: ["VBTLX", "VBMFX", "VBTIX", "VBMPX", "FXNAX", "SWAGX", "FUAMX"],
  },
  // US stocks outside the S&P 500.
  { symbol: "VXF", name: new RegExp(`extended market|completion|ex[-\\s]?${SP500}`, "i"), tickers: ["VEXAX", "FSMAX"] },
  { symbol: "IVW", name: new RegExp(`${SP500}.*growth`, "i") },
  { symbol: "IVE", name: new RegExp(`${SP500}.*value`, "i") },
  {
    symbol: "SPY",
    // "Vanguard Institutional 500 Index Trust", "VANGUARD INSTL 500 INDEX TR".
    name: new RegExp(`${SP500}|\\b500 index\\b`, "i"),
    tickers: ["VINIX", "VIIIX", "FXAIX", "FUSEX", "FUSVX", "VFIAX", "VFINX", "SWPPX", "PREIX", "SNXFX", "USSPX", "WFSPX", "BSPAX", "BSPIX", "MDSRX"],
  },
  { symbol: "IJH", name: /mid\s?cap\s*400|s\s*&\s*p\s*400\b/i, tickers: ["FSMDX"] },
  { symbol: "IJR", name: /small\s?cap\s*600|s\s*&\s*p\s*600\b/i },
  { symbol: "IWF", name: /russell 1000 growth/i },
  { symbol: "IWD", name: /russell 1000 value/i },
  { symbol: "IWO", name: /russell 2000 growth/i },
  { symbol: "IWN", name: /russell 2000 value/i },
  { symbol: "IWB", name: /russell 1000\b/i, tickers: ["FLCPX"] },
  { symbol: "IWM", name: /russell 2000\b/i, tickers: ["FSSNX", "SWSSX"] },
  { symbol: "IWR", name: /russell mid\s?cap/i },
  { symbol: "QQQ", name: /nasdaq[-\s]?100/i },
  { symbol: "ONEQ", name: /nasdaq/i, tickers: ["FNCMX"] },
  { symbol: "VNQ", name: /\breit\b|real estate index/i, tickers: ["VGSLX", "FSRNX"] },
  // International before total market: "Total International Stock Index".
  {
    symbol: "VXUS",
    // Also as plans abbreviate it: "VANGUARD INSTL TTL INTL STOCK".
    name: /\b(?:total|ttl|tot)\s+int(?:ernationa)?l\b/i,
    // VGIST: Vanguard Institutional Total International Stock Market Index
    // Trust's code in 401(k) plans.
    tickers: ["VGIST", "VTIAX", "VGTSX", "VTSNX", "VTPSX", "FTIHX", "FZILX", "SWISX"],
  },
  { symbol: "VXUS", name: /\bex[-\s.]?u\.?s\.?a?\b|acwi ex/i, generic: true },
  { symbol: "EFA", name: /\beafe\b|developed (?:markets?|international)|international developed|ftse developed/i, tickers: ["FSPSX", "VTMGX"] },
  { symbol: "VWO", name: /emerging market/i, generic: true, tickers: ["VEMAX", "FPADX"] },
  {
    symbol: "VTI",
    name: /\b(?:total|ttl|tot) (?:u\.?s\.? )?(?:(?:stock|stk) )?(?:market|mkt)\b|russell 3000|wilshire 5000|crsp u\.?s\.? total|dow jones u\.?s\.? total/i,
    tickers: ["VTSAX", "VTSMX", "VITSX", "VITPX", "FSKAX", "FZROX", "SWTSX"],
  },
  { symbol: "DIA", name: /dow jones|\bdjia\b|\bdow 30\b/i },
];

// Funds named after an index that don't move with it.
const NOT_THE_INDEX =
  /equal|leverag|inverse|ultra|\bshort\b|bear|\b[23]x\b|esg|low vol|momentum|quality|covered|buffer|enhanced|sector|dividend|target|retirement 20|income/i;
const INDEX_FUND = /\bindex\b|\bidx\b|\bindx\b/i;

// The ETF whose daily moves price a fund, or null when it tracks none we know.
export function indexProxy(security: Security): string | null {
  const ticker = security.ticker?.trim().toUpperCase() ?? "";
  const byTicker = INDEX_PROXIES.find((proxy) => proxy.tickers?.includes(ticker));

  if (byTicker) {
    return byTicker.symbol;
  }

  if (NOT_THE_INDEX.test(security.name)) {
    return null;
  }

  const proxy = INDEX_PROXIES.find(
    (item) => item.name.test(security.name) && (!item.generic || INDEX_FUND.test(security.name)),
  );
  return proxy?.symbol ?? null;
}

// The price series name for a fund priced by an index, distinct from any
// ticker.
export function proxySeries(key: string): string {
  return `~${key}`;
}

// The ETF tracking each unpriced position's index, by holding key: those
// with no ticker, or a ticker `priced` has no closes for (a 401(k) fund code
// that looks like a ticker).
export function fundIndexes(
  positions: AppreciationPosition[],
  securities: Map<string, Security>,
  priced: Set<string>,
): Map<string, string> {
  const indexes = new Map<string, string>();

  for (const position of positions) {
    const security = securities.get(position.key);
    const unpriced = position.ticker === null || !priced.has(position.ticker);
    const symbol = unpriced && security ? indexProxy(security) : null;

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
