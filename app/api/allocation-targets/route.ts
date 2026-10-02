import { NextResponse, type NextRequest } from "next/server";

import { parseAllocationTargets } from "@/lib/allocation-targets";
import { saveAllocationTargets } from "@/lib/user-settings-store";
import { isJsonContentType, isSameOrigin } from "@/lib/request";
import { errorResponse, requireSessionUser } from "@/lib/session";

// Saves the allocation targets from Set targets, replacing the previous ones.
export async function PUT(request: NextRequest) {
  if (!isSameOrigin(request)) {
    return errorResponse("Request not allowed.", 403);
  }

  const user = await requireSessionUser(request);

  if (user instanceof NextResponse) {
    return user;
  }

  let targets = null;

  if (isJsonContentType(request)) {
    try {
      targets = parseAllocationTargets(await request.json());
    } catch {
      targets = null;
    }
  }

  if (targets === null) {
    return errorResponse("Targets must be whole percents adding up to 100.", 400);
  }

  try {
    await saveAllocationTargets(user.id, targets);
  } catch {
    return errorResponse("Your changes couldn't be saved. Try again.", 503);
  }

  return NextResponse.json({ targets }, { headers: { "Cache-Control": "no-store" } });
}
