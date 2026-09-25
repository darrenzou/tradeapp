import "server-only";

export type StockQuote = {
  price: number;
  previousClose: number | null;
  asOf: string;
};

const ALPACA_DATA_URL = "https://data.alpaca.markets/v2/stocks/snapshots";
// The free Alpaca plan includes real-time prices from the IEX exchange only;
// full-market SIP prices need a paid market data subscription.
const ALPACA_FEED = "iex";
const MAX_SYMBOLS_PER_REQUEST = 100;
const MAX_INVALID_SYMBOL_RETRIES = 5;

type Snapshot = {
  latestTrade?: { p?: number; t?: string } | null;
  prevDailyBar?: { c?: number } | null;
} | null;

function isFinitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

// Alpaca rejects the whole request when any symbol is malformed, so drop the
// symbol it names and retry rather than losing every quote.
async function fetchSnapshots(
  symbols: string[],
  keyId: string,
  secretKey: string,
): Promise<Record<string, Snapshot>> {
  let remaining = symbols;

  for (let attempt = 0; attempt <= MAX_INVALID_SYMBOL_RETRIES && remaining.length > 0; attempt += 1) {
    const url = new URL(ALPACA_DATA_URL);
    url.searchParams.set("symbols", remaining.join(","));
    url.searchParams.set("feed", ALPACA_FEED);

    const response = await fetch(url, {
      headers: { "APCA-API-KEY-ID": keyId, "APCA-API-SECRET-KEY": secretKey },
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });

    if (response.ok) {
      return (await response.json()) as Record<string, Snapshot>;
    }

    const body = (await response.json().catch(() => null)) as { message?: unknown } | null;
    const invalid =
      response.status === 400 && typeof body?.message === "string"
        ? /invalid symbol: (\S+)/.exec(body.message)?.[1]
        : undefined;

    if (invalid === undefined || !remaining.includes(invalid)) {
      throw new Error(`Alpaca snapshots request failed with ${response.status}`);
    }

    remaining = remaining.filter((symbol) => symbol !== invalid);
  }

  if (remaining.length > 0) {
    throw new Error("Alpaca rejected too many symbols");
  }

  return {};
}

export async function getLatestStockQuotes(
  symbols: string[],
): Promise<Map<string, StockQuote>> {
  const keyId = process.env.ALPACA_KEY;
  const secretKey = process.env.ALPACA_SECRET;

  if (!keyId || !secretKey) {
    throw new Error("ALPACA_KEY and ALPACA_SECRET must be configured");
  }

  const unique = [...new Set(symbols)];
  const quotes = new Map<string, StockQuote>();

  for (let start = 0; start < unique.length; start += MAX_SYMBOLS_PER_REQUEST) {
    const snapshots = await fetchSnapshots(
      unique.slice(start, start + MAX_SYMBOLS_PER_REQUEST),
      keyId,
      secretKey,
    );

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
