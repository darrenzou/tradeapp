"use client";

import { useSyncExternalStore } from "react";

import { errorMessage, isRecord, readJson } from "./client-api";

// In-memory cache of the signed-in user and each page's last data, so moving
// between pages shows the last numbers at once while a fresh copy loads in
// the background (stale-while-revalidate).
//
// Financial data is kept only in this module's memory: never in
// localStorage, sessionStorage, or IndexedDB, so it is gone when the app or
// tab closes or reloads. clearAppCache() wipes it on sign-out and when the
// session ends.

export type CachedResource = "dashboard" | "stocks" | "spending";

export type CacheEntry<T> = { data: T; fetchedAt: number };

type RefreshState = {
  // Show an "Updating…" hint: the cached data being refreshed is old enough
  // that the user may notice numbers changing.
  visible: boolean;
};

type CacheState = {
  username: string | null;
  entries: Partial<Record<CachedResource, CacheEntry<unknown>>>;
  refreshing: Partial<Record<CachedResource, RefreshState>>;
};

export type ApiFetcher = (url: string) => Promise<Response | null>;

const EMPTY_STATE: CacheState = { username: null, entries: {}, refreshing: {} };
// A refresh of data younger than this is silent.
const VISIBLE_REFRESH_AFTER_MS = 30_000;

const RESOURCE_URLS: Record<CachedResource, string> = {
  dashboard: "/api/dashboard",
  stocks: "/api/stocks",
  spending: "/api/spending",
};

const LOAD_FAILED: Record<CachedResource, string> = {
  dashboard: "Accounts couldn't be loaded. Try again.",
  stocks: "Holdings couldn't be loaded. Try again.",
  spending: "Spending couldn't be loaded. Try again.",
};

let state: CacheState = EMPTY_STATE;
// Bumped on clear, so responses to requests made before sign-out are dropped.
let generation = 0;
let nextRequestId = 0;
const listeners = new Set<() => void>();
const inflight = new Map<CachedResource, { id: number; promise: Promise<void> }>();

function update(next: (current: CacheState) => CacheState): void {
  state = next(state);
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function setRefreshing(key: CachedResource, value: RefreshState | undefined): void {
  update((current) => {
    const refreshing = { ...current.refreshing };

    if (value === undefined) {
      delete refreshing[key];
    } else {
      refreshing[key] = value;
    }

    return { ...current, refreshing };
  });
}

export function getCachedUsername(): string | null {
  return state.username;
}

// Records who is signed in. A different user starts from an empty cache.
export function setSessionUser(username: string): void {
  if (state.username !== null && state.username !== username) {
    clearAppCache();
  }

  update((current) => ({ ...current, username }));
}

// Forgets the user and all cached data; in-flight responses are discarded.
export function clearAppCache(): void {
  generation += 1;
  inflight.clear();
  update(() => EMPTY_STATE);
}

export class ResourceLoadError extends Error {}

// Loads fresh data for a page into the cache. Concurrent calls share one
// request; `force` starts a new one (e.g. after connecting an account), and
// only the most recently started request may update the cache. Rejects with
// ResourceLoadError when the request fails; resolves without data when the
// session has ended (the fetcher handles that).
export function refreshResource(
  key: CachedResource,
  fetcher: ApiFetcher,
  { force = false }: { force?: boolean } = {},
): Promise<void> {
  const existing = inflight.get(key);

  if (existing !== undefined && !force) {
    return existing.promise;
  }

  const requestGeneration = generation;
  const id = ++nextRequestId;
  const cached = state.entries[key];
  const isCurrent = () => requestGeneration === generation && inflight.get(key)?.id === id;

  setRefreshing(key, {
    visible: cached !== undefined && Date.now() - cached.fetchedAt > VISIBLE_REFRESH_AFTER_MS,
  });

  const promise = (async () => {
    try {
      const response = await fetcher(RESOURCE_URLS[key]);

      if (response === null || !isCurrent()) {
        return;
      }

      const body = await readJson(response);

      if (!isCurrent()) {
        return;
      }

      if (!response.ok || !isRecord(body)) {
        throw new ResourceLoadError(errorMessage(body, LOAD_FAILED[key]));
      }

      update((current) => ({
        ...current,
        entries: { ...current.entries, [key]: { data: body, fetchedAt: Date.now() } },
      }));
    } catch (error) {
      if (!isCurrent()) {
        return;
      }

      throw error instanceof ResourceLoadError ? error : new ResourceLoadError(LOAD_FAILED[key]);
    } finally {
      if (isCurrent()) {
        inflight.delete(key);
        setRefreshing(key, undefined);
      }
    }
  })();

  inflight.set(key, { id, promise });
  return promise;
}

// Loads a page's data in the background if it isn't cached yet, so the first
// visit to that page is instant too. Failures are left for the page to retry.
export function prefetchResource(key: CachedResource, fetcher: ApiFetcher): void {
  if (state.entries[key] === undefined && !inflight.has(key)) {
    refreshResource(key, fetcher).catch(() => undefined);
  }
}

function useCacheState(): CacheState {
  // The server render always starts empty; the cache only fills in the browser.
  return useSyncExternalStore(subscribe, () => state, () => EMPTY_STATE);
}

export function useCachedResource<T>(key: CachedResource): {
  entry: CacheEntry<T> | undefined;
  isRefreshing: boolean;
  showUpdating: boolean;
} {
  const current = useCacheState();
  const refreshing = current.refreshing[key];

  return {
    entry: current.entries[key] as CacheEntry<T> | undefined,
    isRefreshing: refreshing !== undefined,
    showUpdating: refreshing?.visible === true,
  };
}
