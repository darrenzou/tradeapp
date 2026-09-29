// Per-server-instance cache for provider reads that change at most a few
// times a day (bank transactions, investment history), so the once-a-minute
// live refresh doesn't re-read them from Plaid and SnapTrade every time.

// Set when the user asked to refresh: re-read from Plaid and SnapTrade rather
// than use what this instance has cached.
export type ReadOptions = { fresh?: boolean };

export type ProviderCache<T> = Map<string, { loadedAt: number; expires: number; value: Promise<T> }>;

// A refresh the user asked for reuses anything read this recently, so one
// tap that reloads several pages reads each provider once, and repeated taps
// can't run up Plaid's per-product call caps or SnapTrade's rate limits.
export const FRESH_REUSE_MS = 60_000;

export function cachedRead<T>(
  cache: ProviderCache<T>,
  key: string,
  ttl: number,
  load: () => Promise<T>,
  { fresh = false, now = Date.now() }: ReadOptions & { now?: number } = {},
): Promise<T> {
  const entry = cache.get(key);
  const reusable = entry !== undefined && (fresh ? now - entry.loadedAt < FRESH_REUSE_MS : entry.expires > now);

  if (reusable) {
    return entry.value;
  }

  const value = load();
  const next = { loadedAt: now, expires: now + ttl, value };
  cache.set(key, next);
  // Only this read's own entry is dropped on failure, not a newer one.
  value.catch(() => {
    if (cache.get(key) === next) {
      cache.delete(key);
    }
  });
  return value;
}
