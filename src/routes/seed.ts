import { Hono } from 'hono';
import type { Env } from '../types';

const seed = new Hono<{ Bindings: Env }>();

function nanoid(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 16);
}

// Require admin key for all seed routes
seed.use('*', async (c, next) => {
  const key = c.req.header('x-admin-key') ?? c.req.query('key');
  if (key !== c.env.ADMIN_KEY) return c.json({ error: 'unauthorized' }, 401);
  return next();
});

// POST /api/admin/seed/osm — fetch AU speed cameras from Overpass API
seed.post('/osm', async (c) => {
  // Compact OverpassQL — no whitespace bloat, short timeout to stay within Worker limits
  const query = '[out:json][timeout:55];(node["highway"="speed_camera"](-44,112,-10,154);node["enforcement"="speed_camera"](-44,112,-10,154);node["enforcement"="traffic_signals"]["traffic_signals"="speed_camera"](-44,112,-10,154);way["highway"="speed_camera"](-44,112,-10,154););out center;';

  let osmData: any;
  // Try two Overpass instances in case one is overloaded
  const ENDPOINTS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
  ];
  let lastErr = '';
  for (const endpoint of ENDPOINTS) {
    try {
      const resp = await fetch(endpoint, {
        method: 'POST',
        body: 'data=' + encodeURIComponent(query),
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'radar-app/1.0 (radar.theradicalparty.com)',
        },
        signal: AbortSignal.timeout(58_000),
      });
      if (!resp.ok) { lastErr = `HTTP ${resp.status} from ${endpoint}`; continue; }
      osmData = await resp.json() as any;
      break;
    } catch (e: any) {
      lastErr = e.message;
    }
  }
  if (!osmData) return c.json({ error: 'Overpass fetch failed: ' + lastErr }, 502);

  const elements: any[] = osmData.elements ?? [];
  const now = Date.now();
  let inserted = 0;
  let skipped = 0;

  const BATCH = 50;
  for (let i = 0; i < elements.length; i += BATCH) {
    const chunk = elements.slice(i, i + BATCH);
    const stmts = chunk
      .filter(el => (el.lat ?? el.center?.lat) && (el.lon ?? el.center?.lon))
      .map(el => {
        const lat = el.lat ?? el.center.lat;
        const lon = el.lon ?? el.center.lon;
        const tags = el.tags ?? {};
        const enforcement = tags.enforcement ?? tags.highway ?? 'speed';
        const type = enforcement === 'traffic_signals' ? 'red_light' : 'speed';
        const road = tags.name ?? tags['addr:street'] ?? null;
        const speedLimit = tags['maxspeed'] ? parseInt(tags['maxspeed']) : null;

        return c.env.DB.prepare(`
          INSERT OR IGNORE INTO cameras (id, lat, lng, type, source, description, state, road, speed_limit, external_id, created_at)
          VALUES (?, ?, ?, ?, 'osm', ?, null, ?, ?, ?, ?)
        `).bind(
          nanoid(), lat, lon, type,
          tags['name'] ?? null,
          road, isNaN(speedLimit!) ? null : speedLimit,
          String(el.id), now
        );
      });

    if (stmts.length === 0) continue;

    try {
      await c.env.DB.batch(stmts);
      inserted += stmts.length;
    } catch {
      skipped += stmts.length;
    }
  }

  return c.json({ source: 'osm', total: elements.length, inserted, skipped });
});

// POST /api/admin/seed/gov — fetch AU govt camera data from data.gov.au
seed.post('/gov', async (c) => {
  const datasets = [
    // VicRoads fixed speed cameras
    {
      url: 'https://data.vic.gov.au/api/3/action/datastore_search?resource_id=4d5ca19e-d0cd-4da0-89c4-0b7b7dbbf5b0&limit=5000',
      state: 'VIC',
      latField: 'Latitude', lngField: 'Longitude',
      typeField: 'Camera_Type', descField: 'Location',
    },
    // NSW speed camera locations (data.nsw.gov.au)
    {
      url: 'https://data.nsw.gov.au/data/api/3/action/datastore_search?resource_id=9d59e71b-7c99-477c-8921-e2a13a68e0b3&limit=5000',
      state: 'NSW',
      latField: 'Latitude', lngField: 'Longitude',
      typeField: 'CameraType', descField: 'Location',
    },
  ];

  const now = Date.now();
  let totalInserted = 0;
  const results: any[] = [];

  for (const ds of datasets) {
    try {
      const resp = await fetch(ds.url);
      if (!resp.ok) { results.push({ state: ds.state, error: `HTTP ${resp.status}` }); continue; }
      const json = await resp.json() as any;
      const records: any[] = json?.result?.records ?? [];

      const stmts = records
        .filter(r => r[ds.latField] && r[ds.lngField])
        .map(r => {
          const rawType = (r[ds.typeField] ?? '').toLowerCase();
          const type = rawType.includes('red') ? 'red_light'
            : rawType.includes('average') ? 'average_speed'
            : 'speed';
          const lat = parseFloat(r[ds.latField]);
          const lng = parseFloat(r[ds.lngField]);
          if (isNaN(lat) || isNaN(lng)) return null;

          return c.env.DB.prepare(`
            INSERT OR IGNORE INTO cameras (id, lat, lng, type, source, description, state, road, speed_limit, external_id, created_at)
            VALUES (?, ?, ?, ?, 'gov', ?, ?, ?, ?, ?, ?)
          `).bind(
            nanoid(), lat, lng, type,
            r[ds.descField] ?? null, ds.state, null, null,
            r['_id'] ? String(r['_id']) : null, now
          );
        })
        .filter(Boolean) as D1PreparedStatement[];

      for (let i = 0; i < stmts.length; i += 50) {
        const chunk = stmts.slice(i, i + 50);
        if (chunk.length) await c.env.DB.batch(chunk);
      }

      totalInserted += stmts.length;
      results.push({ state: ds.state, inserted: stmts.length });
    } catch (e: any) {
      results.push({ state: ds.state, error: e.message });
    }
  }

  return c.json({ source: 'gov', totalInserted, results });
});

// POST /api/admin/seed/nsw-replace — replace ALL gov-source cameras with a fresh
// authoritative set. Body: { cameras: [{lat,lng,type,road,speed_limit,state,external_id}] }.
// The TfNSW CloudFront host blocks Cloudflare egress, so a VM cron fetches the official
// CSVs, parses them, and posts the rows here (Worker owns the D1 write).
seed.post('/nsw-replace', async (c) => {
  const body: any = await c.req.json().catch(() => null);
  const cams: any[] = Array.isArray(body?.cameras) ? body.cameras : [];
  if (!cams.length) return c.json({ error: 'no cameras' }, 400);
  await c.env.DB.prepare("DELETE FROM cameras WHERE source='gov'").run();
  const now = Date.now();
  let inserted = 0;
  for (let i = 0; i < cams.length; i += 50) {
    const chunk = cams.slice(i, i + 50).filter((x: any) => typeof x.lat === 'number' && typeof x.lng === 'number');
    if (!chunk.length) continue;
    const stmts = chunk.map((x: any) => c.env.DB.prepare(
      `INSERT OR IGNORE INTO cameras (id,lat,lng,type,source,description,state,road,speed_limit,external_id,created_at)
       VALUES (?,?,?,?,'gov',?,?,?,?,?,?)`
    ).bind(nanoid(), x.lat, x.lng, x.type || 'speed', x.description ?? x.road ?? null, x.state ?? 'NSW', x.road ?? null, x.speed_limit ?? null, x.external_id ?? null, now));
    try { await c.env.DB.batch(stmts); inserted += stmts.length; } catch { /* skip bad chunk */ }
  }
  return c.json({ replaced: 'gov', inserted });
});

function haversineM(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000, toR = (x: number) => x * Math.PI / 180;
  const dLat = toR(bLat - aLat), dLng = toR(bLng - aLng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toR(aLat)) * Math.cos(toR(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// POST /api/admin/seed/prune-monitoring?m=60 — delete OSM enforcement cameras sitting on a
// live TRAFFIC-MONITORING webcam (LiveTraffic feed) — i.e. a crowdsourced mistag of a
// monitoring CCTV as a speed camera (the reported bug). Gov cameras are never pruned.
seed.post('/prune-monitoring', async (c) => {
  const resp = await fetch('https://www.livetraffic.com/datajson/all-feeds-web.json', { headers: { 'User-Agent': 'ghost/1.0' } });
  if (!resp.ok) return c.json({ error: 'webcam feed error' }, 502);
  const all = await resp.json() as any[];
  const webcams = all.filter((f: any) => f.eventCategory === 'liveCams').map((f: any) => ({ lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0] }));
  const rows = ((await c.env.DB.prepare("SELECT id,lat,lng FROM cameras WHERE source='osm'").all()).results ?? []) as any[];
  const R = Math.max(20, Math.min(200, Number(c.req.query('m') || '60')));
  const del: string[] = [];
  for (const cam of rows) {
    for (const w of webcams) { if (haversineM(cam.lat, cam.lng, w.lat, w.lng) < R) { del.push(cam.id); break; } }
  }
  for (let i = 0; i < del.length; i += 50) {
    await c.env.DB.batch(del.slice(i, i + 50).map(id => c.env.DB.prepare('DELETE FROM cameras WHERE id=?').bind(id)));
  }
  return c.json({ webcams: webcams.length, osm_scanned: rows.length, pruned: del.length, radius_m: R });
});

export default seed;
