import { NextResponse, type NextRequest } from "next/server";

import { parseOverviewSettings } from "@/lib/overview-settings";
import { saveOverviewSettings } from "@/lib/user-settings-store";
import { isJsonContentType, isSameOrigin } from "@/lib/request";
import { errorResponse, requireSessionUser } from "@/lib/session";

// Saves the Overview's Edit accounts choices, replacing the previous ones.
export async function PUT(request: NextRequest) {
  if (!isSameOrigin(request)) {
    return errorResponse("Request not allowed.", 403);
  }

  const user = await requireSessionUser(request);

  if (user instanceof NextResponse) {
    return user;
  }

  let settings = null;

  if (isJsonContentType(request)) {
    try {
      settings = parseOverviewSettings(await request.json());
    } catch {
      settings = null;
    }
  }

  if (settings === null) {
    return errorResponse("Those account settings aren't valid.", 400);
  }

  try {
    await saveOverviewSettings(user.id, settings);
  } catch {
    return errorResponse("Your changes couldn't be saved. Try again.", 503);
  }

  return NextResponse.json({ settings }, { headers: { "Cache-Control": "no-store" } });
}
