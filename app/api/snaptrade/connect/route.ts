import { NextResponse, type NextRequest } from "next/server";

import {
  getSnapTradeCredentials,
  saveSnapTradeCredentials,
} from "@/lib/linked-accounts";
import { isSameOrigin } from "@/lib/request";
import { errorResponse, requireSessionUser } from "@/lib/session";
import {
  createBrokerageConnectionUrl,
  registerSnapTradeUser,
} from "@/lib/snaptrade";

// Returns a SnapTrade Connection Portal URL, registering the user with
// SnapTrade on their first connection.
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) {
    return errorResponse("Request not allowed.", 403);
  }

  const user = await requireSessionUser(request);

  if (user instanceof NextResponse) {
    return user;
  }

  try {
    let credentials = await getSnapTradeCredentials(user.id);

    if (credentials === null) {
      const registered = await registerSnapTradeUser(user.id);

      if (!registered.userId || !registered.userSecret) {
        return errorResponse("Brokerage connection is unavailable.", 503);
      }

      credentials = { userId: registered.userId, userSecret: registered.userSecret };
      await saveSnapTradeCredentials(user.id, credentials);
    }

    // isSameOrigin guarantees the Origin header is this app's origin.
    const redirectUrl = `${request.headers.get("origin")}/?connected=brokerage`;
    const url = await createBrokerageConnectionUrl(credentials, redirectUrl);

    return NextResponse.json({ url }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return errorResponse("Brokerage connection is unavailable.", 503);
  }
}
