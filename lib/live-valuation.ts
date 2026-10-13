export type Holding = {
  accountId: string;
  ticker: string | null;
  securityType: string | null;
  quantity: number;
  // Value as last reported by the institution (usually the prior close).
  institutionValue: number | null;
};

export type Quote = {
  price: number;
  previousClose: number | null;
  asOf: string;
  // Latest pre-market or after-hours trade, when one came after the regular close.
  extendedPrice?: number | null;
};

export type LiveAdjustment = {
  // Add to the institution-reported account balance to get the live value.
  delta: number;
  // Change since the previous close across the live-priced holdings.
  dayChange: number;
  // Pre-market or after-hours change since the regular close.
  extendedChange: number;
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
      extendedChange: 0,
      pricedHoldings: 0,
      asOf: quote.asOf,
    };

    current.delta += holding.quantity * quote.price - holding.institutionValue;
    if (quote.previousClose !== null) {
      current.dayChange += holding.quantity * (quote.price - quote.previousClose);
    }
    if (quote.extendedPrice != null) {
      current.extendedChange += holding.quantity * (quote.extendedPrice - quote.price);
    }
    current.pricedHoldings += 1;
    if (quote.asOf > current.asOf) {
      current.asOf = quote.asOf;
    }

    adjustments.set(holding.accountId, current);
  }

  return adjustments;
}

type SnapshotBar = { t?: string; c?: number } | null;

export type Snapshot = {
  latestTrade?: { p?: number; t?: string } | null;
  dailyBar?: SnapshotBar;
  prevDailyBar?: SnapshotBar;
} | null;

const PRE_MARKET_MINUTES = 4 * 60;
const OPEN_MINUTES = 9 * 60 + 30;
const CLOSE_MINUTES = 16 * 60;
const NEW_YORK = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  weekday: "short",
});

function newYork(time: Date): { date: string; minutes: number; weekend: boolean } {
  const parts = Object.fromEntries(NEW_YORK.formatToParts(time).map((part) => [part.type, part.value]));

  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
    weekend: parts.weekday === "Sat" || parts.weekday === "Sun",
  };
}

// Regular hours, plus the 15 minutes the delayed full-market feed takes to
// report the closing price.
// shortcut: market holidays count as regular hours, so they keep the old
// live pricing; check Alpaca's calendar if that ever matters.
export function isRegularHours(now: Date): boolean {
  const { minutes, weekend } = newYork(now);
  return !weekend && minutes >= OPEN_MINUTES && minutes < CLOSE_MINUTES + 15;
}

export function extendedSessionLabel(now: Date): "Pre-market" | "After hours" {
  const { minutes, weekend } = newYork(now);
  return !weekend && minutes >= PRE_MARKET_MINUTES && minutes < OPEN_MINUTES ? "Pre-market" : "After hours";
}

function isPositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

// Outside regular hours the day's change stops at the regular close, and a
// later trade becomes the separate pre-market or after-hours price.
export function extendedHoursQuote(snapshot: Snapshot, now: Date): Quote | null {
  let close = snapshot?.dailyBar;
  let previous = snapshot?.prevDailyBar;
  const today = newYork(now);

  // Before the open, a bar dated today holds only pre-market trades.
  if (typeof close?.t === "string" && newYork(new Date(close.t)).date === today.date && today.minutes < OPEN_MINUTES) {
    close = previous;
    previous = null;
  }

  if (!isPositive(close?.c) || typeof close.t !== "string") {
    return null;
  }

  const trade = snapshot?.latestTrade;
  const closeDate = newYork(new Date(close.t)).date;
  const tradeTime = typeof trade?.t === "string" ? newYork(new Date(trade.t)) : null;
  const afterClose =
    tradeTime !== null &&
    (tradeTime.date > closeDate || (tradeTime.date === closeDate && tradeTime.minutes >= CLOSE_MINUTES));

  return {
    price: close.c,
    previousClose: isPositive(previous?.c) ? previous.c : null,
    asOf: trade?.t ?? close.t,
    extendedPrice: afterClose && isPositive(trade?.p) ? trade.p : null,
  };
}
