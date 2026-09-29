"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { isRecord, readJson } from "../client-api";
import { clearAppCache, getCachedUsername, setSessionUser } from "../client-cache";
import SpendingView from "./spending-view";

export default function SpendingPage() {
  const router = useRouter();
  // Arriving from the overview while signed in, the cache already knows the
  // user, so the page shows at once without a session check.
  const [username, setUsername] = useState<string | null>(getCachedUsername);
  const [isSigningOut, setIsSigningOut] = useState(false);

  const returnToSignIn = useCallback(() => router.replace("/"), [router]);
  const handleSessionExpired = useCallback(() => {
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
          setSessionUser(body.username);
          setUsername(body.username);
        } else {
          returnToSignIn();
        }
      } catch {
        if (!cancelled) {
          returnToSignIn();
        }
      }
    }

    void restoreSession();

    return () => {
      cancelled = true;
    };
  }, [returnToSignIn]);

  async function handleSignOut() {
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

  if (username === null) {
    return (
      <main className="dash-page">
        <p className="stocks-loading" role="status">Loading…</p>
      </main>
    );
  }

  return (
    <SpendingView
      username={username}
      isSigningOut={isSigningOut}
      onSignOut={() => void handleSignOut()}
      onSessionExpired={handleSessionExpired}
    />
  );
}
