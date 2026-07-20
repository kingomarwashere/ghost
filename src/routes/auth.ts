import { Hono } from 'hono';
import type { Env } from '../types';

const auth = new Hono<{ Bindings: Env }>();

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Gamertag: 3–16 chars, letters/numbers/underscores/hyphens only
const GAMERTAG_RE = /^[a-zA-Z0-9_-]{3,16}$/;

async function hashPassword(password: string, salt: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(salt), iterations: 100_000, hash: 'SHA-256' },
    key, 256,
  );
  return btoa(String.fromCharCode(...new Uint8Array(bits)));
}

function nanoid(len = 16): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, len);
}

async function getUser(db: D1Database, token: string) {
  const sess = await db.prepare(
    'SELECT user_id FROM sessions WHERE token = ? AND expires_at > ?'
  ).bind(token, Date.now()).first<{ user_id: string }>();
  if (!sess) return null;

  const user = await db.prepare(
    'SELECT id, username, email, score, created_at, last_seen FROM users WHERE id = ?'
  ).bind(sess.user_id).first();
  return user ?? null;
}

export { getUser };

// POST /api/auth/register
auth.post('/register', async (c) => {
  const body = await c.req.json<{ username?: string; email?: string; password?: string }>();
  const { username, email, password } = body;

  if (!username || !email || !password)
    return c.json({ error: 'username, email and password required' }, 400);
  if (!GAMERTAG_RE.test(username))
    return c.json({ error: 'username must be 3–16 chars: letters, numbers, _ or -' }, 400);
  if (!email.includes('@'))
    return c.json({ error: 'invalid email' }, 400);
  if (password.length < 6)
    return c.json({ error: 'password must be at least 6 characters' }, 400);

  const existing = await c.env.DB.prepare(
    'SELECT id FROM users WHERE username = ? OR email = ? LIMIT 1'
  ).bind(username, email.toLowerCase()).first();
  if (existing) return c.json({ error: 'username or email already taken' }, 409);

  const salt = nanoid(32);
  const hash = await hashPassword(password, salt);
  const id = nanoid();
  const now = Date.now();
  const token = nanoid(48);

  await c.env.DB.batch([
    c.env.DB.prepare(
      'INSERT INTO users (id, username, email, password_hash, salt, score, created_at, last_seen) VALUES (?, ?, ?, ?, ?, 0, ?, ?)'
    ).bind(id, username, email.toLowerCase(), hash, salt, now, now),
    c.env.DB.prepare(
      'INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
    ).bind(token, id, now, now + SESSION_TTL_MS),
  ]);

  return c.json({ token, user: { id, username, email: email.toLowerCase(), score: 0, created_at: now } }, 201);
});

// POST /api/auth/login
auth.post('/login', async (c) => {
  const body = await c.req.json<{ login?: string; password?: string }>();
  const { login, password } = body; // login = email or username

  if (!login || !password) return c.json({ error: 'login and password required' }, 400);

  const user = await c.env.DB.prepare(
    'SELECT id, username, email, password_hash, salt, score FROM users WHERE email = ? OR username = ? LIMIT 1'
  ).bind(login.toLowerCase(), login).first<{
    id: string; username: string; email: string; password_hash: string; salt: string; score: number;
  }>();

  if (!user) return c.json({ error: 'invalid credentials' }, 401);

  const hash = await hashPassword(password, user.salt);
  if (hash !== user.password_hash) return c.json({ error: 'invalid credentials' }, 401);

  const token = nanoid(48);
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare(
      'INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
    ).bind(token, user.id, now, now + SESSION_TTL_MS),
    c.env.DB.prepare('UPDATE users SET last_seen = ? WHERE id = ?').bind(now, user.id),
  ]);

  return c.json({
    token,
    user: { id: user.id, username: user.username, email: user.email, score: user.score },
  });
});

// GET /api/auth/me
auth.get('/me', async (c) => {
  const token = c.req.header('Authorization')?.replace('Bearer ', '');
  if (!token) return c.json({ error: 'unauthorized' }, 401);
  const user = await getUser(c.env.DB, token);
  if (!user) return c.json({ error: 'invalid or expired session' }, 401);
  return c.json(user);
});

// POST /api/auth/score — bank a completed trip's score onto the account total
auth.post('/score', async (c) => {
  const token = c.req.header('Authorization')?.replace('Bearer ', '');
  if (!token) return c.json({ error: 'unauthorized' }, 401);
  const sess = await c.env.DB.prepare(
    'SELECT user_id FROM sessions WHERE token = ? AND expires_at > ?'
  ).bind(token, Date.now()).first<{ user_id: string }>();
  if (!sess) return c.json({ error: 'invalid or expired session' }, 401);

  const b = await c.req.json<{ score?: number; stars?: number; distance_km?: number }>()
    .catch(() => ({} as { score?: number; stars?: number; distance_km?: number }));
  const add   = Math.max(0, Math.floor(Number(b.score) || 0));
  const stars = Math.max(0, Math.min(5, Math.floor(Number(b.stars) || 0)));
  const dist  = Math.max(0, Number(b.distance_km) || 0);

  await c.env.DB.prepare(
    `UPDATE users SET score = score + ?, trips = COALESCE(trips,0) + 1,
       distance_km = COALESCE(distance_km,0) + ?, high_stars = MAX(COALESCE(high_stars,0), ?),
       last_seen = ? WHERE id = ?`
  ).bind(add, parseFloat(dist.toFixed(2)), stars, Date.now(), sess.user_id).run();

  const user = await c.env.DB.prepare(
    'SELECT username, score, trips, distance_km, high_stars FROM users WHERE id = ?'
  ).bind(sess.user_id).first();
  return c.json({ ok: true, added: add, user });
});

// DELETE /api/auth/logout
auth.delete('/logout', async (c) => {
  const token = c.req.header('Authorization')?.replace('Bearer ', '');
  if (token) await c.env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
  return c.json({ ok: true });
});

export default auth;
