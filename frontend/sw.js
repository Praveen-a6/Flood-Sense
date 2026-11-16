// Service worker: keeps the app shell available offline.
<<<<<<< HEAD
// Area Packs themselves live in IndexedDB (see js/db.js), and city maps are
// BUILT on the device from public data (js/cityengine.js) - nothing server-side.
const SHELL = "floodsense-shell-v7";
=======
// Area Packs themselves live in IndexedDB (see js/db.js).
const SHELL = "floodsense-shell-v5";
>>>>>>> origin/main
const TILES = "floodsense-tiles-v1";
const ASSETS = [
  "/", "/index.html", "/css/style.css", "/manifest.webmanifest", "/icons/icon.svg",
  "/js/app.js", "/js/db.js", "/js/model.js", "/js/physics.js", "/js/rain.js", "/js/router.js", "/js/voice.js",
  "/js/roads.js", "/js/labels.js", "/js/places.js", "/js/nav.js", "/js/metrics.js", "/js/packs.js",
<<<<<<< HEAD
  "/js/india_cities.js", "/js/packlib.js", "/js/cityengine.js", "/js/cityworker.js", "/js/citybuild.js",
=======
  "/js/live_pack.js", "/js/live_pack_worker.js",
>>>>>>> origin/main
  "/vendor/leaflet/leaflet.js", "/vendor/leaflet/leaflet.css",
];
const MAX_TILES = 600;

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => ![SHELL, TILES].includes(k)).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
<<<<<<< HEAD
  if (url.origin !== location.origin) {
    // cross-origin: never hijack. Only the online basemap tiles are cached;
    // data downloads (Overpass, elevation, Open-Meteo, Nominatim) go straight
    // to the network - silently serving the app shell for them would corrupt builds.
    if (url.hostname.endsWith("tile.openstreetmap.org") || url.hostname.endsWith("basemaps.cartocdn.com")) {
      e.respondWith(caches.open(TILES).then(async (c) => {
        const hit = await c.match(e.request, { ignoreVary: true });
        if (hit) return hit;
        try {
          const res = await fetch(e.request);
          if (res.ok) { c.put(e.request, res.clone()); trim(c); }
          return res;
        } catch { return new Response("", { status: 504 }); }
      }));
    }
    return;
  }
  if (url.pathname.startsWith("/api/")) return;                 // API calls always go to the network

  // app shell (same origin): network-first (always fresh when online), cache when offline
  e.respondWith(fetch(e.request).then((res) => {
    if (res.ok) caches.open(SHELL).then((c) => c.put(e.request, res.clone()));
=======
  if (url.pathname.startsWith("/api/")) return;                 // API calls always go to the network

  if (url.hostname.endsWith("tile.openstreetmap.org") || url.hostname.endsWith("basemaps.cartocdn.com")) {  // background tiles you've viewed: cache-first
    e.respondWith(caches.open(TILES).then(async (c) => {
      const hit = await c.match(e.request, { ignoreVary: true });
      if (hit) return hit;
      try {
        const res = await fetch(e.request);
        if (res.ok) { c.put(e.request, res.clone()); trim(c); }
        return res;
      } catch { return new Response("", { status: 504 }); }
    }));
    return;
  }

  // app shell: network-first (always fresh when online), cache when offline
  e.respondWith(fetch(e.request).then((res) => {
    if (res.ok && url.origin === location.origin) caches.open(SHELL).then((c) => c.put(e.request, res.clone()));
>>>>>>> origin/main
    return res;
  }).catch(() => caches.match(e.request, { ignoreVary: true }).then((hit) => hit || caches.match("/index.html"))));
});

async function trim(cache) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - MAX_TILES; i++) await cache.delete(keys[i]);
}
