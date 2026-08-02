import { Hono } from 'hono';
import type { Env } from '../types';
import { getUser } from './auth';

// Synced saved places (friends' addresses) for the logged-in user.
const places = new Hono<{ Bindings: Env }>();

async function userId(c: any): Promise<string | null> {
  const token = c.req.header('Authorization')?.replace('Bearer ', '');
  if (!token) return null;
  const u = await getUser(c.env.DB, token) as { id: string } | null;
  return u?.id ?? null;
}

places.get('/', async (c) => {
  const uid = await userId(c);
  if (!uid) return c.json({ error: 'unauthorized' }, 401);
  const rows = await c.env.DB.prepare(
    'SELECT id, kind, name, sub, lat, lng, emoji, photo, created_at FROM saved_places WHERE user_id = ? ORDER BY created_at DESC'
  ).bind(uid).all();
  return c.json(rows.results ?? []);
});

// Cap a photo data URL: only accept a reasonable small image (a ~160px JPEG is
// ~15-25KB → ~35k chars). Reject anything oversized or not an image data URL.
function cleanPhoto(v: any): string | null {
  if (typeof v !== 'string') return null;
  if (!/^data:image\/(jpeg|png|webp);base64,/.test(v)) return null;
  if (v.length > 120000) return null;
  return v;
}

places.post('/', async (c) => {
  const uid = await userId(c);
  if (!uid) return c.json({ error: 'unauthorized' }, 401);
  const b = await c.req.json().catch(() => null) as any;
  if (!b || typeof b.lat !== 'number' || typeof b.lng !== 'number' || !b.name) return c.json({ error: 'bad request' }, 400);
  const cnt = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM saved_places WHERE user_id = ?').bind(uid).first<{ n: number }>();
  if ((cnt?.n ?? 0) >= 100) return c.json({ error: 'limit reached' }, 409);
  const id = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  await c.env.DB.prepare(
    'INSERT INTO saved_places (id, user_id, kind, name, sub, lat, lng, emoji, photo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(id, uid, String(b.kind || 'friend'), String(b.name).slice(0, 80), String(b.sub || '').slice(0, 120), b.lat, b.lng, String(b.emoji || '').slice(0, 8), cleanPhoto(b.photo), Date.now()).run();
  return c.json({ id }, 201);
});

// Update a saved contact — currently their photo (set/clear), name or emoji.
places.patch('/:id', async (c) => {
  const uid = await userId(c);
  if (!uid) return c.json({ error: 'unauthorized' }, 401);
  const b = await c.req.json().catch(() => null) as any;
  if (!b || typeof b !== 'object') return c.json({ error: 'bad request' }, 400);
  const sets: string[] = [];
  const vals: any[] = [];
  if ('photo' in b) { sets.push('photo = ?'); vals.push(b.photo === null ? null : cleanPhoto(b.photo)); }
  if (typeof b.name === 'string' && b.name.trim()) { sets.push('name = ?'); vals.push(b.name.slice(0, 80)); }
  if (typeof b.emoji === 'string') { sets.push('emoji = ?'); vals.push(b.emoji.slice(0, 8)); }
  if (!sets.length) return c.json({ error: 'nothing to update' }, 400);
  vals.push(c.req.param('id'), uid);
  const res = await c.env.DB.prepare(
    `UPDATE saved_places SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`
  ).bind(...vals).run();
  if (!res.meta.changes) return c.json({ error: 'not found' }, 404);
  return c.json({ ok: true });
});

places.delete('/:id', async (c) => {
  const uid = await userId(c);
  if (!uid) return c.json({ error: 'unauthorized' }, 401);
  await c.env.DB.prepare('DELETE FROM saved_places WHERE id = ? AND user_id = ?').bind(c.req.param('id'), uid).run();
  return c.json({ ok: true });
});

export default places;
