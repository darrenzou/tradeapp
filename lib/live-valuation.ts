export type Holding = {
  accountId: string;
  ticker: string | null;
  securityType: string | null;
  quantity: number;
  // Value as last reported by the institution (usually the prior close).
  institutionValue: number | null;
};

export type Quote = { price: number; previousClose: number | null; asOf: string };

export type LiveAdjustment = {
  // Add to the institution-reported account balance to get the live value.
  delta: number;
  // Change since the previous close across the live-priced holdings.
  dayChange: number;
  pricedHoldings: number;
  asOf: string;
};

// Security types Alpaca's stock data covers. Mutual funds, bonds, options,
// crypto, and cash keep the institution's last reported value.
const LIVE_PRICED_TYPES = new Set(["equity", "etf"]);
// US listings: 1–5 letters, optionally a share class such as BRK.B. Plaid can
// return CUSIP-like identifiers in the ticker field, which Alpaca rejects.
const TICKER_PATTERN = /^[A-Z]{1,5}(\.[A-Z]{1,2})?$/;

export function liveTicker(holding: Holding): string | null {
  const ticker = holding.ticker?.trim().toUpperCase() ?? null;

  if (
    ticker === null ||
    !TICKER_PATTERN.test(ticker) ||
    !LIVE_PRICED_TYPES.has(holding.securityType ?? "")
  ) {
    return null;
  }

  return ticker;
}

// Reprices stock and ETF holdings with live quotes. Returning a delta rather
// than a new total keeps anything the institution counts in the balance but
// not in holdings, such as uninvested cash.
export function liveAdjustments(
  holdings: Holding[],
  quotes: Map<string, Quote>,
): Map<string, LiveAdjustment> {
  const adjustments = new Map<string, LiveAdjustment>();

  for (const holding of holdings) {
    const ticker = liveTicker(holding);
    const quote = ticker === null ? undefined : quotes.get(ticker);

    if (quote === undefined || holding.institutionValue === null || !Number.isFinite(holding.quantity)) {
      continue;
    }

    const current = adjustments.get(holding.accountId) ?? {
      delta: 0,
      dayChange: 0,
      pricedHoldings: 0,
      asOf: quote.asOf,
    };

    current.delta += holding.quantity * quote.price - holding.institutionValue;
    if (quote.previousClose !== null) {
      current.dayChange += holding.quantity * (quote.price - quote.previousClose);
    }
    current.pricedHoldings += 1;
    if (quote.asOf > current.asOf) {
      current.asOf = quote.asOf;
    }

    adjustments.set(holding.accountId, current);
  }

  return adjustments;
}
