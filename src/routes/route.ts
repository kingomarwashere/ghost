import { Hono } from 'hono';
import type { Env } from '../types';
import { getUser } from './auth';

const route = new Hono<{ Bindings: Env }>();

route.post('/', async (c) => {
  let body: { locations?: Array<{ lon: number; lat: number }> } | null = null;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid json' }, 400); }

  const resp = await fetch('https://valhalla1.openstreetmap.de/route', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const data = await resp.json();
  if (!resp.ok) return c.json({ error: 'routing failed', detail: data }, 502);

  // Log asynchronously — don't block the response
  c.executionCtx.waitUntil((async () => {
    try {
      const locs = body?.locations ?? [];
      const from = locs[0];
      const to   = locs[locs.length - 1];
      if (!from || !to || locs.length < 2) return;

      let userId: string | null = null;
      const token = c.req.header('Authorization')?.replace('Bearer ', '');
      if (token) {
        const user = await getUser(c.env.DB, token) as { id: string } | null;
        userId = user?.id ?? null;
      }

      const id = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
      await c.env.DB.prepare(
        'INSERT INTO route_logs (id, from_lat, from_lng, to_lat, to_lng, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).bind(id, from.lat, from.lon, to.lat, to.lon, userId, Date.now()).run();
    } catch { /* non-critical */ }
  })());

  return c.json(data);
});

export default route;
