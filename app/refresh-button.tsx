"use client";

import { useEffect, useState } from "react";

import { FRESH_REUSE_MS } from "@/lib/provider-cache";

import { useApiFetch } from "./client-api";
import { refreshResource, type CachedResource } from "./client-cache";

// Pages re-read on every refresh. A month page adds its own month.
const REFRESHED_PAGES: CachedResource[] = ["dashboard", "stocks", "spending"];
// Matches the server, which reuses anything read this recently instead of
// asking Plaid and SnapTrade again.
const COOLDOWN_MS = FRESH_REUSE_MS;
const TOAST_MS = 3_000;

// Kept outside the component so moving between pages mid-refresh or during
// the wait doesn't allow a second refresh.
let lastRefreshAt = 0;
let inflight: Promise<boolean> | null = null;

type Status = "idle" | "refreshing" | "cooling";

function currentStatus(): Status {
  if (inflight !== null) {
    return "refreshing";
  }

  return Date.now() - lastRefreshAt < COOLDOWN_MS ? "cooling" : "idle";
}

// Resolves to whether every page reloaded.
function refreshAll(apiFetch: ReturnType<typeof useApiFetch>, keys: CachedResource[]): Promise<boolean> {
  inflight ??= Promise.allSettled(keys.map((key) => refreshResource(key, apiFetch, { force: true, fresh: true })))
    .then((results) => results.every((result) => result.status === "fulfilled"))
    .finally(() => {
      lastRefreshAt = Date.now();
      inflight = null;
    });

  return inflight;
}

function resultMessage(allRefreshed: boolean): string {
  if (allRefreshed) {
    return "All accounts refreshed.";
  }

  return navigator.onLine
    ? "Some accounts couldn't be refreshed. Showing the last data."
    : "You're offline. Showing the last data.";
}

// Re-reads every connected account from Plaid and SnapTrade. It only reads
// what the providers already hold: it never calls their paid on-demand
// refresh endpoints (Plaid /transactions/refresh and /investments/refresh,
// SnapTrade's connection refresh), so it can't add fees.
export default function RefreshButton({
  alsoRefresh,
  onSessionExpired,
}: {
  alsoRefresh?: CachedResource;
  onSessionExpired: () => void;
}) {
  const apiFetch = useApiFetch(onSessionExpired);
  const [status, setStatus] = useState<Status>(currentStatus);
  const [toast, setToast] = useState("");

  // A refresh started on another page finishes here.
  useEffect(() => {
    let active = true;

    inflight?.then((allRefreshed) => {
      if (active) {
        setStatus("cooling");
        setToast(resultMessage(allRefreshed));
      }
    });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (status !== "cooling") {
      return;
    }

    const timer = window.setTimeout(() => setStatus("idle"), Math.max(0, lastRefreshAt + COOLDOWN_MS - Date.now()));
    return () => window.clearTimeout(timer);
  }, [status]);

  useEffect(() => {
    if (!toast) {
      return;
    }

    const timer = window.setTimeout(() => setToast(""), TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [toast]);

  async function refresh() {
    setStatus("refreshing");
    setToast("");

    const allRefreshed = await refreshAll(
      apiFetch,
      alsoRefresh === undefined ? REFRESHED_PAGES : [...REFRESHED_PAGES, alsoRefresh],
    );

    setStatus("cooling");
    setToast(resultMessage(allRefreshed));
  }

  const label =
    status === "refreshing"
      ? "Refreshing all accounts"
      : status === "cooling"
        ? "Refreshed. You can refresh again in a minute."
        : "Refresh all accounts";

  return (
    <>
      <button
        type="button"
        className={status === "refreshing" ? "dash-icon-button dash-refresh-spinning" : "dash-icon-button"}
        onClick={() => void refresh()}
        disabled={status !== "idle"}
        aria-label={label}
        title={label}
      >
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <path
            d="M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      <p className={toast ? "dash-toast dash-toast-visible" : "dash-toast"} role="status" aria-live="polite">
        {toast}
      </p>
    </>
  );
}
