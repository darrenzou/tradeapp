"use client";

import { useEffect, useState } from "react";

import { useApiFetch } from "../client-api";
import { refreshResource, useCachedResource } from "../client-cache";
import type { StocksData } from "@/lib/stocks";

// The Stocks data for pages under /stocks: the last loaded copy at once,
// refreshed in the background when the page opens.
export function useStocks(onSessionExpired: () => void) {
  const { entry, showUpdating } = useCachedResource<StocksData>("stocks");
  const [loadError, setLoadError] = useState("");
  const apiFetch = useApiFetch(onSessionExpired);

  useEffect(() => {
    refreshResource("stocks", apiFetch)
      .then(() => setLoadError(""))
      .catch((error) => setLoadError(error instanceof Error ? error.message : "Holdings couldn't be loaded. Try again."));
  }, [apiFetch]);

  return { entry, data: entry?.data ?? null, showUpdating, loadError, apiFetch };
}
