import { Hono } from 'hono';
import type { Env } from '../types';

// Nearby fuel with live NSW prices (NSW FuelCheck). The client falls back to its
// OSM/Overpass servo search when this returns no stations (no key / non-NSW /
// upstream error), so fuel-stop discovery always works — this just adds prices.
//
// FuelCheck needs an OAuth client-credentials token (cached ~11h) then a
// prices/nearby call with several required headers. All handled server-side.

const fuel = new Hono<{ Bindings: Env }>();

const BASE = 'https://api.onegov.nsw.gov.au';

function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000, r = Math.PI / 180;
  const dL = (lat2 - lat1) * r, dO = (lon2 - lon1) * r;
  const a = Math.sin(dL / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dO / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export interface FuelStation { brand: string; name: string; lat: number; lng: number; price: number | null; fueltype: string; dist: number; updated: string | null }

// Merge FuelCheck stations[] + prices[] (joined on stationcode) into a sorted,
// price-first list. Pure — testable with captured JSON.
export function normalizeFuel(data: any, fueltype: string, lat: number, lng: number): FuelStation[] {
  const priceByStation: Record<string, { price: number; updated: string }> = {};
  for (const p of data?.prices ?? []) {
    if (fueltype && p.fueltype !== fueltype) continue;
    const code = String(p.stationcode);
    const price = typeof p.price === 'number' ? p.price : parseFloat(p.price);
    if (isNaN(price)) continue;
    if (!priceByStation[code] || price < priceByStation[code].price) priceByStation[code] = { price, updated: p.lastupdated ?? null };
  }
  const out: FuelStation[] = [];
  for (const s of data?.stations ?? []) {
    const loc = s.location ?? {};
    const la = loc.latitude, lo = loc.longitude;
    if (la == null || lo == null) continue;
    const pr = priceByStation[String(s.code)];
    out.push({
      brand: s.brand ?? '', name: s.name ?? s.brand ?? 'Servo',
      lat: la, lng: lo, price: pr ? pr.price : null, fueltype,
      dist: Math.round(haversine(lat, lng, la, lo)), updated: pr ? pr.updated : null,
    });
  }
  // priced first, then cheapest, then nearest
  return out.sort((a, b) => (a.price == null ? 1 : 0) - (b.price == null ? 1 : 0) || (a.price ?? 9e9) - (b.price ?? 9e9) || a.dist - b.dist);
}

// Cache the OAuth token as a small Response so it survives across requests.
async function getToken(env: Env): Promise<string | null> {
  if (!env.NSW_FUELCHECK_KEY || !env.NSW_FUELCHECK_SECRET) return null;
  // @ts-ignore
  const cache = caches.default;
  const tokKey = new Request('https://ghost.cache/fuelcheck-token');
  const hit = await cache.match(tokKey);
  if (hit) { const j = await hit.json().catch(() => null) as any; if (j?.token) return j.token; }
  try {
    const basic = btoa(`${env.NSW_FUELCHECK_KEY}:${env.NSW_FUELCHECK_SECRET}`);
    const r = await fetch(`${BASE}/oauth/client_credential/accesstoken?grant_type=client_credentials`, {
      headers: { Authorization: `Basic ${basic}` }, signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return null;
    const j = await r.json() as any;
    const token = j.access_token; const ttl = Math.max(60, (parseInt(j.expires_in, 10) || 43200) - 120);
    if (token) {
      const res = new Response(JSON.stringify({ token }), { headers: { 'Cache-Control': `public, max-age=${ttl}` } });
      await cache.put(tokKey, res.clone());
    }
    return token ?? null;
  } catch { return null; }
}

function nswTimestamp(): string {
  // FuelCheck wants DD/MM/YYYY hh:mm:ss AM/PM
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  let h = d.getHours(); const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(h)}:${p(d.getMinutes())}:${p(d.getSeconds())} ${ap}`;
}

fuel.get('/', async (c) => {
  const lat = parseFloat(c.req.query('lat') ?? '');
  const lng = parseFloat(c.req.query('lng') ?? '');
  const fueltype = (c.req.query('fueltype') ?? 'U91').toUpperCase();
  const radius = c.req.query('radius') ?? '10';
  if (isNaN(lat) || isNaN(lng)) return c.json({ stations: [] });

  const latB = (Math.round(lat * 50) / 50).toFixed(2), lngB = (Math.round(lng * 50) / 50).toFixed(2); // ~1-2km grid
  const key = new Request(`https://ghost.cache/fuel?v=1&lat=${latB}&lng=${lngB}&ft=${fueltype}`);
  // @ts-ignore
  const cache = caches.default;
  const hit = await cache.match(key);
  if (hit) return hit;

  const token = await getToken(c.env);
  if (!token) return c.json({ stations: [] }); // no key/token → client uses Overpass servos

  try {
    const r = await fetch(`${BASE}/FuelPriceCheck/v1/fuel/prices/nearby`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: c.env.NSW_FUELCHECK_KEY!,
        transactionid: crypto.randomUUID(),
        requesttimestamp: nswTimestamp(),
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ fueltype, latitude: String(lat), longitude: String(lng), radius: String(radius), sortby: 'price', sortascending: 'true' }),
      signal: AbortSignal.timeout(9000),
    });
    if (!r.ok) return c.json({ stations: [] });
    const data = await r.json();
    const stations = normalizeFuel(data, fueltype, lat, lng).slice(0, 30);
    const res = c.json({ stations }, 200, { 'Cache-Control': 'public, max-age=600' });
    c.executionCtx.waitUntil(cache.put(key, res.clone())); // 10 min
    return res;
  } catch {
    return c.json({ stations: [] });
  }
});

export default fuel;
