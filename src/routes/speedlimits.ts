import { Hono } from 'hono';
import type { Env } from '../types';

// Server-side speed-limit ways for a route's bounding box. Moving this off the
// client makes the HUD speed sign bulletproof: we retry across Overpass mirrors,
// INCLUDE residential/living_street (so urban 50s resolve), and edge-cache by a
// coarse bbox grid so popular corridors are instant and Overpass rate-limits stop
// mattering. Returns [{coords:[[lat,lng],...], limit}] — the client's
// `speedLimitWays` shape.

const speedlimits = new Hono<{ Bindings: Env }>();

const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const HW = 'motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|unclassified|residential|living_street';

// AU maxspeed tag / numeric → km/h.
function parseMaxspeed(raw?: string): number | null {
  if (!raw) return null;
  const AU: Record<string, number> = { 'AU:urban': 50, 'AU:rural': 100, 'AU:motorway': 110, 'AU:living_street': 10, 'AU:school_zone': 40 };
  if (AU[raw]) return AU[raw];
  const n = parseInt(raw, 10);
  return (!isNaN(n) && n > 5 && n < 200) ? n : null;
}
// Sensible AU default when OSM has no maxspeed, so a sign shows on nearly every road.
function classDefault(hw?: string): number | null {
  switch (hw) {
    case 'motorway': case 'motorway_link': return 100;
    case 'trunk': case 'trunk_link': return 90;
    case 'primary': case 'primary_link': return 80;
    case 'secondary': case 'secondary_link': return 70;
    case 'tertiary': case 'tertiary_link': return 60;
    case 'unclassified': return 60;
    case 'residential': return 50;
    case 'living_street': return 20;
    default: return null;
  }
}

async function queryOverpass(q: string): Promise<any | null> {
  for (let i = 0; i < OVERPASS.length; i++) {
    try {
      const resp = await fetch(OVERPASS[i], {
        method: 'POST',
        body: 'data=' + encodeURIComponent(q),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'ghost-nav/1.0 (ghost.theradicalparty.com)' },
        signal: AbortSignal.timeout(25_000),
      });
      if (resp.ok) { const j = await resp.json().catch(() => null); if (j) return j; }
    } catch { /* try next mirror */ }
  }
  return null;
}

export function mapWays(elements: any[]): Array<{ coords: [number, number][]; limit: number }> {
  const out: Array<{ coords: [number, number][]; limit: number }> = [];
  for (const el of elements || []) {
    if (!el.geometry?.length) continue;
    const limit = parseMaxspeed(el.tags?.maxspeed) ?? classDefault(el.tags?.highway);
    if (limit) out.push({ coords: el.geometry.map((g: any) => [g.lat, g.lon]), limit });
  }
  return out;
}

speedlimits.get('/', async (c) => {
  const bbox = (c.req.query('bbox') ?? '').split(',').map(Number);
  if (bbox.length !== 4 || bbox.some(isNaN)) return c.json([], 200);
  let [s, w, n, e] = bbox;
  // Snap to a ~0.02° grid (expand outward) so nearby routes share a cache entry
  // and the queried area exactly matches the cache key.
  const G = 0.02, fl = (x: number) => Math.floor(x / G) * G, ce = (x: number) => Math.ceil(x / G) * G;
  s = fl(s); w = fl(w); n = ce(n); e = ce(e);
  // Guard against absurdly large boxes (a whole-state query would time out).
  if (n - s > 3 || e - w > 3) return c.json([], 200);

  const key = new Request(`https://ghost.cache/speed-limits?v=1&s=${s.toFixed(2)}&w=${w.toFixed(2)}&n=${n.toFixed(2)}&e=${e.toFixed(2)}`);
  // @ts-ignore — Workers Cache API
  const cache = caches.default;
  const hit = await cache.match(key);
  if (hit) return hit;

  const q = `[out:json][timeout:25];way["highway"~"^(${HW})$"](${s},${w},${n},${e});out tags geom;`;
  const data = await queryOverpass(q);
  if (!data) return c.json([], 200); // transient upstream failure — client keeps its fallback
  const ways = mapWays(data.elements);
  const res = c.json(ways, 200, { 'Cache-Control': 'public, max-age=21600' });
  c.executionCtx.waitUntil(cache.put(key, res.clone())); // 6h edge cache
  return res;
});

export default speedlimits;
