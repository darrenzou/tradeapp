import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

import { isJsonContentType } from "@/lib/request";
import { errorResponse } from "@/lib/session";

// Each new Plaid or SnapTrade connection costs money or uses up a plan's
// limited connections, so starting one asks for a passcode. The passcodes
// live only in these environment variables.
const PASSCODE_VARIABLES = {
  plaid: "PLAID_CONNECT_PASSCODE",
  snaptrade: "SNAPTRADE_CONNECT_PASSCODE",
} as const;

export type ConnectProvider = keyof typeof PASSCODE_VARIABLES;

// A wrong passcode waits before answering, so guesses come slowly.
const WRONG_PASSCODE_DELAY_MS = 1500;

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

// null when the request carries the right passcode for the provider;
// otherwise the response to send. With no passcode set up, connecting stays
// off rather than open.
export async function checkConnectPasscode(
  request: NextRequest,
  provider: ConnectProvider,
): Promise<NextResponse | null> {
  const expected = process.env[PASSCODE_VARIABLES[provider]]?.trim() ?? "";

  if (expected === "") {
    return errorResponse("Connecting is turned off until a passcode is set up.", 503);
  }

  let passcode = "";

  if (isJsonContentType(request)) {
    try {
      const body: unknown = await request.json();

      if (typeof body === "object" && body !== null && "passcode" in body && typeof body.passcode === "string") {
        passcode = body.passcode.trim();
      }
    } catch {
      passcode = "";
    }
  }

  if (passcode !== "" && timingSafeEqual(digest(passcode), digest(expected))) {
    return null;
  }

  await new Promise((resolve) => setTimeout(resolve, WRONG_PASSCODE_DELAY_MS));
  return errorResponse(passcode === "" ? "Enter the passcode." : "That passcode isn't right.", 403);
}
