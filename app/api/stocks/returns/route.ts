import { NextResponse, type NextRequest } from "next/server";

import { RETURN_RANGES, loadReturns, type ReturnRange } from "@/lib/returns";
import { errorResponse, requireSessionUser } from "@/lib/session";

// What the holdings gained over a range (1M to All), for Risk & return.
export async function GET(request: NextRequest) {
  const user = await requireSessionUser(request);

  if (user instanceof NextResponse) {
    return user;
  }

  const range = request.nextUrl.searchParams.get("range") ?? "1Y";

  if (!(RETURN_RANGES as readonly string[]).includes(range)) {
    return errorResponse("That range isn't available.", 400);
  }

  try {
    const returns = await loadReturns(user.id, range as ReturnRange);
    return NextResponse.json(returns, { headers: { "Cache-Control": "private, max-age=900" } });
  } catch {
    return errorResponse("Your returns couldn't be worked out. Try again.", 503);
  }
}
