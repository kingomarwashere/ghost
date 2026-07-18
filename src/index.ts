import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from './types';
import reports from './routes/reports';
import cameras from './routes/cameras';
import seed from './routes/seed';
import route from './routes/route';
import leaderboard from './routes/leaderboard';

const app = new Hono<{ Bindings: Env }>();

app.use('*', cors({ origin: '*' }));

app.route('/api/reports', reports);
app.route('/api/cameras', cameras);
app.route('/api/admin/seed', seed);
app.route('/api/route', route);
app.route('/api/leaderboard', leaderboard);

app.get('/api/health', (c) => c.json({ ok: true, ts: Date.now() }));

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

export default app;
