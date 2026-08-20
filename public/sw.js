/* Scout service worker — offline shell + fast repeat loads.
 *
 * Deliberately conservative about what it stores:
 *   - /api/* is never cached. Those responses are per-user data (finds, drafts,
 *     Gmail state) and must always come from the network.
 *   - Only same-origin GETs are touched. Everything else falls through.
 *   - Hashed build assets (/_next/static/*) are cache-first, since their names
 *     change on every deploy.
 *   - Page navigations are network-first, falling back to the last copy we saw
 *     and then to /offline, so a dead signal shows a Scout page, not a browser
 *     error.
 *
 * Bump VERSION to retire every old cache on the next deploy.
 */

const VERSION = "v2";
const SHELL = `scout-shell-${VERSION}`; // precached, rarely changes
const PAGES = `scout-pages-${VERSION}`; // last-seen HTML per route
const ASSETS = `scout-assets-${VERSION}`; // hashed build output + images

const OFFLINE_URL = "/offline";
const PRECACHE = [
  OFFLINE_URL,
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/scout-logo.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      // addAll is all-or-nothing; a single 404 would leave us with no offline
      // page at all, so each entry is added independently.
      .then((cache) =>
        Promise.all(PRECACHE.map((url) => cache.add(url).catch(() => {})))
      )
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  const keep = new Set([SHELL, PAGES, ASSETS]);
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => !keep.has(k)).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

// Let the page ask a waiting worker to take over immediately (used after an
// update is detected, so a refresh is enough to pick up a new deploy).
self.addEventListener("message", (event) => {
  if (event.data === "skip-waiting") self.skipWaiting();
});

const isAsset = (url) =>
  url.pathname.startsWith("/_next/static/") ||
  url.pathname.startsWith("/icons/") ||
  /\.(?:png|jpg|jpeg|gif|svg|webp|avif|ico|woff2?)$/i.test(url.pathname);

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok) cache.put(request, res.clone());
  return res;
}

async function networkFirstPage(request) {
  const cache = await caches.open(PAGES);
  try {
    const res = await fetch(request);
    if (res.ok) cache.put(request, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(request);
    if (hit) return hit;
    const offline = await caches.match(OFFLINE_URL, { cacheName: SHELL });
    if (offline) return offline;
    throw err;
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith(networkFirstPage(request));
    return;
  }
  if (isAsset(url)) {
    event.respondWith(cacheFirst(request, ASSETS).catch(() => fetch(request)));
  }
});
