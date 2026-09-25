import { NextResponse, type NextRequest } from "next/server";

import { loadDashboard } from "@/lib/dashboard";
import { errorResponse, requireSessionUser } from "@/lib/session";

export async function GET(request: NextRequest) {
  const user = await requireSessionUser(request);

  if (user instanceof NextResponse) {
    return user;
  }

  try {
    const dashboard = await loadDashboard(user.id);
    return NextResponse.json(dashboard, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return errorResponse("Accounts couldn't be loaded. Try again.", 503);
  }
}
