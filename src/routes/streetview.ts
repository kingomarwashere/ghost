import { Hono } from 'hono';
import type { Env } from '../types';

// Street-level photo for an address: Google Street View (best coverage + true 360).
// If there's no pano at the spot, falls back to an aerial/satellite tile so there's
// ALWAYS an image. Edge-cached ~24h.

const streetview = new Hono<{ Bindings: Env }>();

// Google Maps API key for the interactive Street View panorama (must be
// referrer-restricted to the app's domains — it is exposed in the browser).
streetview.get('/gkey', (c) => c.json({ key: c.env.GOOGLE_MAPS_KEY ?? '' }));

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
  const key = new Request(`https://ghost.cache/streetview?v=5&lat=${rLat}&lng=${rLng}`);
  // @ts-ignore — Workers Cache API
  const cache = caches.default;
  const hit = await cache.match(key);
  if (hit) return hit;

  let out: { type: 'google' | 'sat'; url: string; pano?: string; lat?: number; lng?: number } = { type: 'sat', url: satelliteUrl(lat, lng) };

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

  // No Google pano here → the satellite fallback set above stands.
  const res = c.json(out, 200, { 'Cache-Control': 'public, max-age=86400' });
  c.executionCtx.waitUntil(cache.put(key, res.clone()));
  return res;
});

export default streetview;
