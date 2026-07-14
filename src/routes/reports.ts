import { Hono } from 'hono';
import type { Env, Report } from '../types';

const reports = new Hono<{ Bindings: Env }>();

const REPORT_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
const DENY_THRESHOLD = 3; // auto-remove after 3 more denies than confirms

function nanoid(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 16);
}

async function reporterHash(req: Request): Promise<string> {
  const ip = req.headers.get('CF-Connecting-IP') ?? 'unknown';
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip + 'radar-salt'));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

// GET /api/reports?swlat=&swlng=&nelat=&nelng=
reports.get('/', async (c) => {
  const { swlat, swlng, nelat, nelng } = c.req.query();
  if (!swlat || !swlng || !nelat || !nelng) {
    return c.json({ error: 'bounds required: swlat, swlng, nelat, nelng' }, 400);
  }

  const now = Date.now();
  const rows = await c.env.DB.prepare(`
    SELECT id, lat, lng, type, description, confirms, denies, created_at, expires_at
    FROM reports
    WHERE lat BETWEEN ? AND ?
      AND lng BETWEEN ? AND ?
      AND expires_at > ?
      AND (denies - confirms) < ?
    ORDER BY created_at DESC
    LIMIT 200
  `).bind(
    parseFloat(swlat), parseFloat(nelat),
    parseFloat(swlng), parseFloat(nelng),
    now, DENY_THRESHOLD
  ).all<Report>();

  return c.json(rows.results);
});

// POST /api/reports
reports.post('/', async (c) => {
  const body = await c.req.json<Partial<Report>>();
  const { lat, lng, type = 'police', description } = body;

  if (lat == null || lng == null) return c.json({ error: 'lat and lng required' }, 400);
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return c.json({ error: 'invalid coordinates' }, 400);

  const validTypes = ['police', 'speed_trap', 'accident', 'hazard'];
  if (!validTypes.includes(type)) return c.json({ error: 'invalid type' }, 400);

  const hash = await reporterHash(c.req.raw);
  const now = Date.now();

  // Rate limit: 1 report per IP per 5 minutes in same area
  const recent = await c.env.DB.prepare(`
    SELECT COUNT(*) as cnt FROM reports
    WHERE reporter_hash = ? AND created_at > ?
  `).bind(hash, now - 5 * 60 * 1000).first<{ cnt: number }>();

  if (recent && recent.cnt >= 3) return c.json({ error: 'too many reports, slow down' }, 429);

  const id = nanoid();
  const histId = nanoid();

  await c.env.DB.batch([
    c.env.DB.prepare(`
      INSERT INTO reports (id, lat, lng, type, description, confirms, denies, created_at, expires_at, reporter_hash)
      VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, ?)
    `).bind(id, lat, lng, type, description ?? null, now, now + REPORT_TTL_MS, hash),
    c.env.DB.prepare(`
      INSERT INTO report_history (id, lat, lng, type, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).bind(histId, lat, lng, type, now),
  ]);

  return c.json({ id, expires_at: now + REPORT_TTL_MS }, 201);
});

// POST /api/reports/:id/confirm
reports.post('/:id/confirm', async (c) => {
  const { id } = c.req.param();
  const result = await c.env.DB.prepare(
    'UPDATE reports SET confirms = confirms + 1 WHERE id = ? AND expires_at > ?'
  ).bind(id, Date.now()).run();

  if (!result.meta.changes) return c.json({ error: 'report not found or expired' }, 404);
  return c.json({ ok: true });
});

// POST /api/reports/:id/deny
reports.post('/:id/deny', async (c) => {
  const { id } = c.req.param();
  const result = await c.env.DB.prepare(
    'UPDATE reports SET denies = denies + 1 WHERE id = ? AND expires_at > ?'
  ).bind(id, Date.now()).run();

  if (!result.meta.changes) return c.json({ error: 'report not found or expired' }, 404);
  return c.json({ ok: true });
});

export default reports;
