import { Hono } from 'hono';
import type { Env } from '../types';

// Street-level photo for an address. Tries Mapillary (free, crowdsourced) for the
// closest image; if there's none (patchy AU-suburb coverage) or no token, falls
// back to an aerial/satellite tile so there's ALWAYS an image. Edge-cached ~24h.

const streetview = new Hono<{ Bindings: Env }>();

// Client token for mapillary-js (the interactive 360 viewer runs in the browser
// and needs the access token; Mapillary client tokens are meant for browser use).
streetview.get('/token', (c) => c.json({ token: c.env.MAPILLARY_TOKEN ?? '' }));
// Google Maps JS API key for the interactive Street View panorama (must be
// referrer-restricted to the app's domains — it is exposed in the browser).
streetview.get('/gkey', (c) => c.json({ key: c.env.GOOGLE_MAPS_KEY ?? '' }));

// Pick the Mapillary image object whose point is closest to (lat,lng). Pure.
export function pickNearest(images: any[], lat: number, lng: number): any | null {
  let best: any = null, bestD = Infinity;
  for (const im of images || []) {
    const g = im?.geometry?.coordinates; // [lng, lat]
    if (!g) continue;
    const dLat = g[1] - lat, dLng = (g[0] - lng) * Math.cos(lat * Math.PI / 180);
    const d = dLat * dLat + dLng * dLng;
    if (d < bestD) { bestD = d; best = im; }
  }
  return best;
}

// Esri World Imagery aerial JPEG centred on the point (~180m box). No key needed.
function satelliteUrl(lat: number, lng: number): string {
  const dLat = 0.0009, dLng = 0.0009 / Math.cos(lat * Math.PI / 180);
  const bbox = `${lng - dLng},${lat - dLat},${lng + dLng},${lat + dLat}`;
  return `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export?bbox=${bbox}&bboxSR=4326&imageSR=3857&size=640,400&format=jpg&f=image`;
}

streetview.get('/', async (c) => {
  const lat = parseFloat(c.req.query('lat') ?? '');
  const lng = parseFloat(c.req.query('lng') ?? '');
  if (isNaN(lat) || isNaN(lng)) return c.json({ error: 'lat/lng required' }, 400);

  const rLat = lat.toFixed(4), rLng = lng.toFixed(4); // ~11m cache grid
  // v4: Google Street View is now primary (responses gain type:'google' + pano).
  const key = new Request(`https://ghost.cache/streetview?v=4&lat=${rLat}&lng=${rLng}`);
  // @ts-ignore — Workers Cache API
  const cache = caches.default;
  const hit = await cache.match(key);
  if (hit) return hit;

  let out: { type: 'google' | 'street' | 'sat'; url: string; id?: string; pano?: string; lat?: number; lng?: number } = { type: 'sat', url: satelliteUrl(lat, lng) };

  // 1. Google Street View (best coverage + true 360) — free metadata check first,
  //    so we only claim "google" when a pano actually exists at this spot.
  const gkey = c.env.GOOGLE_MAPS_KEY;
  if (gkey) {
    try {
      const m = await fetch(`https://maps.googleapis.com/maps/api/streetview/metadata?location=${lat},${lng}&source=outdoor&key=${gkey}`, { signal: AbortSignal.timeout(6000) }).then(r => (r.ok ? r.json() : null)) as any;
      if (m?.status === 'OK' && m.pano_id) {
        const loc = m.location ?? {};
        out = {
          type: 'google', pano: m.pano_id, lat: loc.lat ?? lat, lng: loc.lng ?? lng,
          url: `https://maps.googleapis.com/maps/api/streetview?size=640x400&pano=${m.pano_id}&fov=80&key=${gkey}`,
        };
      }
    } catch { /* fall through */ }
  }

  // 2. Mapillary fallback (only if Google had nothing).
  const token = c.env.MAPILLARY_TOKEN;
  if (out.type === 'sat' && token) {
    // ~150m box around the point (wider = better hit rate on suburban streets).
    const dLat = 150 / 111320, dLng = 150 / (111320 * Math.cos(lat * Math.PI / 180));
    const bbox = `${lng - dLng},${lat - dLat},${lng + dLng},${lat + dLat}`;
    // NOTE: the Mapillary token MUST stay raw — its `|` separators break auth if
    // URL-encoded (%7C returns zero images).
    const url = `https://graph.mapillary.com/images?fields=id,thumb_1024_url,thumb_256_url,geometry&bbox=${bbox}&limit=20&access_token=${token}`;
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(6000), cf: { cacheTtl: 86400, cacheEverything: true } } as any);
      if (r.ok) {
        const j = await r.json().catch(() => null) as any;
        const pic = pickNearest(j?.data ?? [], lat, lng);
        const purl = pic?.thumb_1024_url || pic?.thumb_256_url;
        if (purl) out = { type: 'street', url: purl, id: pic.id };
      }
    } catch { /* fall through to satellite */ }
  }

  const res = c.json(out, 200, { 'Cache-Control': 'public, max-age=86400' });
  c.executionCtx.waitUntil(cache.put(key, res.clone()));
  return res;
});

export default streetview;
