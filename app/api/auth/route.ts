import { createHash, timingSafeEqual } from "node:crypto";

import type { Session } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";

import {
  aliasForUsername,
  clearSessionCookie,
  createAdminClient,
  createAuthClient,
  hasTradeappAppMetadata,
  isUsernameMappingConfigured,
  normalizeUsername,
  readSessionCookie,
  SESSION_COOKIE_NAME,
  tradeappAppMetadata,
  usernameFromEmail,
  writeSessionCookie,
  type StoredSession,
} from "@/lib/auth";
import { isJsonContentType, isSameOrigin } from "@/lib/request";

const AUTH_INVITE_CODE_MIN_LENGTH = 16;
const PASSWORD_MIN_LENGTH = 12;
const PASSWORD_MAX_BYTES = 72;
const SESSION_REFRESH_WINDOW_SECONDS = 30;

const AUTHENTICATION_SERVICE_ERROR = "Authentication service unavailable.";
const INVALID_REQUEST_ERROR = "Invalid request.";
const REQUEST_NOT_ALLOWED_ERROR = "Request not allowed.";
const INVALID_CREDENTIALS_ERROR = "Invalid username or password.";
const ACCOUNT_CREATION_ERROR = "Unable to create account.";
const ACCOUNT_CREATION_UNAVAILABLE_ERROR = "Account creation is unavailable.";

type AuthAction = "create" | "login" | "logout";
type AuthBody = Record<string, unknown> & { action: AuthAction };
type CompleteProviderSession = Session & { expires_at: number };

type AuthResponseBody =
  | { authenticated: false }
  | { authenticated: true; username: string }
  | { message: "Account created. Sign in to continue." }
  | { error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAuthBody(value: unknown): value is AuthBody {
  if (!isRecord(value)) {
    return false;
  }

  const action = value.action;
  return action === "create" || action === "login" || action === "logout";
}

function response(
  body: AuthResponseBody,
  status = 200,
): NextResponse<AuthResponseBody> {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function hasSessionCookie(request: NextRequest): boolean {
  return request.cookies.get(SESSION_COOKIE_NAME) !== undefined;
}

function providerErrorStatus(error: unknown): number | undefined {
  if (!isRecord(error)) {
    return undefined;
  }

  const status = error.status;
  return typeof status === "number" ? status : undefined;
}

function isProviderUnavailable(error: unknown): boolean {
  const status = providerErrorStatus(error);

  return (
    status === undefined ||
    status <= 0 ||
    status === 429 ||
    status >= 500
  );
}

function isCompleteProviderSession(
  value: Session | null,
): value is CompleteProviderSession {
  return (
    value !== null &&
    typeof value.access_token === "string" &&
    value.access_token.length > 0 &&
    typeof value.refresh_token === "string" &&
    value.refresh_token.length > 0 &&
    typeof value.expires_at === "number" &&
    Number.isFinite(value.expires_at) &&
    value.expires_at > 0
  );
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function matchesInviteCode(supplied: string, configured: string): boolean {
  const suppliedDigest = sha256(supplied);
  const configuredDigest = sha256(configured);

  return timingSafeEqual(suppliedDigest, configuredDigest);
}

async function parseRequestBody(
  request: NextRequest,
): Promise<AuthBody | null> {
  if (!isJsonContentType(request)) {
    return null;
  }

  try {
    const value: unknown = await request.json();
    return isAuthBody(value) ? value : null;
  } catch {
    return null;
  }
}

function unauthenticatedResponse(
  responseToClear: NextResponse<AuthResponseBody>,
  request: NextRequest,
): NextResponse<AuthResponseBody> {
  clearSessionCookie(responseToClear, request);
  return responseToClear;
}

function serviceUnavailableResponse(): NextResponse<AuthResponseBody> {
  return response({ error: AUTHENTICATION_SERVICE_ERROR }, 503);
}

function serviceUnavailableWithRefreshedSession(
  request: NextRequest,
  refreshedSession: CompleteProviderSession | null,
  remember: boolean,
): NextResponse<AuthResponseBody> {
  const unavailable = serviceUnavailableResponse();

  if (refreshedSession === null) {
    return unavailable;
  }

  try {
    writeSessionCookie(unavailable, request, refreshedSession, remember);
  } catch {
    return serviceUnavailableResponse();
  }

  return unavailable;
}

export async function GET(
  request: NextRequest,
): Promise<NextResponse<AuthResponseBody>> {
  const sessionCookiePresent = hasSessionCookie(request);
  const storedSession = readSessionCookie(request);

  if (storedSession === null) {
    const unauthenticated = response({ authenticated: false });
    return sessionCookiePresent
      ? unauthenticatedResponse(unauthenticated, request)
      : unauthenticated;
  }

  if (!isUsernameMappingConfigured()) {
    return serviceUnavailableResponse();
  }

  let currentSession: StoredSession = storedSession;
  let refreshedSession: CompleteProviderSession | null = null;

  try {
    const authClient = createAuthClient();
    const now = Math.floor(Date.now() / 1000);

    if (
      currentSession.expiresAt - now <=
      SESSION_REFRESH_WINDOW_SECONDS
    ) {
      const refreshResult = await authClient.auth.refreshSession({
        refresh_token: currentSession.refreshToken,
      });

      if (refreshResult.error) {
        if (isProviderUnavailable(refreshResult.error)) {
          return serviceUnavailableResponse();
        }

        return unauthenticatedResponse(response({ authenticated: false }), request);
      }

      if (!isCompleteProviderSession(refreshResult.data.session)) {
        return unauthenticatedResponse(response({ authenticated: false }), request);
      }

      currentSession = {
        accessToken: refreshResult.data.session.access_token,
        refreshToken: refreshResult.data.session.refresh_token,
        expiresAt: refreshResult.data.session.expires_at,
        remember: storedSession.remember,
      };
      refreshedSession = refreshResult.data.session;
    }

    const userResult = await authClient.auth.getUser(currentSession.accessToken);

    if (userResult.error) {
      if (isProviderUnavailable(userResult.error)) {
        return serviceUnavailableWithRefreshedSession(request, refreshedSession, storedSession.remember);
      }

      return unauthenticatedResponse(response({ authenticated: false }), request);
    }

    const username = usernameFromEmail(userResult.data.user?.email);

    if (
      username === null ||
      !hasTradeappAppMetadata(userResult.data.user?.app_metadata, username)
    ) {
      return unauthenticatedResponse(response({ authenticated: false }), request);
    }

    const authenticated = response({ authenticated: true, username });

    if (refreshedSession !== null) {
      try {
        writeSessionCookie(
          authenticated,
          request,
          refreshedSession,
          storedSession.remember,
        );
      } catch {
        return serviceUnavailableResponse();
      }
    }

    return authenticated;
  } catch {
    return serviceUnavailableWithRefreshedSession(request, refreshedSession, storedSession.remember);
  }
}

export async function POST(
  request: NextRequest,
): Promise<NextResponse<AuthResponseBody>> {
  if (!isSameOrigin(request)) {
    return response({ error: REQUEST_NOT_ALLOWED_ERROR }, 403);
  }

  const body = await parseRequestBody(request);

  if (body === null) {
    return response({ error: INVALID_REQUEST_ERROR }, 400);
  }

  switch (body.action) {
    case "create":
      return createAccount(body);
    case "login":
      return login(body, request);
    case "logout":
      return logout(request);
    default: {
      const exhaustive: never = body.action;
      return response({ error: exhaustive }, 400);
    }
  }
}

async function createAccount(
  body: AuthBody,
): Promise<NextResponse<AuthResponseBody>> {
  const configuredInviteCode = process.env.AUTH_INVITE_CODE;

  if (
    typeof configuredInviteCode !== "string" ||
    configuredInviteCode.length < AUTH_INVITE_CODE_MIN_LENGTH
  ) {
    return response({ error: ACCOUNT_CREATION_UNAVAILABLE_ERROR }, 503);
  }

  const suppliedInviteCode = body.inviteCode;
  if (
    typeof suppliedInviteCode !== "string" ||
    !matchesInviteCode(suppliedInviteCode, configuredInviteCode)
  ) {
    return response({ error: ACCOUNT_CREATION_ERROR }, 400);
  }

  const normalizedUsername = normalizeBodyUsername(body.username);

  if (normalizedUsername === null) {
    return response({ error: ACCOUNT_CREATION_ERROR }, 400);
  }

  const password = body.password;
  const confirmPassword = body.confirmPassword;

  if (typeof password !== "string" || password.length < PASSWORD_MIN_LENGTH) {
    return response({ error: "Password must be at least 12 characters." }, 400);
  }

  if (Buffer.byteLength(password, "utf8") > PASSWORD_MAX_BYTES) {
    return response({ error: "Password must be at most 72 bytes." }, 400);
  }

  if (password !== confirmPassword) {
    return response({ error: "Passwords do not match." }, 400);
  }

  try {
    const adminClient = createAdminClient();
    const { error } = await adminClient.auth.admin.createUser({
      email: aliasForUsername(normalizedUsername),
      password,
      email_confirm: true,
      app_metadata: tradeappAppMetadata(normalizedUsername),
    });

    if (error) {
      if (isProviderUnavailable(error)) {
        return serviceUnavailableResponse();
      }

      return response({ error: ACCOUNT_CREATION_ERROR }, 400);
    }

    return response(
      { message: "Account created. Sign in to continue." },
      201,
    );
  } catch {
    return serviceUnavailableResponse();
  }
}

function normalizeBodyUsername(value: unknown): string | null {
  return normalizeUsername(typeof value === "string" ? value.trim() : value);
}

async function login(
  body: AuthBody,
  request: NextRequest,
): Promise<NextResponse<AuthResponseBody>> {
  const normalizedUsername = normalizeBodyUsername(body.username);
  const password = body.password;

  if (
    normalizedUsername === null ||
    typeof password !== "string" ||
    password.length === 0
  ) {
    return response({ error: INVALID_CREDENTIALS_ERROR }, 401);
  }

  try {
    const authClient = createAuthClient();
    const signInResult = await authClient.auth.signInWithPassword({
      email: aliasForUsername(normalizedUsername),
      password,
    });

    if (signInResult.error) {
      if (isProviderUnavailable(signInResult.error)) {
        return serviceUnavailableResponse();
      }

      return response({ error: INVALID_CREDENTIALS_ERROR }, 401);
    }

    if (
      !isCompleteProviderSession(signInResult.data.session) ||
      usernameFromEmail(signInResult.data.user?.email) !== normalizedUsername ||
      !hasTradeappAppMetadata(
        signInResult.data.user?.app_metadata,
        normalizedUsername,
      )
    ) {
      return response({ error: INVALID_CREDENTIALS_ERROR }, 401);
    }

    const authenticated = response({
      authenticated: true,
      username: normalizedUsername,
    });

    try {
      writeSessionCookie(
        authenticated,
        request,
        signInResult.data.session,
        body.remember === true,
      );
    } catch {
      return serviceUnavailableResponse();
    }

    return authenticated;
  } catch {
    return serviceUnavailableResponse();
  }
}

async function logout(
  request: NextRequest,
): Promise<NextResponse<AuthResponseBody>> {
  const storedSession = readSessionCookie(request);
  const loggedOut = response({ authenticated: false });

  if (storedSession === null) {
    return unauthenticatedResponse(loggedOut, request);
  }

  try {
    const authClient = createAuthClient();
    const sessionResult = await authClient.auth.setSession({
      access_token: storedSession.accessToken,
      refresh_token: storedSession.refreshToken,
    });

    if (sessionResult.error) {
      if (isProviderUnavailable(sessionResult.error)) {
        return unauthenticatedResponse(response({ authenticated: false }, 503), request);
      }

      return unauthenticatedResponse(loggedOut, request);
    }

    if (!isCompleteProviderSession(sessionResult.data.session)) {
      return unauthenticatedResponse(loggedOut, request);
    }

    const signOutResult = await authClient.auth.signOut({ scope: "local" });

    if (signOutResult.error) {
      if (isProviderUnavailable(signOutResult.error)) {
        return unauthenticatedResponse(response({ authenticated: false }, 503), request);
      }

      return unauthenticatedResponse(loggedOut, request);
    }

    return unauthenticatedResponse(loggedOut, request);
  } catch {
    return unauthenticatedResponse(response({ authenticated: false }, 503), request);
  }
}
