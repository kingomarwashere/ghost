import { Hono } from 'hono';
import type { Env } from '../types';
import { getUser } from './auth';

// Synced saved places (friends' addresses) for the logged-in user.
const places = new Hono<{ Bindings: Env }>();

async function userId(c: any): Promise<string | null> {
  const token = c.req.header('Authorization')?.replace('Bearer ', '');
  if (!token) return null;
  const u = await getUser(c.env.DB, token) as { user_id: string } | null;
  return u?.user_id ?? null;
}

places.get('/', async (c) => {
  const uid = await userId(c);
  if (!uid) return c.json({ error: 'unauthorized' }, 401);
  const rows = await c.env.DB.prepare(
    'SELECT id, kind, name, sub, lat, lng, emoji, created_at FROM saved_places WHERE user_id = ? ORDER BY created_at DESC'
  ).bind(uid).all();
  return c.json(rows.results ?? []);
});

places.post('/', async (c) => {
  const uid = await userId(c);
  if (!uid) return c.json({ error: 'unauthorized' }, 401);
  const b = await c.req.json().catch(() => null) as any;
  if (!b || typeof b.lat !== 'number' || typeof b.lng !== 'number' || !b.name) return c.json({ error: 'bad request' }, 400);
  const cnt = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM saved_places WHERE user_id = ?').bind(uid).first<{ n: number }>();
  if ((cnt?.n ?? 0) >= 100) return c.json({ error: 'limit reached' }, 409);
  const id = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  await c.env.DB.prepare(
    'INSERT INTO saved_places (id, user_id, kind, name, sub, lat, lng, emoji, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(id, uid, String(b.kind || 'friend'), String(b.name).slice(0, 80), String(b.sub || '').slice(0, 120), b.lat, b.lng, String(b.emoji || '').slice(0, 8), Date.now()).run();
  return c.json({ id }, 201);
});

places.delete('/:id', async (c) => {
  const uid = await userId(c);
  if (!uid) return c.json({ error: 'unauthorized' }, 401);
  await c.env.DB.prepare('DELETE FROM saved_places WHERE id = ? AND user_id = ?').bind(c.req.param('id'), uid).run();
  return c.json({ ok: true });
});

export default places;
