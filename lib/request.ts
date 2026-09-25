import "server-only";

import type { NextRequest } from "next/server";

export function isSameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");

  if (origin === null || origin === "null") {
    return false;
  }

  let originOrigin: string;

  try {
    const parsedOrigin = new URL(origin);

    if (origin !== parsedOrigin.origin) {
      return false;
    }

    originOrigin = parsedOrigin.origin;
  } catch {
    return false;
  }

  try {
    if (originOrigin === new URL(request.url).origin) {
      return true;
    }
  } catch {
    return false;
  }

  const host = request.headers.get("host");

  if (host === null || host.length === 0) {
    return false;
  }

  if (
    host.includes("/") ||
    host.includes("?") ||
    host.includes("#") ||
    host.includes("@") ||
    host.includes("\\") ||
    host.includes(" ") ||
    host.includes("\t") ||
    host.includes("\n")
  ) {
    return false;
  }

  let scheme: string;
  const forwardedProto = request.headers
    .get("x-forwarded-proto")
    ?.split(",", 1)[0]
    ?.trim()
    .toLowerCase();

  if (forwardedProto === "http" || forwardedProto === "https") {
    scheme = `${forwardedProto}:`;
  } else {
    try {
      scheme = new URL(request.url).protocol;
    } catch {
      return false;
    }
  }

  try {
    const hostOrigin = new URL(`${scheme}//${host}`).origin;
    return originOrigin === hostOrigin;
  } catch {
    return false;
  }
}

export function isJsonContentType(request: NextRequest): boolean {
  const contentType = request.headers.get("content-type");

  if (contentType === null) {
    return false;
  }

  return contentType.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}
