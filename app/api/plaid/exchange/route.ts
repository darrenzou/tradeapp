import { NextResponse, type NextRequest } from "next/server";

import { savePlaidItem } from "@/lib/linked-accounts";
import { exchangeFinancialAccountPublicToken } from "@/lib/plaid";
import { isJsonContentType, isSameOrigin } from "@/lib/request";
import { errorResponse, requireSessionUser } from "@/lib/session";

const MAX_INSTITUTION_NAME_LENGTH = 200;

type ExchangeBody = { publicToken: string; institutionName: string | null };

async function parseBody(request: NextRequest): Promise<ExchangeBody | null> {
  if (!isJsonContentType(request)) {
    return null;
  }

  let value: unknown;

  try {
    value = await request.json();
  } catch {
    return null;
  }

  if (typeof value !== "object" || value === null) {
    return null;
  }

  const { publicToken, institutionName } = value as Record<string, unknown>;

  if (typeof publicToken !== "string" || publicToken.length === 0) {
    return null;
  }

  return {
    publicToken,
    institutionName:
      typeof institutionName === "string" && institutionName.length > 0
        ? institutionName.slice(0, MAX_INSTITUTION_NAME_LENGTH)
        : null,
  };
}

// Exchanges the public token from Plaid Link for a long-lived access token
// and stores it server-side. The access token never reaches the browser.
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) {
    return errorResponse("Request not allowed.", 403);
  }

  const user = await requireSessionUser(request);

  if (user instanceof NextResponse) {
    return user;
  }

  const body = await parseBody(request);

  if (body === null) {
    return errorResponse("Invalid request.", 400);
  }

  try {
    const { access_token, item_id } = await exchangeFinancialAccountPublicToken(
      body.publicToken,
    );
    await savePlaidItem(user.id, {
      itemId: item_id,
      accessToken: access_token,
      institutionName: body.institutionName,
    });

    return NextResponse.json({ connected: true }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return errorResponse("Bank connection couldn't be saved. Try again.", 503);
  }
}
