const CACHE      = 'radar-v4';
const TILE_CACHE = 'radar-tiles-v1';
const TILE_MAX   = 500;
const STATIC = ['/', '/index.html', '/app.js', '/style.css', '/manifest.json', '/icon.svg'];

// Tile CDN hostnames to cache
const TILE_HOSTS = [
  'basemaps.cartocdn.com',
  'server.arcgisonline.com',
  'tile.arcgis.com',
  'opentopomap.org',
  'tile.opentopomap.org',
  'a.tile.opentopomap.org',
  'b.tile.opentopomap.org',
  'c.tile.opentopomap.org',
  'tile.openstreetmap.org',
  'a.tile.openstreetmap.org',
  'b.tile.openstreetmap.org',
  'c.tile.openstreetmap.org',
];

function isTileRequest(url) {
  return TILE_HOSTS.some(h => url.hostname === h || url.hostname.endsWith('.' + h));
}

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(STATIC)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE && k !== TILE_CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// Trim tile cache to TILE_MAX entries
async function trimTileCache() {
  const cache = await caches.open(TILE_CACHE);
  const keys  = await cache.keys();
  if (keys.length > TILE_MAX) {
    // Delete oldest entries (front of list)
    const toDelete = keys.slice(0, keys.length - TILE_MAX);
    await Promise.all(toDelete.map(k => cache.delete(k)));
  }
}

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // API calls — always network, offline fallback for JSON
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(
      fetch(e.request).catch(() =>
        new Response('{"error":"offline"}', { headers: { 'Content-Type': 'application/json' } })
      )
    );
    return;
  }

  // Map tiles — stale-while-revalidate
  if (isTileRequest(url)) {
    e.respondWith(
      caches.open(TILE_CACHE).then(async cache => {
        const cached = await cache.match(e.request);
        const netFetch = fetch(e.request).then(res => {
          if (res.ok) {
            cache.put(e.request, res.clone());
            // Trim async, don't block response
            trimTileCache().catch(() => {});
          }
          return res;
        }).catch(() => null);

        // Return cached immediately if available, else wait for network
        if (cached) {
          // Kick off background revalidation
          netFetch.catch(() => {});
          return cached;
        }
        return netFetch || new Response('', { status: 503 });
      })
    );
    return;
  }

  // Nominatim / Overpass — network only, no caching
  if (url.hostname.includes('nominatim') || url.hostname.includes('overpass')) {
    e.respondWith(fetch(e.request).catch(() => new Response('[]', { headers: { 'Content-Type': 'application/json' } })));
    return;
  }

  // Static assets — cache-first with network update
  e.respondWith(
    caches.match(e.request).then(cached => {
      const net = fetch(e.request).then(res => {
        if (res.ok) caches.open(CACHE).then(c => c.put(e.request, res.clone()));
        return res;
      });
      return cached || net;
    })
  );
});
