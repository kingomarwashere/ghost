import { Hono } from 'hono';
import type { Env } from '../types';

const leaderboard = new Hono<{ Bindings: Env }>();

// Cumulative account leaderboard — ranks registered users by lifetime score.
leaderboard.get('/', async (c) => {
  const rows = await c.env.DB.prepare(`
    SELECT username AS nickname, score,
           COALESCE(high_stars,0) AS stars_reached,
           COALESCE(trips,0) AS trips,
           COALESCE(distance_km,0) AS distance_km,
           created_at
    FROM users WHERE score > 0 ORDER BY score DESC LIMIT 25
  `).all();
  return c.json(rows.results);
});

leaderboard.post('/', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body?.nickname || !body?.score) return c.json({ error: 'nickname and score required' }, 400);
  const nick = String(body.nickname).slice(0, 20).replace(/[^\w\s]/g, '').trim() || 'Driver';
  const id = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  await c.env.DB.prepare(
    `INSERT INTO leaderboard (id, nickname, score, stars_reached, distance_km, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(id, nick, Math.floor(body.score), body.stars_reached ?? 0,
         parseFloat((body.distance_km ?? 0).toFixed(2)), Date.now()).run();
  return c.json({ ok: true, id });
});

export default leaderboard;
