// Keeps the app's pages and their scripts and styles on the device, so the
// app opens without a connection. It holds no financial data: every page is
// a static shell that loads its data from /api/*, which this worker never
// touches. The data shown offline is the copy the app saves itself (see
// app/offline-store.ts).

const PAGES_CACHE = "tradeapp-pages-v1";
const ASSETS_CACHE = "tradeapp-assets-v1";
const CACHES = [PAGES_CACHE, ASSETS_CACHE];
// The main pages, saved with their scripts whenever the app opens online, so
// any of them opens offline even if it wasn't visited.
const MAIN_PAGES = ["/", "/stocks", "/spending"];
// Older deploys' files are dropped beyond these counts, oldest first.
const MAX_PAGES = 60;
const MAX_ASSETS = 400;
// On a slow connection, a saved page shows after this long.
const NETWORK_TIMEOUT_MS = 4000;

const OFFLINE_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tradeapp</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#e8ebe5;color:#1f2a24;font:16px/1.5 system-ui,-apple-system,sans-serif;text-align:center;padding:16px}a{color:inherit}</style>
</head><body><div><p><strong>You're offline</strong></p><p>This page hasn't been saved on this device yet.</p><p><a href="/">Open the overview</a></p></div></body></html>`;

self.addEventListener("install", (event) => {
  event.waitUntil(saveMainPages().catch(() => undefined));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((name) => !CACHES.includes(name)).map((name) => caches.delete(name)));
      await self.clients.claim();
    })(),
  );
});

// The app asks for a fresh copy of the main pages each time it opens online,
// so the saved pages follow new deploys.
self.addEventListener("message", (event) => {
  if (event.data === "save-pages") {
    event.waitUntil(saveMainPages().catch(() => undefined));
  }
});

self.addEventListener("fetch", (event) => {
  const request = event.request;

  if (request.method !== "GET") {
    return;
  }

  const url = new URL(request.url);

  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) {
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(page(request));
    return;
  }

  // Build files have content hashes in their names, so a saved copy never goes stale.
  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(asset(request));
  }
});

async function page(request) {
  const cache = await caches.open(PAGES_CACHE);
  const key = pageKey(request.url);
  const saved = await cache.match(key);
  const network = fetch(request).then(async (response) => {
    // Safari won't open a saved page that came from a redirect.
    if (response.ok && response.type === "basic" && !response.redirected && isHtml(response)) {
      await cache.put(key, response.clone());
      await trim(PAGES_CACHE, MAX_PAGES);
    }

    return response;
  });

  if (saved === undefined) {
    return network.catch(() => offlinePage());
  }

  // Prefer the network; fall back to the saved page when it fails or is slow.
  return Promise.race([
    network.catch(() => saved),
    new Promise((resolve) => setTimeout(() => resolve(saved), NETWORK_TIMEOUT_MS)),
  ]);
}

async function asset(request) {
  const cache = await caches.open(ASSETS_CACHE);
  const saved = await cache.match(request);

  if (saved !== undefined) {
    return saved;
  }

  const response = await fetch(request);

  if (response.ok && response.type === "basic") {
    await cache.put(request, response.clone());
    await trim(ASSETS_CACHE, MAX_ASSETS);
  }

  return response;
}

// Saves each main page and every build file its HTML names.
async function saveMainPages() {
  const pages = await caches.open(PAGES_CACHE);
  const assets = await caches.open(ASSETS_CACHE);

  await Promise.all(
    MAIN_PAGES.map(async (path) => {
      const response = await fetch(path, { credentials: "same-origin", cache: "no-store" });

      if (!response.ok || response.redirected || !isHtml(response)) {
        return;
      }

      const html = await response.clone().text();
      const files = new Set(html.match(/\/_next\/static\/[^"'\s)\\]+/g) ?? []);

      await Promise.all(
        [...files].map(async (file) => {
          if ((await assets.match(file)) !== undefined) {
            return;
          }

          const fileResponse = await fetch(file).catch(() => null);

          if (fileResponse !== null && fileResponse.ok) {
            await assets.put(file, fileResponse);
          }
        }),
      );
      await pages.put(path, response);
    }),
  );
  await trim(ASSETS_CACHE, MAX_ASSETS);
}

// Pages are saved by path: query strings (e.g. ?year=2025) open the same page.
function pageKey(href) {
  const url = new URL(href);
  return url.origin + url.pathname;
}

function isHtml(response) {
  return (response.headers.get("Content-Type") ?? "").includes("text/html");
}

function offlinePage() {
  return new Response(OFFLINE_PAGE, {
    status: 503,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

// Drops the oldest entries beyond `max` (keys come back oldest first).
async function trim(name, max) {
  const cache = await caches.open(name);
  const keys = await cache.keys();

  await Promise.all(keys.slice(0, Math.max(0, keys.length - max)).map((key) => cache.delete(key)));
}
