"use client";

import { useCallback } from "react";

export const LIVE_REFRESH_MS = 60_000;

const currencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

export function formatMoney(value: number, currency = "USD"): string {
  if (currency === "USD") {
    return currencyFormatter.format(value);
  }

  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency}`;
  }
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function errorMessage(body: unknown, fallback: string): string {
  return isRecord(body) && typeof body.error === "string" ? body.error : fallback;
}

export async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

// Calls an API route, refreshing the session once through /api/auth when
// the access token has expired. Resolves to null when the session is gone.
export function useApiFetch(onSessionExpired: () => void) {
  return useCallback(
    async (input: string, init?: RequestInit): Promise<Response | null> => {
      const request = () =>
        fetch(input, { credentials: "same-origin", cache: "no-store", ...init });
      const response = await request();

      if (response.status !== 401) {
        return response;
      }

      const refresh = await fetch("/api/auth", { credentials: "same-origin", cache: "no-store" });
      const session = await readJson(refresh);

      if (!refresh.ok || !isRecord(session) || session.authenticated !== true) {
        onSessionExpired();
        return null;
      }

      const retried = await request();

      if (retried.status === 401) {
        onSessionExpired();
        return null;
      }

      return retried;
    },
    [onSessionExpired],
  );
}

// Runs load now, then every minute while the page is visible and again when
// the user returns to the tab.
export function subscribeToLiveRefresh(load: () => Promise<void>): () => void {
  async function loadInitial() {
    await load();
  }

  void loadInitial();

  const interval = window.setInterval(() => {
    if (document.visibilityState === "visible") {
      void load();
    }
  }, LIVE_REFRESH_MS);
  const refreshOnReturn = () => {
    if (document.visibilityState === "visible") {
      void load();
    }
  };
  document.addEventListener("visibilitychange", refreshOnReturn);

  return () => {
    window.clearInterval(interval);
    document.removeEventListener("visibilitychange", refreshOnReturn);
  };
}
