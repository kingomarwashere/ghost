import { Hono } from 'hono';
import type { Env } from '../types';
import { getUser } from './auth';

// Per-user synced preferences (currently the emoji/icon overrides) so a logged-in
// user's customisations follow them across devices and survive a cache clear.
const prefs = new Hono<{ Bindings: Env }>();

async function userId(c: any): Promise<string | null> {
  const token = c.req.header('Authorization')?.replace('Bearer ', '');
  if (!token) return null;
  const u = await getUser(c.env.DB, token) as { id: string } | null;
  return u?.id ?? null;
}

prefs.get('/', async (c) => {
  const uid = await userId(c);
  if (!uid) return c.json({ error: 'unauthorized' }, 401);
  const row = await c.env.DB.prepare('SELECT icons FROM user_prefs WHERE user_id = ?').bind(uid).first<{ icons: string }>();
  let icons: Record<string, string> = {};
  try { icons = JSON.parse(row?.icons || '{}'); } catch { /* ignore */ }
  return c.json({ icons });
});

prefs.put('/', async (c) => {
  const uid = await userId(c);
  if (!uid) return c.json({ error: 'unauthorized' }, 401);
  const b = await c.req.json().catch(() => ({})) as any;
  const icons = (b && typeof b.icons === 'object' && b.icons) ? b.icons : {};
  const json = JSON.stringify(icons).slice(0, 4000); // cap size
  await c.env.DB.prepare(
    'INSERT INTO user_prefs (user_id, icons, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET icons = excluded.icons, updated_at = excluded.updated_at'
  ).bind(uid, json, Date.now()).run();
  return c.json({ ok: true });
});

export default prefs;
