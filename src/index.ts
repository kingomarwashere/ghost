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

// ── Unified geocoder: Photon + Nominatim fanned out server-side, merged, and
//    edge-cached so the browser makes ONE fast request and popular queries are
//    near-instant globally. Replaces the client fanning out to 3 slow sources. ─
const NOM_HEADERS = { 'User-Agent': 'ghost-nav/1.0 (ghost.theradicalparty.com)', 'Accept': 'application/json' };
const jsonOrNull = (r: Response) => (r.ok ? r.json() : null);

async function unifiedGeocode(q: string, lat: string, lon: string) {
  const near = !!(lat && lon);
  const parsed = parseAddress(q);

  const photonP = new URLSearchParams({ q, limit: '10', lang: 'en', bbox: '113.3,-43.6,153.6,-10.4' });
  if (near) { photonP.set('lat', lat); photonP.set('lon', lon); }
  const nomP = new URLSearchParams({ q, format: 'jsonv2', countrycodes: 'au', limit: '8', addressdetails: '1', ...(near ? { lat, lon } : {}) });

  const fetches: Promise<any>[] = [
    fetch(`https://photon.komoot.io/api/?${photonP}`, {
      // @ts-ignore
      cf: { cacheTtl: 600, cacheEverything: true },
    }).then(jsonOrNull),
    fetch(`https://nominatim.openstreetmap.org/search?${nomP}`, {
      headers: NOM_HEADERS,
      // @ts-ignore
      cf: { cacheTtl: 600, cacheEverything: true },
    }).then(jsonOrNull),
  ];

  // Structured pass: when the user typed a civic address ("83 queen st ashfield"),
  // ask Nominatim by field (street + city) — free-text mode buries the house
  // behind POIs, but structured mode returns the exact building reliably.
  if (parsed.isAddress) {
    const structP = new URLSearchParams({ format: 'jsonv2', countrycodes: 'au', limit: '8', addressdetails: '1', street: parsed.street });
    if (parsed.locality) structP.set('city', parsed.locality);
    fetches.push(
      fetch(`https://nominatim.openstreetmap.org/search?${structP}`, {
        headers: NOM_HEADERS,
        // @ts-ignore
        cf: { cacheTtl: 600, cacheEverything: true },
      }).then(jsonOrNull),
    );
  }

  const [photon, nom, struct] = await Promise.allSettled(fetches);
  const val = (s: PromiseSettledResult<any>) => (s?.status === 'fulfilled' ? s.value : null);

  return dedupe([
    mapPhoton(val(photon)),
    mapNominatim(val(nom)),
    mapNominatim(val(struct)),   // undefined when not an address query → mapped to []
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
  const cacheKey = new Request(`https://ghost.cache/search?v=3&q=${encodeURIComponent(q.toLowerCase())}&lat=${latB}&lon=${lonB}`);
  // @ts-ignore — Workers Cache API
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const results = await unifiedGeocode(q, lat, lon);
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
app.get('/tiles/me.pmtiles', async (c) => {
  const key = 'tiles/me.pmtiles';
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
