import { NextResponse, type NextRequest } from "next/server";

import { errorResponse, requireSessionUser } from "@/lib/session";
import { loadSpending } from "@/lib/spending";

export async function GET(request: NextRequest) {
  const user = await requireSessionUser(request);

  if (user instanceof NextResponse) {
    return user;
  }

  try {
    const spending = await loadSpending(user.id);
    return NextResponse.json(spending, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return errorResponse("Spending couldn't be loaded. Try again.", 503);
  }
}
