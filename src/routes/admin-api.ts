import { Hono } from 'hono';
import type { Env } from '../types';

const adminApi = new Hono<{ Bindings: Env }>();

const ADMIN_PASS = 'boob';

function isAuthed(c: { req: { header: (k: string) => string | undefined } }): boolean {
  return c.req.header('x-admin-key') === ADMIN_PASS;
}

// GET /api/admin/stats
adminApi.get('/stats', async (c) => {
  if (!isAuthed(c)) return c.json({ error: 'unauthorized' }, 401);
  const now = Date.now();
  const dayAgo = now - 24 * 60 * 60 * 1000;

  const [totalReports, wazeReports, ltReports, userReports, totalUsers, routesToday, byType] = await Promise.all([
    c.env.DB.prepare("SELECT COUNT(*) as n FROM reports WHERE expires_at > ?").bind(now).first<{ n: number }>(),
    c.env.DB.prepare("SELECT COUNT(*) as n FROM reports WHERE reporter_hash = 'waze' AND expires_at > ?").bind(now).first<{ n: number }>(),
    c.env.DB.prepare("SELECT COUNT(*) as n FROM reports WHERE reporter_hash = 'livetraffic' AND expires_at > ?").bind(now).first<{ n: number }>(),
    c.env.DB.prepare("SELECT COUNT(*) as n FROM reports WHERE reporter_hash NOT IN ('waze','livetraffic') AND expires_at > ?").bind(now).first<{ n: number }>(),
    c.env.DB.prepare("SELECT COUNT(*) as n FROM users").first<{ n: number }>(),
    c.env.DB.prepare("SELECT COUNT(*) as n FROM route_logs WHERE created_at > ?").bind(dayAgo).first<{ n: number }>(),
    c.env.DB.prepare("SELECT type, reporter_hash as src, COUNT(*) as n FROM reports WHERE expires_at > ? GROUP BY type, reporter_hash ORDER BY n DESC").bind(now).all(),
  ]);

  return c.json({
    active_reports: totalReports?.n ?? 0,
    waze_reports: wazeReports?.n ?? 0,
    livetraffic_reports: ltReports?.n ?? 0,
    user_reports: userReports?.n ?? 0,
    total_users: totalUsers?.n ?? 0,
    routes_today: routesToday?.n ?? 0,
    by_type: byType.results,
  });
});

// GET /api/admin/feed?source=waze|livetraffic|all&limit=100
adminApi.get('/feed', async (c) => {
  if (!isAuthed(c)) return c.json({ error: 'unauthorized' }, 401);
  const limit = Math.min(parseInt(c.req.query('limit') ?? '200'), 500);
  const source = c.req.query('source') ?? 'all';
  const now = Date.now();

  let where = `expires_at > ${now} AND reporter_hash IN ('waze','livetraffic')`;
  if (source === 'waze') where = `expires_at > ${now} AND reporter_hash = 'waze'`;
  if (source === 'livetraffic') where = `expires_at > ${now} AND reporter_hash = 'livetraffic'`;

  const rows = await c.env.DB.prepare(`
    SELECT id, lat, lng, type, description, reporter_hash as source, confirms, denies, created_at, expires_at
    FROM reports WHERE ${where} ORDER BY created_at DESC LIMIT ?
  `).bind(limit).all();
  return c.json(rows.results);
});

// Keep old /waze alias
adminApi.get('/waze', async (c) => {
  if (!isAuthed(c)) return c.json({ error: 'unauthorized' }, 401);
  const limit = Math.min(parseInt(c.req.query('limit') ?? '200'), 500);
  const now = Date.now();
  const rows = await c.env.DB.prepare(`
    SELECT id, lat, lng, type, description, reporter_hash as source, confirms, denies, created_at, expires_at
    FROM reports WHERE reporter_hash IN ('waze','livetraffic') AND expires_at > ?
    ORDER BY created_at DESC LIMIT ?
  `).bind(now, limit).all();
  return c.json(rows.results);
});

// GET /api/admin/reports?limit=100
adminApi.get('/reports', async (c) => {
  if (!isAuthed(c)) return c.json({ error: 'unauthorized' }, 401);
  const limit = Math.min(parseInt(c.req.query('limit') ?? '100'), 500);
  const rows = await c.env.DB.prepare(`
    SELECT id, lat, lng, type, description, confirms, denies, created_at, expires_at, reporter_hash
    FROM reports
    WHERE reporter_hash != 'waze'
    ORDER BY created_at DESC
    LIMIT ?
  `).bind(limit).all();
  return c.json(rows.results);
});

// GET /api/admin/routes?limit=100
adminApi.get('/routes', async (c) => {
  if (!isAuthed(c)) return c.json({ error: 'unauthorized' }, 401);
  const limit = Math.min(parseInt(c.req.query('limit') ?? '100'), 500);
  const rows = await c.env.DB.prepare(`
    SELECT rl.id, rl.from_lat, rl.from_lng, rl.to_lat, rl.to_lng, rl.created_at,
           u.username
    FROM route_logs rl
    LEFT JOIN users u ON u.id = rl.user_id
    ORDER BY rl.created_at DESC
    LIMIT ?
  `).bind(limit).all();
  return c.json(rows.results);
});

// GET /api/admin/users?limit=100
adminApi.get('/users', async (c) => {
  if (!isAuthed(c)) return c.json({ error: 'unauthorized' }, 401);
  const limit = Math.min(parseInt(c.req.query('limit') ?? '100'), 500);
  const rows = await c.env.DB.prepare(`
    SELECT id, username, email, score, created_at, last_seen
    FROM users
    ORDER BY created_at DESC
    LIMIT ?
  `).bind(limit).all();
  return c.json(rows.results);
});

// GET /api/admin/history?limit=200  (heatmap history)
adminApi.get('/history', async (c) => {
  if (!isAuthed(c)) return c.json({ error: 'unauthorized' }, 401);
  const limit = Math.min(parseInt(c.req.query('limit') ?? '200'), 1000);
  const rows = await c.env.DB.prepare(`
    SELECT type, COUNT(*) as n FROM report_history GROUP BY type ORDER BY n DESC
  `).all();
  const recent = await c.env.DB.prepare(`
    SELECT id, lat, lng, type, created_at FROM report_history ORDER BY created_at DESC LIMIT ?
  `).bind(limit).all();
  return c.json({ by_type: rows.results, recent: recent.results });
});

export default adminApi;
