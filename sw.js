// Offline support. The app shell is precached so the map, the zone geometry in
// IndexedDB and the alerting all keep working with no signal; tiles are cached
// opportunistically as you look at them.

const VERSION = 'v1';
const SHELL = `ztl-shell-${VERSION}`;
const TILES = `ztl-tiles-${VERSION}`;
const TILE_LIMIT = 3000;

const SHELL_FILES = [
  './',
  './index.html',
  './manifest.webmanifest',
  './app/styles.css',
  './app/main.js',
  './app/geo.js',
  './app/hours.js',
  './app/overpass.js',
  './app/store.js',
  './app/i18n.js',
  './app/alerts.js',
  './vendor/leaflet/leaflet.js',
  './vendor/leaflet/leaflet.css',
  './vendor/leaflet/images/marker-icon.png',
  './vendor/leaflet/images/marker-icon-2x.png',
  './vendor/leaflet/images/marker-shadow.png',
  './vendor/leaflet/images/layers.png',
  './vendor/leaflet/images/layers-2x.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/favicon-32.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    await cache.addAll(SHELL_FILES);
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((k) => k.startsWith('ztl-') && k !== SHELL && k !== TILES)
      .map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

async function trimTiles() {
  const cache = await caches.open(TILES);
  const keys = await cache.keys();
  if (keys.length <= TILE_LIMIT) return;
  // Oldest-first eviction; Cache Storage keeps insertion order.
  await Promise.all(keys.slice(0, keys.length - TILE_LIMIT).map((k) => cache.delete(k)));
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  // Zone data must always come from the network — never serve a stale answer.
  if (url.pathname.includes('/api/interpreter')) return;

  if (/tile\.openstreetmap\.org|tile\..*\/\d+\/\d+\/\d+\.png/.test(request.url)) {
    event.respondWith((async () => {
      const cache = await caches.open(TILES);
      const hit = await cache.match(request);
      if (hit) return hit;
      try {
        const res = await fetch(request);
        if (res.ok || res.type === 'opaque') {
          cache.put(request, res.clone());
          trimTiles();
        }
        return res;
      } catch (err) {
        return hit || Response.error();
      }
    })());
    return;
  }

  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        return await fetch(request);
      } catch {
        const cache = await caches.open(SHELL);
        return (await cache.match('./index.html')) || (await cache.match('./')) || Response.error();
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(SHELL);
    const hit = await cache.match(request, { ignoreSearch: true });
    if (hit) {
      // Refresh in the background so a redeploy lands on the next launch.
      fetch(request).then((res) => { if (res.ok) cache.put(request, res); }).catch(() => {});
      return hit;
    }
    try {
      const res = await fetch(request);
      if (res.ok) cache.put(request, res.clone());
      return res;
    } catch (err) {
      return Response.error();
    }
  })());
});
