"use client";

import { useSyncExternalStore } from "react";

import { errorMessage, isRecord, readJson } from "./client-api";
import { clearOfflineSnapshot, loadOfflineSnapshot, saveOfflineEntry } from "./offline-store";

// In-memory cache of the signed-in user and each page's last data, so moving
// between pages shows the last numbers at once while a fresh copy loads in
// the background (stale-while-revalidate).
//
// For sessions signed in with "Remember me", each page's last data is also
// saved on the device (offline-store.ts), so reopening the app shows it at
// once and it can be viewed offline. Without "Remember me" the data stays in
// this module's memory only and is gone when the app or tab closes.
// clearAppCache() wipes both on sign-out, when the session ends, and when a
// different user signs in.

// One month's transactions on the Spending page use `spending-month:YYYY-MM`.
export type CachedResource = "dashboard" | "stocks" | "spending" | `spending-month:${string}`;

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

const OFFLINE_MESSAGE = "You're offline, and this hasn't been saved on this device yet.";

const RESOURCE_URLS: Record<string, string> = {
  dashboard: "/api/dashboard",
  stocks: "/api/stocks",
  spending: "/api/spending",
};

const LOAD_FAILED: Record<string, string> = {
  dashboard: "Accounts couldn't be loaded. Try again.",
  stocks: "Holdings couldn't be loaded. Try again.",
  spending: "Spending couldn't be loaded. Try again.",
};

const MONTH_PREFIX = "spending-month:";

function resourceUrl(key: CachedResource): string {
  return key.startsWith(MONTH_PREFIX)
    ? `/api/spending/${encodeURIComponent(key.slice(MONTH_PREFIX.length))}`
    : RESOURCE_URLS[key];
}

function loadFailed(key: CachedResource): string {
  return LOAD_FAILED[key] ?? "Transactions couldn't be loaded. Try again.";
}

let state: CacheState = EMPTY_STATE;
// Whether page data is saved on the device for offline viewing: only for a
// session signed in with "Remember me".
let saveOffline = false;
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
// `remember` is whether they signed in with "Remember me": only then is page
// data saved on the device, and the copy saved last time is restored.
export async function setSessionUser(username: string, remember: boolean): Promise<void> {
  if (state.username !== null && state.username !== username) {
    clearAppCache();
  }

  saveOffline = remember;
  update((current) => ({ ...current, username }));

  if (!remember) {
    await clearOfflineSnapshot();
    return;
  }

  const requestGeneration = generation;
  const snapshot = await loadOfflineSnapshot();

  if (requestGeneration !== generation || snapshot === null) {
    return;
  }

  if (snapshot.username === username) {
    restoreEntries(snapshot.entries);
  } else {
    await clearOfflineSnapshot();
  }
}

// With no connection to check the session, signs in as the user whose data
// was saved on this device, showing that data. Resolves to their username,
// or null when nothing is saved. The data requests still check the session
// once the connection is back, and an ended session wipes the saved data.
export async function restoreOfflineSession(): Promise<string | null> {
  const requestGeneration = generation;
  const snapshot = await loadOfflineSnapshot();

  if (requestGeneration !== generation || snapshot === null) {
    return null;
  }

  if (state.username !== null && state.username !== snapshot.username) {
    return null;
  }

  saveOffline = true;
  update((current) => ({ ...current, username: snapshot.username }));
  restoreEntries(snapshot.entries);
  return snapshot.username;
}

// Adds saved entries the cache doesn't have a newer copy of.
function restoreEntries(saved: Record<string, CacheEntry<unknown>>): void {
  update((current) => {
    const entries = { ...current.entries };

    for (const [key, entry] of Object.entries(saved) as [CachedResource, CacheEntry<unknown>][]) {
      const existing = entries[key];

      if (existing === undefined || existing.fetchedAt < entry.fetchedAt) {
        entries[key] = entry;
      }
    }

    return { ...current, entries };
  });
}

function storeEntry(key: CachedResource, data: unknown): void {
  const entry = { data, fetchedAt: Date.now() };

  update((current) => ({
    ...current,
    entries: { ...current.entries, [key]: entry },
  }));

  if (saveOffline && state.username !== null) {
    void saveOfflineEntry(state.username, key, entry);
  }
}

// Forgets the user and all cached data, including the copy saved on the
// device; in-flight responses are discarded.
export function clearAppCache(): void {
  generation += 1;
  inflight.clear();
  saveOffline = false;
  update(() => EMPTY_STATE);
  void clearOfflineSnapshot();
}

export class ResourceLoadError extends Error {}

// Loads fresh data for a page into the cache. Concurrent calls share one
// request; `force` starts a new one (e.g. after connecting an account), and
// only the most recently started request may update the cache. `fresh` asks
// the server to re-read Plaid and SnapTrade instead of its own short-lived
// cache (the refresh button). Rejects with
// ResourceLoadError when the request fails; resolves without data when the
// session has ended (the fetcher handles that).
export function refreshResource(
  key: CachedResource,
  fetcher: ApiFetcher,
  { force = false, fresh = false }: { force?: boolean; fresh?: boolean } = {},
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
      const response = await fetcher(fresh ? `${resourceUrl(key)}?fresh=1` : resourceUrl(key));

      if (response === null || !isCurrent()) {
        return;
      }

      const body = await readJson(response);

      if (!isCurrent()) {
        return;
      }

      if (!response.ok || !isRecord(body)) {
        throw new ResourceLoadError(errorMessage(body, loadFailed(key)));
      }

      storeEntry(key, body);
    } catch (error) {
      if (!isCurrent()) {
        return;
      }

      if (error instanceof ResourceLoadError) {
        throw error;
      }

      // The request itself failed: usually no connection.
      throw new ResourceLoadError(navigator.onLine ? loadFailed(key) : OFFLINE_MESSAGE);
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

// Stores data a page got some other way (e.g. in reply to a change it
// saved). A request for the same data already in flight is dropped, since it
// may have started before the change.
export function setCachedResource(key: CachedResource, data: unknown): void {
  inflight.delete(key);
  setRefreshing(key, undefined);
  storeEntry(key, data);
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
