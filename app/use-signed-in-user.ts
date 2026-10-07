"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { isRecord, readJson } from "./client-api";
import { clearAppCache, getCachedUsername, restoreOfflineSession, setSessionUser } from "./client-cache";

// The signed-in user for a page other than the overview (sign-in) page, and
// its sign-out handlers. Without a session the user is sent to sign in.
export function useSignedInUser() {
  const router = useRouter();
  // Arriving from another page while signed in, the cache already knows the
  // user, so the page shows at once without a session check.
  const [username, setUsername] = useState<string | null>(getCachedUsername);
  const [isSigningOut, setIsSigningOut] = useState(false);

  const returnToSignIn = useCallback(() => router.replace("/"), [router]);
  const onSessionExpired = useCallback(() => {
    clearAppCache();
    returnToSignIn();
  }, [returnToSignIn]);

  useEffect(() => {
    let cancelled = false;

    if (getCachedUsername() !== null) {
      return;
    }

    async function restoreSession() {
      try {
        const response = await fetch("/api/auth", { credentials: "same-origin", cache: "no-store" });
        const body = await readJson(response);

        if (cancelled) {
          return;
        }

        if (response.ok && isRecord(body) && body.authenticated === true && typeof body.username === "string") {
          await setSessionUser(body.username, body.remember === true);

          if (!cancelled) {
            setUsername(body.username);
          }
        } else {
          returnToSignIn();
        }
      } catch {
        // No connection: show the data saved on this device, if any.
        const savedUsername = await restoreOfflineSession();

        if (cancelled) {
          return;
        }

        if (savedUsername !== null) {
          setUsername(savedUsername);
        } else {
          returnToSignIn();
        }
      }
    }

    void restoreSession();

    return () => {
      cancelled = true;
    };
  }, [returnToSignIn]);

  async function signOut() {
    setIsSigningOut(true);
    clearAppCache();

    try {
      await fetch("/api/auth", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "logout" }),
      });
    } finally {
      returnToSignIn();
    }
  }

  return { username, isSigningOut, onSignOut: () => void signOut(), onSessionExpired };
}
