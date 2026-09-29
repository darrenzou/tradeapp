import { NextResponse, type NextRequest } from "next/server";

import { errorResponse, requireSessionUser } from "@/lib/session";
import { loadSpendingMonth } from "@/lib/spending";

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export async function GET(request: NextRequest, { params }: { params: Promise<{ month: string }> }) {
  const user = await requireSessionUser(request);

  if (user instanceof NextResponse) {
    return user;
  }

  const { month } = await params;

  if (!MONTH_PATTERN.test(month)) {
    return errorResponse("That month isn't available.", 404);
  }

  try {
    const data = await loadSpendingMonth(user.id, month);

    if (data === null) {
      return errorResponse("That month is outside the last 3 years.", 404);
    }

    return NextResponse.json(data, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return errorResponse("Transactions couldn't be loaded. Try again.", 503);
  }
}
