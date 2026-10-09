import { NextResponse, type NextRequest } from "next/server";

import { parseEmployerMatch } from "@/lib/retirement-contributions";
import { saveEmployerMatch } from "@/lib/user-settings-store";
import { isJsonContentType, isSameOrigin } from "@/lib/request";
import { errorResponse, requireSessionUser } from "@/lib/session";

const MAX_ACCOUNT_ID_LENGTH = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Sets a 401(k) account's employer match from its contributions sheet:
// { accountId, match: { salary, percent } }, or match: null to remove it.
export async function PUT(request: NextRequest) {
  if (!isSameOrigin(request)) {
    return errorResponse("Request not allowed.", 403);
  }

  const user = await requireSessionUser(request);

  if (user instanceof NextResponse) {
    return user;
  }

  let body: unknown = null;

  if (isJsonContentType(request)) {
    try {
      body = await request.json();
    } catch {
      body = null;
    }
  }

  const accountId = isRecord(body) ? body.accountId : undefined;
  const match = isRecord(body) && body.match !== null ? parseEmployerMatch(body.match) : null;

  if (
    !isRecord(body) ||
    typeof accountId !== "string" ||
    accountId.length === 0 ||
    accountId.length > MAX_ACCOUNT_ID_LENGTH ||
    (body.match !== null && match === null)
  ) {
    return errorResponse("Enter your salary and the match percent.", 400);
  }

  try {
    const matches = await saveEmployerMatch(user.id, accountId, match);
    return NextResponse.json({ matches }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return errorResponse("Your match couldn't be saved. Try again.", 503);
  }
}
