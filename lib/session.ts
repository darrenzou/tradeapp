import "server-only";

import { NextResponse, type NextRequest } from "next/server";

import {
  createAuthClient,
  hasTradeappAppMetadata,
  isUsernameMappingConfigured,
  readSessionCookie,
  usernameFromEmail,
} from "@/lib/auth";

export type SessionUser = { id: string; username: string };

// Resolves the signed-in user for API routes other than /api/auth. It never
// refreshes the session: an expired access token yields 401, and the client
// refreshes through GET /api/auth before retrying.
export async function requireSessionUser(
  request: NextRequest,
): Promise<SessionUser | NextResponse<{ error: string }>> {
  const session = readSessionCookie(request);

  if (session === null || session.expiresAt <= Math.floor(Date.now() / 1000)) {
    return errorResponse("Not signed in.", 401);
  }

  if (!isUsernameMappingConfigured()) {
    return errorResponse("Service unavailable.", 503);
  }

  try {
    const { data, error } = await createAuthClient().auth.getUser(
      session.accessToken,
    );

    if (error || !data.user) {
      return errorResponse("Not signed in.", 401);
    }

    const username = usernameFromEmail(data.user.email);

    if (
      username === null ||
      !hasTradeappAppMetadata(data.user.app_metadata, username)
    ) {
      return errorResponse("Not signed in.", 401);
    }

    return { id: data.user.id, username };
  } catch {
    return errorResponse("Service unavailable.", 503);
  }
}

export function errorResponse(
  error: string,
  status: number,
): NextResponse<{ error: string }> {
  return NextResponse.json(
    { error },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}
