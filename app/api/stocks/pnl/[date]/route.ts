import { NextResponse, type NextRequest } from "next/server";

import { DayUnavailableError, loadHoldingsOnDay } from "@/lib/pnl-history";
import { errorResponse, requireSessionUser } from "@/lib/session";

const DATE_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

// The holdings as they stood at the close of one day, for a day tapped on
// the P&L calendar.
export async function GET(request: NextRequest, { params }: { params: Promise<{ date: string }> }) {
  const user = await requireSessionUser(request);

  if (user instanceof NextResponse) {
    return user;
  }

  const { date } = await params;

  if (!DATE_PATTERN.test(date)) {
    return errorResponse("That day isn't available.", 404);
  }

  try {
    const fresh = request.nextUrl.searchParams.get("fresh") === "1";
    const data = await loadHoldingsOnDay(user.id, date, { fresh });
    return NextResponse.json(data, { headers: { "Cache-Control": "private, max-age=900" } });
  } catch (error) {
    if (error instanceof DayUnavailableError) {
      return errorResponse(error.message, 404);
    }
    return errorResponse("That day's holdings couldn't be worked out. Try again.", 503);
  }
}
