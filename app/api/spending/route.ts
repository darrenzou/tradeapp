import { NextResponse, type NextRequest } from "next/server";

import { errorResponse, requireSessionUser } from "@/lib/session";
import { loadSpending } from "@/lib/spending";

export async function GET(request: NextRequest) {
  const user = await requireSessionUser(request);

  if (user instanceof NextResponse) {
    return user;
  }

  try {
    // ?fresh=1 comes from the refresh button: re-read from Plaid and SnapTrade.
    const fresh = request.nextUrl.searchParams.get("fresh") === "1";
    const spending = await loadSpending(user.id, { fresh });
    return NextResponse.json(spending, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return errorResponse("Spending couldn't be loaded. Try again.", 503);
  }
}
