import "server-only";

import { extendedHoursQuote, isRegularHours, type Quote, type Snapshot } from "./live-valuation";

export type StockQuote = Quote;

const ALPACA_DATA_URL = "https://data.alpaca.markets/v2/stocks/snapshots";
const ALPACA_BARS_URL = "https://data.alpaca.markets/v2/stocks/bars";
// The free Alpaca plan includes real-time prices from the IEX exchange only;
// full-market SIP prices need a paid market data subscription.
const ALPACA_FEED = "iex";
// IEX trades only 8:00-9:30 and 16:00-17:00 outside regular hours, so
// pre-market and after-hours prices come from the free 15-minute delayed
// full-market feed, which covers 4:00-20:00 New York time.
const EXTENDED_HOURS_FEED = "delayed_sip";
const MAX_SYMBOLS_PER_REQUEST = 100;
const MAX_INVALID_SYMBOL_RETRIES = 5;

function isFinitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

// Alpaca rejects the whole request when any symbol is malformed, so drop the
// symbol it names and retry rather than losing every other symbol's data.
async function fetchWithSymbolRetry<T>(
  symbols: string[],
  buildUrl: (symbols: string[]) => URL,
  keyId: string,
  secretKey: string,
): Promise<T | null> {
  let remaining = symbols;

  for (let attempt = 0; attempt <= MAX_INVALID_SYMBOL_RETRIES && remaining.length > 0; attempt += 1) {
    const response = await fetch(buildUrl(remaining), {
      headers: { "APCA-API-KEY-ID": keyId, "APCA-API-SECRET-KEY": secretKey },
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });

    if (response.ok) {
      return (await response.json()) as T;
    }

    const body = (await response.json().catch(() => null)) as { message?: unknown } | null;
    const invalid =
      response.status === 400 && typeof body?.message === "string"
        ? /invalid symbol: (\S+)/.exec(body.message)?.[1]
        : undefined;

    if (invalid === undefined || !remaining.includes(invalid)) {
      throw new Error(`Alpaca request failed with ${response.status}`);
    }

    remaining = remaining.filter((symbol) => symbol !== invalid);
  }

  if (remaining.length > 0) {
    throw new Error("Alpaca rejected too many symbols");
  }

  return null;
}

async function fetchSnapshots(
  symbols: string[],
  keyId: string,
  secretKey: string,
  feed: string,
): Promise<Record<string, Snapshot>> {
  const snapshots = await fetchWithSymbolRetry<Record<string, Snapshot>>(
    symbols,
    (remaining) => {
      const url = new URL(ALPACA_DATA_URL);
      url.searchParams.set("symbols", remaining.join(","));
      url.searchParams.set("feed", feed);
      return url;
    },
    keyId,
    secretKey,
  );

  return snapshots ?? {};
}

function alpacaKeys(): { keyId: string; secretKey: string } {
  const keyId = process.env.ALPACA_KEY;
  const secretKey = process.env.ALPACA_SECRET;

  if (!keyId || !secretKey) {
    throw new Error("ALPACA_KEY and ALPACA_SECRET must be configured");
  }

  return { keyId, secretKey };
}

export async function getLatestStockQuotes(
  symbols: string[],
  now = new Date(),
): Promise<Map<string, StockQuote>> {
  const { keyId, secretKey } = alpacaKeys();
  const unique = [...new Set(symbols)];
  const quotes = new Map<string, StockQuote>();
  const regular = isRegularHours(now);

  for (let start = 0; start < unique.length; start += MAX_SYMBOLS_PER_REQUEST) {
    const batch = unique.slice(start, start + MAX_SYMBOLS_PER_REQUEST);

    if (!regular) {
      // Falls back to IEX if the delayed feed is ever refused.
      const snapshots = await fetchSnapshots(batch, keyId, secretKey, EXTENDED_HOURS_FEED).catch(() =>
        fetchSnapshots(batch, keyId, secretKey, ALPACA_FEED),
      );

      for (const [symbol, snapshot] of Object.entries(snapshots)) {
        const quote = extendedHoursQuote(snapshot, now);
        if (quote !== null) {
          quotes.set(symbol, quote);
        }
      }
      continue;
    }

    const snapshots = await fetchSnapshots(batch, keyId, secretKey, ALPACA_FEED);

    for (const [symbol, snapshot] of Object.entries(snapshots)) {
      const price = snapshot?.latestTrade?.p;
      const asOf = snapshot?.latestTrade?.t;
      const previousClose = snapshot?.prevDailyBar?.c;

      if (isFinitePositive(price) && typeof asOf === "string") {
        quotes.set(symbol, {
          price,
          previousClose: isFinitePositive(previousClose) ? previousClose : null,
          asOf,
        });
      }
    }
  }

  return quotes;
}

// A daily closing price. Prices are as traded that day, not adjusted for
// later splits, to match the share counts in transaction history.
export type DailyClose = { date: string; close: number };

type BarsPage = {
  bars?: Record<string, { t?: string; c?: number }[] | null> | null;
  next_page_token?: string | null;
};

const MAX_BAR_PAGES = 50;

// Daily closes for each symbol between two YYYY-MM-DD dates, oldest first.
// Symbols Alpaca doesn't recognize are left out. "all" adjusts past closes
// for splits and dividends, so they move like a fund that reinvests them.
export async function getDailyCloses(
  symbols: string[],
  start: string,
  end: string,
  adjustment: "raw" | "all" = "raw",
): Promise<Map<string, DailyClose[]>> {
  const { keyId, secretKey } = alpacaKeys();
  const unique = [...new Set(symbols)];
  const closes = new Map<string, DailyClose[]>();

  for (let offset = 0; offset < unique.length; offset += MAX_SYMBOLS_PER_REQUEST) {
    let pageToken: string | null = null;
    let batch = unique.slice(offset, offset + MAX_SYMBOLS_PER_REQUEST);

    for (let page = 0; page < MAX_BAR_PAGES; page += 1) {
      const token = pageToken;
      let requested = batch;
      const body: BarsPage | null = await fetchWithSymbolRetry<BarsPage>(
        batch,
        (remaining) => {
          requested = remaining;
          const url = new URL(ALPACA_BARS_URL);
          url.searchParams.set("symbols", remaining.join(","));
          url.searchParams.set("timeframe", "1Day");
          url.searchParams.set("start", start);
          url.searchParams.set("end", end);
          url.searchParams.set("adjustment", adjustment);
          url.searchParams.set("feed", ALPACA_FEED);
          url.searchParams.set("limit", "10000");
          if (token !== null) {
            url.searchParams.set("page_token", token);
          }
          return url;
        },
        keyId,
        secretKey,
      );
      // Keep dropped symbols out of later pages.
      batch = requested;

      for (const [symbol, bars] of Object.entries(body?.bars ?? {})) {
        const list = closes.get(symbol) ?? [];

        for (const bar of bars ?? []) {
          if (typeof bar.t === "string" && isFinitePositive(bar.c)) {
            list.push({ date: bar.t.slice(0, 10), close: bar.c });
          }
        }
        closes.set(symbol, list);
      }

      pageToken = body?.next_page_token ?? null;

      if (pageToken === null) {
        break;
      }
    }
  }

  for (const list of closes.values()) {
    list.sort((a, b) => a.date.localeCompare(b.date));
  }

  return closes;
}
