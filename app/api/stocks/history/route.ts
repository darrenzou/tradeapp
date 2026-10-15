import { NextResponse, type NextRequest } from "next/server";

import { getDailyCloses, getIntradayPrices, type DailyClose } from "@/lib/alpaca";
import { indexProxy, proxyCloses, proxyParts } from "@/lib/fund-proxies";
import { liveTicker } from "@/lib/live-valuation";
import { errorResponse, requireSessionUser } from "@/lib/session";

const SYMBOL_PATTERN = /^[A-Z0-9.-]{1,12}$/;
const MAX_NAME_LENGTH = 200;

// How far back each chart range reaches, in days. "All" is five years.
// "1D" is the last trading day in 5-minute steps instead.
const RANGE_DAYS: Record<string, number> = { "1D": 1, "1W": 7, "1M": 31, "6M": 183, "1Y": 366, All: 5 * 366 };

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

// Daily closing prices for one symbol, for the holding page's chart. Funds
// and Treasuries without market prices of their own (named by `name` and
// `type`) get the moves of the ETFs that price them instead, listed in
// `estimatedFrom`, for the page to scale to the holding's price.
export async function GET(request: NextRequest) {
  const user = await requireSessionUser(request);

  if (user instanceof NextResponse) {
    return user;
  }

  const params = request.nextUrl.searchParams;
  const symbol = params.get("symbol")?.toUpperCase() ?? "";
  const security = {
    ticker: symbol || null,
    name: (params.get("name") ?? "").slice(0, MAX_NAME_LENGTH),
    securityType: params.get("type"),
  };
  const range = params.get("range") ?? "1Y";
  const days = RANGE_DAYS[range];
  const proxy = liveTicker(security) === null ? indexProxy(security) : null;

  if ((proxy === null && !SYMBOL_PATTERN.test(symbol)) || days === undefined) {
    return errorResponse("That chart isn't available.", 400);
  }

  const year = new Date().getUTCFullYear();
  const etfs = proxy === null ? null : proxyParts(proxy, year).map((part) => part.symbol);
  const symbols = etfs ?? [symbol];

  try {
    const series: Map<string, DailyClose[]> =
      range === "1D"
        ? new Map(await Promise.all(symbols.map(async (item) => [item, await getIntradayPrices(item)] as const)))
        : await getDailyCloses(symbols, daysAgo(days), daysAgo(0), "split");
    const closes = proxy === null ? (series.get(symbol) ?? []) : (proxyCloses([proxy], series, year).get(proxy) ?? []);

    return NextResponse.json(
      { symbol, range, closes, ...(etfs && { estimatedFrom: etfs }) },
      // 1D moves every few minutes; closes only change once a day.
      { headers: { "Cache-Control": `private, max-age=${range === "1D" ? 60 : 900}` } },
    );
  } catch {
    return errorResponse("Price history couldn't be loaded. Try again.", 503);
  }
}
