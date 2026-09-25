import "server-only";

import { createHmac } from "node:crypto";
import { createClient, type Session } from "@supabase/supabase-js";
import type { NextRequest, NextResponse } from "next/server";

export const SESSION_COOKIE_NAME = "tradeapp_session";
const SESSION_COOKIE_MAX_AGE = 2_592_000;
const MAX_SESSION_COOKIE_LENGTH = 3_800;
const USERNAME_PATTERN = /^[A-Za-z0-9_]{3,32}$/;
const USERNAME_MAPPING_SECRET_MIN_LENGTH = 32;
const INTERNAL_EMAIL_DOMAIN = "users.tradeapp.invalid";

export interface StoredSession {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  remember: boolean;
}

type CookieRecord = Record<string, unknown>;

function isCookieRecord(value: unknown): value is CookieRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isValidExpiry(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isHttpsRequest(request: NextRequest): boolean {
  return new URL(request.url).protocol === "https:";
}

function encodeSession(value: StoredSession): string {
  return Buffer.from(
    JSON.stringify({
      access_token: value.accessToken,
      refresh_token: value.refreshToken,
      expires_at: value.expiresAt,
      remember: value.remember,
    }),
    "utf8",
  ).toString("base64url");
}

function decodeSession(value: string): StoredSession | null {
  if (
    value.length === 0 ||
    value.length > MAX_SESSION_COOKIE_LENGTH ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    );

    if (!isCookieRecord(parsed)) {
      return null;
    }

    const accessToken = parsed.access_token;
    const refreshToken = parsed.refresh_token;
    const expiresAt = parsed.expires_at;
    const remember = parsed.remember;

    if (
      !isNonEmptyString(accessToken) ||
      !isNonEmptyString(refreshToken) ||
      !isValidExpiry(expiresAt) ||
      typeof remember !== "boolean"
    ) {
      return null;
    }

    return { accessToken, refreshToken, expiresAt, remember };
  } catch {
    return null;
  }
}

export function normalizeUsername(value: unknown): string | null {
  if (typeof value !== "string" || !USERNAME_PATTERN.test(value)) {
    return null;
  }

  return value.toLowerCase();
}

export function tradeappAppMetadata(normalizedUsername: string): {
  tradeapp_account: "v1";
  tradeapp_username: string;
} {
  return {
    tradeapp_account: "v1",
    tradeapp_username: normalizedUsername,
  };
}

export function hasTradeappAppMetadata(
  value: unknown,
  normalizedUsername: string,
): boolean {
  if (!isCookieRecord(value)) {
    return false;
  }

  return (
    value.tradeapp_account === "v1" &&
    value.tradeapp_username === normalizedUsername
  );
}

function getUsernameMappingSecret(): string | null {
  const secret = process.env.AUTH_USERNAME_MAPPING_SECRET;

  return typeof secret === "string" &&
    secret.length >= USERNAME_MAPPING_SECRET_MIN_LENGTH
    ? secret
    : null;
}

export function isUsernameMappingConfigured(): boolean {
  return getUsernameMappingSecret() !== null;
}

function deriveAliasForUsername(normalized: string, secret: string): string {
  const digest = createHmac("sha256", secret)
    .update(normalized, "utf8")
    .digest("hex");

  return `${normalized}.${digest}@${INTERNAL_EMAIL_DOMAIN}`;
}

export function aliasForUsername(normalized: string): string {
  const secret = getUsernameMappingSecret();

  if (secret === null) {
    throw new Error(
      "AUTH_USERNAME_MAPPING_SECRET must be configured with at least 32 characters",
    );
  }

  return deriveAliasForUsername(normalized, secret);
}

export function usernameFromEmail(email: string | undefined): string | null {
  if (email === undefined) {
    return null;
  }

  const match = /^([a-z0-9_]{3,32})\.([a-f0-9]{64})@users\.tradeapp\.invalid$/.exec(
    email,
  );
  const normalized = normalizeUsername(match?.[1]);

  if (normalized === null) {
    return null;
  }

  const secret = getUsernameMappingSecret();

  if (secret === null) {
    return null;
  }

  if (deriveAliasForUsername(normalized, secret) !== email) {
    return null;
  }

  return normalized;
}

export function createAuthClient() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey =
    process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseKey) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY or SUPABASE_ANON_KEY must be configured",
    );
  }

  return createClient(supabaseUrl, supabaseKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });
}

export function createAdminClient() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be configured",
    );
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });
}

export function readSessionCookie(request: NextRequest): StoredSession | null {
  const cookie = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  return cookie === undefined ? null : decodeSession(cookie);
}

export function writeSessionCookie(
  response: NextResponse,
  request: NextRequest,
  providerSession: Session,
  remember: boolean,
): void {
  if (
    !isNonEmptyString(providerSession.access_token) ||
    !isNonEmptyString(providerSession.refresh_token) ||
    !isValidExpiry(providerSession.expires_at)
  ) {
    throw new Error("Provider session is missing a token or expiry");
  }

  const value = encodeSession({
    accessToken: providerSession.access_token,
    refreshToken: providerSession.refresh_token,
    expiresAt: providerSession.expires_at,
    remember,
  });

  if (value.length > MAX_SESSION_COOKIE_LENGTH) {
    throw new Error("Encoded session cookie exceeds the maximum length");
  }

  response.cookies.set(SESSION_COOKIE_NAME, value, {
    httpOnly: true,
    sameSite: "strict",
    path: "/",
    secure: isHttpsRequest(request),
    ...(remember ? { maxAge: SESSION_COOKIE_MAX_AGE } : {}),
  });
}

export function clearSessionCookie(
  response: NextResponse,
  request: NextRequest,
): void {
  response.cookies.set(SESSION_COOKIE_NAME, "", {
    httpOnly: true,
    sameSite: "strict",
    path: "/",
    secure: isHttpsRequest(request),
    maxAge: 0,
  });
}
