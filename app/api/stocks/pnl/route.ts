import { NextResponse, type NextRequest } from "next/server";

import { loadDailyPnl } from "@/lib/pnl-history";
import { errorResponse, requireSessionUser } from "@/lib/session";

// The portfolio's P&L on each market day, for the P&L calendar.
export async function GET(request: NextRequest) {
  const user = await requireSessionUser(request);

  if (user instanceof NextResponse) {
    return user;
  }

  try {
    // ?fresh=1 comes from the refresh button: re-read from Plaid and SnapTrade.
    const fresh = request.nextUrl.searchParams.get("fresh") === "1";
    const pnl = await loadDailyPnl(user.id, { fresh });
    return NextResponse.json(pnl, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return errorResponse("Your daily P&L couldn't be worked out. Try again.", 503);
  }
}
