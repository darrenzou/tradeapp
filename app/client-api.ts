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

export type AppPage = "overview" | "stocks";

const PAGE_PATHS: Record<AppPage, string> = { overview: "/", stocks: "/stocks" };
const LAST_PAGE_KEY = "tradeapp:lastPage";
// sessionStorage lasts until the app or tab is closed, which separates
// reopening the app from moving between pages while it is open.
const RESUMED_KEY = "tradeapp:resumed";

// Records the page being viewed. Viewing any page also counts as the app
// being open, so later visits to the overview are not redirected.
export function rememberPage(page: AppPage): void {
  try {
    window.localStorage.setItem(LAST_PAGE_KEY, page);
    window.sessionStorage.setItem(RESUMED_KEY, "1");
  } catch {
    // Storage can be unavailable (private browsing, blocked site data).
  }
}

// On the first sign-in or session restore since the app was opened, returns
// the path of the page the user last viewed if it isn't the overview.
export function takeResumePath(): string | null {
  try {
    if (window.sessionStorage.getItem(RESUMED_KEY) !== null) {
      return null;
    }

    window.sessionStorage.setItem(RESUMED_KEY, "1");
    const lastPage = window.localStorage.getItem(LAST_PAGE_KEY);

    return lastPage === "stocks" ? PAGE_PATHS[lastPage] : null;
  } catch {
    return null;
  }
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
