import { Hono } from 'hono';
import type { Env } from '../types';
import { getUser } from './auth';

// Users request cars they'd like added to the fleet → shown in the admin page.
const carRequests = new Hono<{ Bindings: Env }>();

// POST /api/car-requests  { car_name, color?, notes? }  — works anonymously;
// attaches user_id when a valid Bearer token is present.
carRequests.post('/', async (c) => {
  const b = await c.req.json().catch(() => null) as any;
  const car_name = String(b?.car_name ?? '').trim().slice(0, 100);
  if (!car_name) return c.json({ error: 'car name required' }, 400);
  const color = b?.color ? String(b.color).trim().slice(0, 40) : null;
  const notes = b?.notes ? String(b.notes).trim().slice(0, 500) : null;

  let userId: string | null = null;
  const token = c.req.header('Authorization')?.replace('Bearer ', '');
  if (token) { const u = await getUser(c.env.DB, token) as { id: string } | null; userId = u?.id ?? null; }

  const id = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  const now = Date.now();
  await c.env.DB.prepare(
    'INSERT INTO car_requests (id, user_id, car_name, color, notes, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(id, userId, car_name, color, notes, 'pending', now, now).run();

  return c.json({ ok: true, id }, 201);
});

export default carRequests;
