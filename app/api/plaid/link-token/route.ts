import { NextResponse, type NextRequest } from "next/server";

import { checkConnectPasscode } from "@/lib/connect-passcode";
import { createFinancialAccountLinkToken } from "@/lib/plaid";
import { isSameOrigin } from "@/lib/request";
import { errorResponse, requireSessionUser } from "@/lib/session";

export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) {
    return errorResponse("Request not allowed.", 403);
  }

  const user = await requireSessionUser(request);

  if (user instanceof NextResponse) {
    return user;
  }

  // Linking a bank adds a Plaid Item, which costs money and uses up the
  // plan's limited Items.
  const refused = await checkConnectPasscode(request, "plaid");

  if (refused !== null) {
    return refused;
  }

  try {
    const linkToken = await createFinancialAccountLinkToken(user.id);
    return NextResponse.json({ linkToken }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return errorResponse("Bank connection is unavailable.", 503);
  }
}
