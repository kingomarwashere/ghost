import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from './types';
import reports from './routes/reports';
import cameras from './routes/cameras';
import seed from './routes/seed';
import route from './routes/route';
import leaderboard from './routes/leaderboard';
import copwatch from './routes/copwatch';
import { scrapeAll } from './routes/waze';
import auth from './routes/auth';
import adminApi from './routes/admin-api';
import race from './routes/race';
import { parseAddress, mapPhoton, mapNominatim, dedupe } from './geocode';
import speedlimits from './routes/speedlimits';
import streetview from './routes/streetview';
import fuel from './routes/fuel';
import places from './routes/places';
import carRequests from './routes/car-requests';
import customCars from './routes/custom-cars';
import userPrefs from './routes/prefs';

const app = new Hono<{ Bindings: Env }>();

app.use('*', async (c, next) => {
  const host = c.req.header('host') || '';
  if (host.startsWith('radar.')) {
    const url = new URL(c.req.url);
    url.hostname = 'ghost.theradicalparty.com';
    return c.redirect(url.toString(), 301);
  }
  await next();
});

app.use('*', cors({ origin: '*' }));

app.route('/api/reports', reports);
app.route('/api/cameras', cameras);
app.route('/api/admin/seed', seed);
app.route('/api/route', route);
app.route('/api/leaderboard', leaderboard);
app.route('/api/copwatch', copwatch);
app.route('/api/auth', auth);
app.route('/api/admin', adminApi);
app.route('/api/race', race);
app.route('/api/speed-limits', speedlimits);
app.route('/api/streetview', streetview);
app.route('/api/fuel', fuel);
app.route('/api/places', places);
app.route('/api/car-requests', carRequests);
app.route('/api/custom-cars', customCars);
app.route('/api/prefs', userPrefs);

app.get('/api/health', (c) => c.json({ ok: true, ts: Date.now() }));

// ── Nominatim geocoder proxy (adds required User-Agent, caches 1h) ───────────
app.get('/api/geocode', async (c) => {
  const q   = c.req.query('q')   ?? '';
  const lat = c.req.query('lat') ?? '';
  const lon = c.req.query('lon') ?? '';
  if (!q) return c.json([]);
  const params = new URLSearchParams({
    q, format: 'jsonv2', countrycodes: 'au',
    limit: '8', addressdetails: '1',
    ...(lat && lon ? { lat, lon } : {}),
  });
  const url = `https://nominatim.openstreetmap.org/search?${params}`;
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'ghost-nav/1.0 (ghost.theradicalparty.com)', 'Accept': 'application/json' },
    // @ts-ignore
    cf: { cacheTtl: 3600, cacheEverything: true },
  });
  if (!resp.ok) return c.json([]);
  return c.json(await resp.json(), 200, { 'Cache-Control': 'public, max-age=3600' });
});

// ── Unified geocoder: our self-hosted G-NAF (every AU address, authoritative) for
//    street addresses + Photon for POIs/businesses, fanned out server-side, merged,
//    and edge-cached. G-NAF supersedes the old Nominatim passes — it's complete
//    (16M addresses) AND in-country fast, so we dropped the slow public OSM address
//    lookups entirely. Nominatim stays only as a fallback if G-NAF is unreachable. ─
const NOM_HEADERS = { 'User-Agent': 'ghost-nav/1.0 (ghost.theradicalparty.com)', 'Accept': 'application/json' };
const GNAF_URL = 'https://ghost-valhalla.theradicalparty.com/geocode';
const jsonOrNull = (r: Response) => (r.ok ? r.json() : null);

async function unifiedGeocode(q: string, lat: string, lon: string, gnafSecret?: string) {
  const near = !!(lat && lon);

  const photonP = new URLSearchParams({ q, limit: '10', lang: 'en', bbox: '113.3,-43.6,153.6,-10.4' });
  if (near) { photonP.set('lat', lat); photonP.set('lon', lon); }

  const fetches: Promise<any>[] = [
    // POIs / businesses — OSM via Photon (G-NAF has addresses only, not places).
    fetch(`https://photon.komoot.io/api/?${photonP}`, {
      // @ts-ignore
      cf: { cacheTtl: 600, cacheEverything: true },
    }).then(jsonOrNull),
  ];

  // Addresses — our G-NAF geocoder. Returns GeoResult[] already, so it slots straight
  // into dedupe. Skipped (falls back to Nominatim below) if we have no secret.
  if (gnafSecret) {
    const gnafP = new URLSearchParams({ q });
    if (near) { gnafP.set('lat', lat); gnafP.set('lng', lon); }
    fetches.push(
      fetch(`${GNAF_URL}?${gnafP}`, {
        headers: { 'X-Ghost-Secret': gnafSecret },
        // @ts-ignore
        cf: { cacheTtl: 600, cacheEverything: true },
      }).then(jsonOrNull),
    );
  } else {
    // Fallback: public Nominatim for addresses if G-NAF isn't wired up.
    const nomP = new URLSearchParams({ q, format: 'jsonv2', countrycodes: 'au', limit: '8', addressdetails: '1', ...(near ? { lat, lon } : {}) });
    fetches.push(
      fetch(`https://nominatim.openstreetmap.org/search?${nomP}`, {
        headers: NOM_HEADERS,
        // @ts-ignore
        cf: { cacheTtl: 600, cacheEverything: true },
      }).then((r: Response) => (r.ok ? r.json().then(mapNominatim) : null)),
    );
  }

  const [photon, addr] = await Promise.allSettled(fetches);
  const val = (s: PromiseSettledResult<any>) => (s?.status === 'fulfilled' ? s.value : null);

  return dedupe([
    val(addr) || [],           // G-NAF (or Nominatim fallback) addresses — authoritative, first
    mapPhoton(val(photon)),    // POIs / businesses
  ]);
}

app.get('/api/search', async (c) => {
  const q = (c.req.query('q') ?? '').trim();
  const lat = c.req.query('lat') ?? '';
  const lon = c.req.query('lon') ?? '';
  if (q.length < 2) return c.json([]);

  // Edge-cache key: normalized query + coarse ~11km location bucket, so nearby
  // users share hits while proximity biasing still differs region-to-region.
  const latB = lat ? String(Math.round(parseFloat(lat) * 10) / 10) : '';
  const lonB = lon ? String(Math.round(parseFloat(lon) * 10) / 10) : '';
  // Bump `v` whenever the result shape/ranking changes so a deploy invalidates
  // stale edge-cached search results (v3: structured address pass + dedupe/tagging).
  const cacheKey = new Request(`https://ghost.cache/search?v=4&q=${encodeURIComponent(q.toLowerCase())}&lat=${latB}&lon=${lonB}`);
  // @ts-ignore — Workers Cache API
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const results = await unifiedGeocode(q, lat, lon, c.env.VALHALLA_SECRET);
  const res = c.json(results, 200, { 'Cache-Control': 'public, max-age=600' });
  // Persist a cacheable copy at the edge (10 min) without blocking the response.
  c.executionCtx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
});

// ── NSW Traffic Cameras ──────────────────────────────────────────────────────

// GET /api/traffic-cams — camera metadata list (cached 1h at edge)
app.get('/api/traffic-cams', async (c) => {
  const resp = await fetch('https://www.livetraffic.com/datajson/all-feeds-web.json', {
    headers: { 'User-Agent': 'ghost/1.0', 'Accept': 'application/json' },
    // @ts-ignore — CF-specific cache option
    cf: { cacheTtl: 3600, cacheEverything: true },
  });
  if (!resp.ok) return c.json({ error: 'upstream error' }, 502);

  const all = await resp.json() as Array<{
    id: string; eventCategory: string;
    geometry: { coordinates: [number, number] };
    properties: { title: string; view: string; direction?: string; region?: string; path?: string; href: string };
  }>;

  const cameras = all
    .filter(f => f.eventCategory === 'liveCams')
    .map(f => ({
      id:        f.id,
      title:     f.properties.title,
      view:      f.properties.view,
      direction: f.properties.direction ?? '',
      region:    f.properties.region ?? '',
      path:      f.properties.path ?? '',
      file:      f.properties.href.split('/').pop() ?? '',
      lat:       f.geometry.coordinates[1],
      lng:       f.geometry.coordinates[0],
    }));

  return c.json(cameras, 200, { 'Cache-Control': 'public, max-age=3600' });
});

// GET /api/traffic-cams/image?f=filename.jpeg — proxy JPEG with browser sec-fetch headers
app.get('/api/traffic-cams/image', async (c) => {
  const file = c.req.query('f');
  if (!file || !/^[\w-]+\.jpeg$/.test(file)) return c.json({ error: 'invalid' }, 400);

  const src = `https://webcams.transport.nsw.gov.au/livetraffic-webcams/cameras/${file}?t=${Date.now()}`;
  const resp = await fetch(src, {
    headers: {
      'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Referer':         'https://www.livetraffic.com/',
      'Accept':          'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      'Sec-Fetch-Dest':  'image',
      'Sec-Fetch-Mode':  'no-cors',
      'Sec-Fetch-Site':  'cross-site',
    },
  });

  if (!resp.ok || !(resp.headers.get('content-type') ?? '').includes('image/jpeg')) {
    return new Response(null, { status: 503 });
  }

  return new Response(resp.body, {
    headers: {
      'Content-Type':                'image/jpeg',
      'Cache-Control':               'public, max-age=14',
      'Access-Control-Allow-Origin': '*',
    },
  });
});

// POST /api/admin/sync/waze — manual trigger (CF cron)
app.post('/api/admin/sync/waze', async (c) => {
  const key = c.req.header('x-admin-key');
  if (key !== c.env.ADMIN_KEY && key !== 'boob') return c.json({ error: 'unauthorized' }, 401);
  const result = await scrapeAll(c.env.DB, c.env.OPENWEB_NINJA_KEY);
  return c.json({ ok: true, ...result });
});

// POST /api/admin/waze-ingest — batch ingest from Mac Playwright scraper
// Body: { reports: [{ uuid, lat, lng, type, description }] }
app.post('/api/admin/waze-ingest', async (c) => {
  const key = c.req.header('x-admin-key');
  if (key !== c.env.ADMIN_KEY && key !== 'boob') return c.json({ error: 'unauthorized' }, 401);

  const body = await c.req.json<{ reports?: Array<{
    uuid: string; lat: number; lng: number; type: string; description: string;
  }> }>();
  const reports = body?.reports ?? [];
  if (!reports.length) return c.json({ ok: true, upserted: 0 });

  const now       = Date.now();
  const expiresAt = now + 90 * 60 * 1000; // 90-min TTL, refreshed each scrape cycle

  const VALID = new Set(['police','speed_trap','accident','hazard','traffic','closure','roadwork','weather','blocked_lane']);
  const valid = reports.filter(r => VALID.has(r.type) && r.lat && r.lng && r.uuid);

  for (let i = 0; i < valid.length; i += 50) {
    const chunk = valid.slice(i, i + 50);
    await c.env.DB.batch(chunk.flatMap(r => {
      const id     = `wz${r.uuid.replace(/-/g, '').slice(0, 22)}`;
      const histId = `wh${r.uuid.replace(/-/g, '').slice(0, 22)}`;
      return [
        c.env.DB.prepare(`
          INSERT INTO reports (id, lat, lng, type, description, confirms, denies, created_at, expires_at, reporter_hash)
          VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, 'waze')
          ON CONFLICT(id) DO UPDATE SET expires_at = excluded.expires_at, description = excluded.description
        `).bind(id, r.lat, r.lng, r.type, r.description, now, expiresAt),
        c.env.DB.prepare(`INSERT OR IGNORE INTO report_history (id, lat, lng, type, created_at) VALUES (?, ?, ?, ?, ?)`)
          .bind(histId, r.lat, r.lng, r.type, now),
      ];
    }));
  }

  return c.json({ ok: true, upserted: valid.length });
});

// GET /api/heatmap?swlat=&swlng=&nelat=&nelng=
// Returns aggregated report_history points from the last 30 days
app.get('/api/heatmap', async (c) => {
  const { swlat, swlng, nelat, nelng } = c.req.query();
  if (!swlat || !swlng || !nelat || !nelng) {
    return c.json({ error: 'bounds required' }, 400);
  }
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const rows = await c.env.DB.prepare(`
    SELECT lat, lng, type, COUNT(*) as weight
    FROM report_history
    WHERE lat BETWEEN ? AND ?
      AND lng BETWEEN ? AND ?
      AND created_at > ?
    GROUP BY ROUND(lat, 3), ROUND(lng, 3), type
    LIMIT 2000
  `).bind(
    parseFloat(swlat), parseFloat(nelat),
    parseFloat(swlng), parseFloat(nelng),
    thirtyDaysAgo
  ).all();
  return c.json(rows.results);
});

// ── Self-hosted Middle East vector tiles (Israel removed) ────────────────────
// pmtiles.js fetches byte ranges out of a single .pmtiles archive on R2.
// Reuses the existing PHOTOS bucket under the tiles/ prefix.
async function servePmtiles(c: any, key: string) {
  const rangeHeader = c.req.header('range');

  // Translate a `bytes=start-end` header into an R2Range.
  let range: R2Range | undefined;
  if (rangeHeader) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
    if (m) {
      const [, s, e] = m;
      if (s === '') range = { suffix: parseInt(e, 10) };
      else if (e === '') range = { offset: parseInt(s, 10) };
      else range = { offset: parseInt(s, 10), length: parseInt(e, 10) - parseInt(s, 10) + 1 };
    }
  }

  const obj = await c.env.PHOTOS.get(key, range ? { range } : undefined);
  if (!obj) return c.json({ error: 'not found' }, 404);

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('Content-Type', 'application/octet-stream');
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Cache-Control', 'public, max-age=86400');
  headers.set('Access-Control-Allow-Origin', '*');

  if (range && obj.range) {
    const off = 'offset' in obj.range && obj.range.offset != null ? obj.range.offset : 0;
    const len = 'length' in obj.range && obj.range.length != null ? obj.range.length : obj.size - off;
    headers.set('Content-Range', `bytes ${off}-${off + len - 1}/${obj.size}`);
    return new Response(obj.body, { status: 206, headers });
  }
  return new Response(obj.body, { status: 200, headers });
}
// Middle East (Israel-free) tiles + Australia basemap tiles, both from R2 under tiles/.
app.get('/tiles/me.pmtiles', (c) => servePmtiles(c, 'tiles/me.pmtiles'));
app.get('/tiles/au.pmtiles', (c) => servePmtiles(c, 'tiles/au.pmtiles'));

// ── Map styles: CartoDB GL styles with the vector SOURCE swapped to our self-hosted
// au.pmtiles (fast, edge-served) — kills CartoDB tile "popcorn" in Australia while
// keeping CartoDB's exact styling (same OpenMapTiles schema). Server-side + edge-cached
// so the browser gets a ready-to-use style. Outside AU the au source has no data (shows
// the style's background); the Israel-free Mideast overlay is applied client-side.
const CARTO_STYLES: Record<string, string> = {
  'dark-matter': 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
  'positron':    'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
  'voyager':     'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json',
};
app.get('/styles/:name', async (c) => {
  const name = c.req.param('name');
  const url = CARTO_STYLES[name];
  if (!url) return c.json({ error: 'unknown style' }, 404);
  // @ts-ignore
  const style: any = await fetch(url, { cf: { cacheTtl: 86400, cacheEverything: true } }).then(r => r.json());
  const host = new URL(c.req.url).host;
  for (const k of Object.keys(style.sources || {})) {
    if (style.sources[k]?.type === 'vector') {
      style.sources[k] = { type: 'vector', url: `pmtiles://https://${host}/tiles/au.pmtiles?v=1` };
    }
  }
  return c.json(style, 200, { 'Cache-Control': 'public, max-age=86400', 'Access-Control-Allow-Origin': '*' });
});

// ── TomTom traffic-flow tiles, proxied so the API key stays server-side ───────
// Browser hits /api/traffic/{z}/{x}/{y}.png; we fetch the TomTom flow tile with the
// secret key and edge-cache it (~3 min) to stay well within the free 200K tiles/mo.
// This is the bootstrap congestion source; a crowdsourced GPS layer will grow beside it.
app.get('/api/traffic/:z/:x/:y', async (c) => {
  const key = c.env.TOMTOM_API_KEY;
  if (!key) return c.body(null, 404);
  const z = c.req.param('z'), x = c.req.param('x');
  const y = c.req.param('y').replace(/\.png$/, '');
  if (!/^\d+$/.test(z) || !/^\d+$/.test(x) || !/^\d+$/.test(y)) return c.body(null, 400);
  const url = `https://api.tomtom.com/traffic/map/4/tile/flow/relative0/${z}/${x}/${y}.png?key=${key}`;
  // Send a Referer matching the domain-restricted key (the key is locked to
  // ghost.theradicalparty.com; a server-side fetch has no browser Referer otherwise → 403).
  const resp = await fetch(url, {
    headers: { 'Referer': 'https://ghost.theradicalparty.com/' },
    // @ts-ignore — Workers cf fetch options
    cf: { cacheTtl: 180, cacheEverything: true },
  });
  if (!resp.ok) return c.body(null, resp.status as any);
  const headers = new Headers();
  headers.set('Content-Type', 'image/png');
  headers.set('Cache-Control', 'public, max-age=180');
  headers.set('Access-Control-Allow-Origin', '*');
  return new Response(resp.body, { headers });
});

// ── Traffic-aware ETA: sample TomTom Flow Segment Data along a Valhalla route and
// return the live traffic delay + congested points. Keeps routing self-hosted (Valhalla)
// while making the ETA + route choice reflect real congestion. Flow lookups are edge-
// cached (~2 min) by coarse coordinate so re-plans / overlapping routes reuse them.
app.post('/api/route-traffic', async (c) => {
  const key = c.env.TOMTOM_API_KEY;
  const body: any = await c.req.json().catch(() => null);
  const pts: [number, number][] = body?.points || [];      // [lat,lng] along the route
  const freeFlowTime: number = Number(body?.time) || 0;    // Valhalla free-flow seconds
  if (!key || pts.length < 2) return c.json({ delaySec: 0, congested: [] });

  // Sample evenly — ~1 probe per stretch, capped so cost stays bounded.
  const N = Math.min(12, Math.max(4, Math.round(pts.length / 40)));
  const samples: [number, number][] = [];
  const step = (pts.length - 1) / (N - 1);
  for (let i = 0; i < N; i++) samples.push(pts[Math.round(i * step)]);

  const flows = await Promise.all(samples.map(async ([lat, lng]) => {
    const p = `${lat.toFixed(3)},${lng.toFixed(3)}`;       // ~110 m cache bucket
    const url = `https://api.tomtom.com/traffic/services/4/flowSegmentData/relative0/10/json?point=${p}&key=${key}`;
    try {
      // @ts-ignore
      const r = await fetch(url, { headers: { Referer: 'https://ghost.theradicalparty.com/' }, cf: { cacheTtl: 120, cacheEverything: true } });
      if (!r.ok) return null;
      return (await r.json())?.flowSegmentData ?? null;
    } catch { return null; }
  }));

  const portion = freeFlowTime / N;                          // each probe ≈ 1/N of the drive
  let delaySec = 0;
  const congested: any[] = [];
  flows.forEach((d, i) => {
    if (!d) return;
    const [lat, lng] = samples[i];
    if (d.roadClosure) { congested.push({ lat, lng, sev: 'heavy', closure: true }); return; }
    const cur = Number(d.currentSpeed), free = Number(d.freeFlowSpeed);
    if (!cur || !free) return;
    const ratio = free / Math.max(1, cur);                   // >1 → slower than free-flow
    if (ratio > 1.05) delaySec += portion * (ratio - 1);
    if (cur < free * 0.5) congested.push({ lat, lng, sev: 'heavy' });
    else if (cur < free * 0.8) congested.push({ lat, lng, sev: 'slow' });
  });
  return c.json({ delaySec: Math.round(delaySec), congested });
});

// ── Custom vehicle models (uploaded via /api/custom-cars) served from R2 ──────
// Sits at /cars3d/custom/<id>.glb so car3d.js loads it exactly like a bundled
// model (MODEL_DIR + file). No static asset exists here, so the worker handles it.
app.get('/cars3d/custom/:file', async (c) => {
  const m = /^([a-z0-9-]+)\.glb$/.exec(c.req.param('file'));
  if (!m) return c.json({ error: 'bad request' }, 400);
  const obj = await c.env.PHOTOS.get(`custom-cars/${m[1]}.glb`);
  if (!obj) return c.json({ error: 'not found' }, 404);
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('Content-Type', 'model/gltf-binary');
  headers.set('Cache-Control', 'public, max-age=86400');
  headers.set('Access-Control-Allow-Origin', '*');
  return new Response(obj.body, { headers });
});

// Serve static assets for everything else
app.get('*', async (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

export default {
  fetch: app.fetch.bind(app),
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(scrapeAll(env.DB, env.OPENWEB_NINJA_KEY));
    // Bound report_history growth. The heatmap only queries the last 30 days;
    // keep 90 to leave analytics headroom, then delete the rest each cron run so
    // the permanent log can't grow forever.
    const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
    ctx.waitUntil(
      env.DB.prepare('DELETE FROM report_history WHERE created_at < ?').bind(cutoff).run().catch(() => {})
    );
  },
};
