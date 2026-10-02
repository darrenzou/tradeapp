import { NextResponse, type NextRequest } from "next/server";

import { getDailyCloses } from "@/lib/alpaca";
import { errorResponse, requireSessionUser } from "@/lib/session";

const SYMBOL_PATTERN = /^[A-Z0-9.-]{1,12}$/;

// How far back each chart range reaches, in days. "All" is five years.
const RANGE_DAYS: Record<string, number> = { "1W": 7, "1M": 31, "6M": 183, "1Y": 366, All: 5 * 366 };

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

// Daily closing prices for one symbol, for the holding page's chart.
export async function GET(request: NextRequest) {
  const user = await requireSessionUser(request);

  if (user instanceof NextResponse) {
    return user;
  }

  const symbol = request.nextUrl.searchParams.get("symbol")?.toUpperCase() ?? "";
  const range = request.nextUrl.searchParams.get("range") ?? "1Y";
  const days = RANGE_DAYS[range];

  if (!SYMBOL_PATTERN.test(symbol) || days === undefined) {
    return errorResponse("That chart isn't available.", 400);
  }

  try {
    const closes = (await getDailyCloses([symbol], daysAgo(days), daysAgo(0))).get(symbol) ?? [];
    return NextResponse.json(
      { symbol, range, closes },
      // Closes only change once a day.
      { headers: { "Cache-Control": "private, max-age=900" } },
    );
  } catch {
    return errorResponse("Price history couldn't be loaded. Try again.", 503);
  }
}
