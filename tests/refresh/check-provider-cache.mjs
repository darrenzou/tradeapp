// Checks how the refresh button's fresh reads use the server's provider
// cache: a normal load reuses cached Plaid and SnapTrade reads for their TTL,
// a fresh load re-reads them, and fresh loads within a minute of the last
// read share it instead of calling the provider again. No network or
// credentials needed.
//
//   node tests/refresh/check-provider-cache.mjs

import assert from "node:assert/strict";

import { FRESH_REUSE_MS, cachedRead } from "../../lib/provider-cache.ts";

const TTL = 15 * 60_000;

function counter() {
  let calls = 0;
  return {
    load: () => Promise.resolve(++calls),
    get calls() {
      return calls;
    },
  };
}

// Normal loads reuse the cached read until it expires.
{
  const cache = new Map();
  const provider = counter();

  assert.equal(await cachedRead(cache, "k", TTL, provider.load, { now: 0 }), 1);
  assert.equal(await cachedRead(cache, "k", TTL, provider.load, { now: TTL - 1 }), 1);
  assert.equal(await cachedRead(cache, "k", TTL, provider.load, { now: TTL }), 2);
}

// A fresh load re-reads anything older than a minute, and resets the TTL.
{
  const cache = new Map();
  const provider = counter();

  await cachedRead(cache, "k", TTL, provider.load, { now: 0 });
  assert.equal(await cachedRead(cache, "k", TTL, provider.load, { now: FRESH_REUSE_MS, fresh: true }), 2);
  assert.equal(await cachedRead(cache, "k", TTL, provider.load, { now: FRESH_REUSE_MS + TTL - 1 }), 2);
}

// Fresh loads within a minute share one read: one tap reloads several pages,
// and repeated taps don't call the provider again.
{
  const cache = new Map();
  const provider = counter();

  await cachedRead(cache, "k", TTL, provider.load, { now: 0, fresh: true });
  await cachedRead(cache, "k", TTL, provider.load, { now: 10, fresh: true });
  await cachedRead(cache, "k", TTL, provider.load, { now: FRESH_REUSE_MS - 1, fresh: true });
  assert.equal(provider.calls, 1);
  assert.equal(await cachedRead(cache, "k", TTL, provider.load, { now: FRESH_REUSE_MS, fresh: true }), 2);
}

// A failed read isn't cached, so the next load tries again.
{
  const cache = new Map();
  let calls = 0;
  const flaky = () => (++calls === 1 ? Promise.reject(new Error("Plaid is down")) : Promise.resolve(calls));

  await assert.rejects(cachedRead(cache, "k", TTL, flaky, { now: 0 }));
  await Promise.resolve();
  assert.equal(await cachedRead(cache, "k", TTL, flaky, { now: 1 }), 2);
}

console.log("Provider cache checks passed.");
