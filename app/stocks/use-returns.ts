"use client";

import { useEffect, useState } from "react";

import { errorMessage, isRecord, readJson, useApiFetch } from "../client-api";
import type { ReturnRange, ReturnsData } from "@/lib/returns";

// Returns already loaded this visit, by range.
const returnsCache = new Map<ReturnRange, ReturnsData>();

// What the holdings gained over `range`, loaded when first asked for.
export function useReturns(range: ReturnRange, apiFetch: ReturnType<typeof useApiFetch>) {
  const [loaded, setLoaded] = useState<{ range: ReturnRange; data: ReturnsData | null; error: string } | null>(null);
  const cached = returnsCache.get(range) ?? null;

  useEffect(() => {
    if (returnsCache.has(range)) {
      return;
    }

    let cancelled = false;

    async function load() {
      try {
        const response = await apiFetch(`/api/stocks/returns?range=${range}`);

        if (response === null || cancelled) {
          return;
        }

        const body = await readJson(response);

        if (!response.ok || !isRecord(body) || !Array.isArray(body.classes)) {
          setLoaded({ range, data: null, error: errorMessage(body, "Your returns couldn't be worked out.") });
          return;
        }

        returnsCache.set(range, body as ReturnsData);
        setLoaded({ range, data: body as ReturnsData, error: "" });
      } catch {
        if (!cancelled) {
          setLoaded({ range, data: null, error: "Your returns couldn't be worked out." });
        }
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, [apiFetch, range]);

  return {
    returns: cached ?? (loaded?.range === range ? loaded.data : null),
    error: loaded?.range === range ? loaded.error : "",
  };
}
