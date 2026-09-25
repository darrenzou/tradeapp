"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { isRecord, readJson } from "../client-api";
import StocksView from "./stocks-view";

export default function StocksPage() {
  const router = useRouter();
  const [username, setUsername] = useState<string | null>(null);
  const [isSigningOut, setIsSigningOut] = useState(false);

  const returnToSignIn = useCallback(() => router.replace("/"), [router]);

  useEffect(() => {
    let cancelled = false;

    async function restoreSession() {
      try {
        const response = await fetch("/api/auth", { credentials: "same-origin", cache: "no-store" });
        const body = await readJson(response);

        if (cancelled) {
          return;
        }

        if (response.ok && isRecord(body) && body.authenticated === true && typeof body.username === "string") {
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
    <StocksView
      username={username}
      isSigningOut={isSigningOut}
      onSignOut={() => void handleSignOut()}
      onSessionExpired={returnToSignIn}
    />
  );
}
