import { Hono } from 'hono';
import type { Env } from '../types';
import {
  POLICE_HEX, toPlane, tagPolice, bboxToPointRadius,
  type AdsbAircraft, type Plane,
} from '../data/police-aircraft';

// Live aircraft positions, proxied + edge-cached server-side (the browser never
// calls upstream). Every free ADS-B feed blocks Cloudflare's datacentre egress
// (airplanes.live/adsb.fi 403, OpenSky 522), so the PRIMARY source is our own
// relay on the VM (ghost-adsb.theradicalparty.com → chisel-step tunnel → node on
// :3200), which fetches adsb.fi from a normal IP and returns the raw ADSBExchange
// `{ac:[...]}` shape. See /opt/ghost-adsb on the VM. Fallbacks (rarely reachable
// from the Worker) remain for resilience: airplanes.live (needs key) → OpenSky.
const aircraft = new Hono<{ Bindings: Env }>();

// ── Primary: VM relay ────────────────────────────────────────────────────────
async function relayFetch(env: Env, path: string, ttl: number): Promise<AdsbAircraft[] | null> {
  if (!env.AIRCRAFT_RELAY_URL) return null;
  try {
    const r = await fetch(`${env.AIRCRAFT_RELAY_URL}${path}`, {
      headers: { 'x-ghost-secret': env.AIRCRAFT_RELAY_SECRET ?? '' },
      // @ts-ignore — Workers cf fetch options
      cf: { cacheTtl: ttl, cacheEverything: true },
    });
    if (!r.ok) return null;
    const j = await r.json() as { ac?: AdsbAircraft[] };
    return Array.isArray(j?.ac) ? j.ac : null;
  } catch { return null; }
}

const M_TO_FT = 3.28084;
const MS_TO_KT = 1.94384;

// ── Family A: OpenSky ────────────────────────────────────────────────────────
// states/all row is a positional array; only the indices we use are named here.
type OsState = [string, string, string, number, number, number, number,
  number | null, boolean, number | null, number | null, number | null,
  number[] | null, number | null, string | null, boolean, number, number?];

let _osToken: { value: string; exp: number } | null = null;
async function openSkyToken(env: Env): Promise<string | null> {
  if (!env.OPENSKY_CLIENT_ID || !env.OPENSKY_CLIENT_SECRET) return null;
  if (_osToken && _osToken.exp > Date.now() + 30_000) return _osToken.value;
  try {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: env.OPENSKY_CLIENT_ID,
      client_secret: env.OPENSKY_CLIENT_SECRET,
    });
    const r = await fetch('https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
    });
    if (!r.ok) return null;
    const j = await r.json() as { access_token?: string; expires_in?: number };
    if (!j.access_token) return null;
    _osToken = { value: j.access_token, exp: Date.now() + (j.expires_in ?? 1800) * 1000 };
    return _osToken.value;
  } catch { return null; }
}

async function openSky(query: string, ttl: number, env: Env): Promise<Plane[]> {
  const token = await openSkyToken(env);
  const headers: Record<string, string> = { 'User-Agent': 'ghost/1.0 (ghost.theradicalparty.com)', 'Accept': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  try {
    const r = await fetch(`https://opensky-network.org/api/states/all?${query}`, {
      headers,
      // @ts-ignore — Workers cf fetch options
      cf: { cacheTtl: ttl, cacheEverything: true },
    });
    if (!r.ok) return [];
    const j = await r.json() as { states?: OsState[] };
    return (j.states ?? []).map(osToPlane).filter((p): p is Plane => p !== null);
  } catch { return []; }
}

function osToPlane(s: OsState): Plane | null {
  const lon = s[5], lat = s[6];
  if (typeof lat !== 'number' || typeof lon !== 'number') return null;
  const hex = (s[0] || '').toLowerCase();
  const flight = (s[1] || '').trim();
  // Reuse the shared police classifier (hex allow-list + callsign heuristic;
  // OpenSky has no registration field, so the VH-P rego heuristic can't fire).
  const { police, operator } = tagPolice({ hex, flight } as AdsbAircraft);
  const baro = s[7], geo = s[13];
  const altM = typeof baro === 'number' ? baro : (typeof geo === 'number' ? geo : null);
  return {
    hex, lat, lng: lon,
    alt: altM != null ? Math.round(altM * M_TO_FT) : null,
    gs: typeof s[9] === 'number' ? Math.round(s[9] * MS_TO_KT) : null,
    track: typeof s[10] === 'number' ? s[10] : 0,
    flight, reg: '', type: '',
    category: s[17] != null ? `A${s[17]}` : '',
    police, operator,
  };
}

// ── Family B: airplanes.live / adsb.lol (keyed) ──────────────────────────────
interface Source { point: (a: string, o: string, r: number) => string; mil: string; hex: (c: string) => string; keyed?: boolean; }
function adsbSources(): Source[] {
  return [
    { point: (a, o, r) => `https://api.airplanes.live/v2/point/${a}/${o}/${r}`, mil: 'https://api.airplanes.live/v2/mil', hex: (c) => `https://api.airplanes.live/v2/hex/${c}`, keyed: true },
    { point: (a, o, r) => `https://api.adsb.lol/v2/point/${a}/${o}/${r}`, mil: 'https://api.adsb.lol/v2/mil', hex: (c) => `https://api.adsb.lol/v2/hex/${c}` },
  ];
}
async function fetchAdsb(pick: (s: Source) => string, ttl: number, key: string): Promise<AdsbAircraft[]> {
  for (const s of adsbSources()) {
    try {
      const headers: Record<string, string> = { 'User-Agent': 'ghost/1.0 (ghost.theradicalparty.com)', 'Accept': 'application/json' };
      if (s.keyed) headers['auth'] = key;
      const resp = await fetch(pick(s), {
        headers,
        // @ts-ignore — Workers cf fetch options
        cf: { cacheTtl: ttl, cacheEverything: true },
      });
      if (!resp.ok) continue;
      const json = await resp.json() as { ac?: AdsbAircraft[] };
      if (Array.isArray(json?.ac)) return json.ac;
    } catch { /* next */ }
  }
  return [];
}

// GET /api/aircraft?swlat=&swlng=&nelat=&nelng= — all traffic in the viewport.
aircraft.get('/', async (c) => {
  const { swlat, swlng, nelat, nelng } = c.req.query();
  if (!swlat || !swlng || !nelat || !nelng) {
    return c.json({ error: 'bounds required: swlat, swlng, nelat, nelng' }, 400);
  }
  const sw = { lat: parseFloat(swlat), lng: parseFloat(swlng) };
  const ne = { lat: parseFloat(nelat), lng: parseFloat(nelng) };
  if ([sw.lat, sw.lng, ne.lat, ne.lng].some(Number.isNaN)) {
    return c.json({ error: 'invalid bounds' }, 400);
  }

  let planes: Plane[] = [];
  const key = c.env.AIRPLANES_LIVE_KEY;

  // Primary: VM relay (adsb.fi via a normal IP — carries registration + type).
  const relayed = await relayFetch(c.env,
    `/aircraft?swlat=${sw.lat}&swlng=${sw.lng}&nelat=${ne.lat}&nelng=${ne.lng}`, 8);
  if (relayed) {
    planes = relayed.map(toPlane).filter((p): p is Plane => p !== null);
  } else if (key) {
    // Fallback A: unfiltered ADS-B via the keyed point query, clipped to the box.
    const { lat, lon, radiusNm } = bboxToPointRadius(sw.lat, sw.lng, ne.lat, ne.lng);
    const raw = await fetchAdsb((s) => s.point(lat.toFixed(2), lon.toFixed(2), radiusNm), 8, key);
    planes = raw.map(toPlane).filter((p): p is Plane => p !== null);
  }
  if (!planes.length && !relayed) {
    // Fallback B: OpenSky bounding box (native, no clip needed).
    const q = `lamin=${sw.lat}&lomin=${sw.lng}&lamax=${ne.lat}&lomax=${ne.lng}`;
    planes = await openSky(q, 10, c.env);
  }
  // Guard against a source returning a slightly wider set than the exact box.
  planes = planes.filter((p) => p.lat >= sw.lat && p.lat <= ne.lat && p.lng >= sw.lng && p.lng <= ne.lng);

  return c.json(planes, 200, { 'Cache-Control': 'public, max-age=10' });
});

// GET /api/aircraft/police — police-only, NOT viewport-limited, so PolAir shows
// even when zoomed right out. Looks up the known police hex allow-list.
aircraft.get('/police', async (c) => {
  const key = c.env.AIRPLANES_LIVE_KEY;
  const hexes = Object.keys(POLICE_HEX);
  const seen = new Set<string>();
  const planes: Plane[] = [];
  const add = (p: Plane | null) => {
    if (p && p.police && !seen.has(p.hex)) { seen.add(p.hex); planes.push(p); }
  };

  const relayed = await relayFetch(c.env, `/police?hex=${hexes.join(',')}`, 12);
  if (relayed) {
    relayed.map(toPlane).forEach(add);
  } else if (key) {
    const [byHex, mil] = await Promise.allSettled([
      fetchAdsb((s) => s.hex(hexes.join(',')), 12, key),
      fetchAdsb((s) => s.mil, 12, key),
    ]);
    for (const r of [byHex, mil]) if (r.status === 'fulfilled') r.value.map(toPlane).forEach(add);
  } else {
    // OpenSky: filter states/all to just our allow-list hexes.
    const q = hexes.map((h) => `icao24=${h}`).join('&');
    (await openSky(q, 12, c.env)).forEach(add);
  }

  return c.json(planes, 200, { 'Cache-Control': 'public, max-age=12' });
});

export default aircraft;
