import { NextResponse, type NextRequest } from "next/server";

import { errorResponse, requireSessionUser } from "@/lib/session";
import { loadStocks } from "@/lib/stocks";

export async function GET(request: NextRequest) {
  const user = await requireSessionUser(request);

  if (user instanceof NextResponse) {
    return user;
  }

  try {
    const stocks = await loadStocks(user.id);
    return NextResponse.json(stocks, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return errorResponse("Holdings couldn't be loaded. Try again.", 503);
  }
}
