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

const app = new Hono<{ Bindings: Env }>();

app.use('*', cors({ origin: '*' }));

app.route('/api/reports', reports);
app.route('/api/cameras', cameras);
app.route('/api/admin/seed', seed);
app.route('/api/route', route);
app.route('/api/leaderboard', leaderboard);
app.route('/api/copwatch', copwatch);
app.route('/api/auth', auth);
app.route('/api/admin', adminApi);

app.get('/api/health', (c) => c.json({ ok: true, ts: Date.now() }));

// ── NSW Traffic Cameras ──────────────────────────────────────────────────────

// GET /api/traffic-cams — camera metadata list (cached 1h at edge)
app.get('/api/traffic-cams', async (c) => {
  const resp = await fetch('https://www.livetraffic.com/datajson/all-feeds-web.json', {
    headers: { 'User-Agent': 'radar/1.0', 'Accept': 'application/json' },
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

// Serve static assets for everything else
app.get('*', async (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

export default {
  fetch: app.fetch.bind(app),
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(scrapeAll(env.DB, env.OPENWEB_NINJA_KEY));
  },
};
