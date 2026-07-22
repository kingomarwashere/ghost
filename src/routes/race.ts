// ─── RACE MODE ───────────────────────────────────────────────────────────────
// Two (or more) players link up via a 4-char code and race to the same finish.
// D1-backed, polled by clients. Schema is created lazily (no manual migration).

import { Hono } from 'hono';
import type { Env } from '../types';

const race = new Hono<{ Bindings: Env }>();

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no ambiguous chars
const mkCode = () => Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
const mkId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 20);

let _schemaReady = false;
async function ensureSchema(db: Env['DB']) {
  if (_schemaReady) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS races (
      code TEXT PRIMARY KEY, host_id TEXT, dest_lat REAL, dest_lng REAL, dest_name TEXT,
      status TEXT, created_at INTEGER, started_at INTEGER, winner_id TEXT)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS race_players (
      code TEXT, player_id TEXT, name TEXT, car TEXT,
      lat REAL, lng REAL, dist REAL, eta INTEGER, finished_at INTEGER, updated_at INTEGER,
      PRIMARY KEY (code, player_id))`),
  ]);
  _schemaReady = true;
}

// POST /api/race — create a race with a finish line
race.post('/', async (c) => {
  await ensureSchema(c.env.DB);
  const b = await c.req.json().catch(() => ({} as any));
  const { dest_lat, dest_lng, dest_name, name, car } = b;
  if (dest_lat == null || dest_lng == null) return c.json({ error: 'destination required' }, 400);
  const code = mkCode(), host = mkId(), now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO races (code, host_id, dest_lat, dest_lng, dest_name, status, created_at)
                      VALUES (?, ?, ?, ?, ?, 'waiting', ?)`)
      .bind(code, host, dest_lat, dest_lng, (dest_name ?? 'Finish').slice(0, 80), now),
    c.env.DB.prepare(`INSERT INTO race_players (code, player_id, name, car, updated_at) VALUES (?, ?, ?, ?, ?)`)
      .bind(code, host, (name ?? 'Host').slice(0, 24), (car ?? '').slice(0, 24), now),
  ]);
  return c.json({ code, player_id: host, host: true });
});

// POST /api/race/:code/join — join an existing race
race.post('/:code/join', async (c) => {
  await ensureSchema(c.env.DB);
  const code = c.req.param('code').toUpperCase();
  const r = await c.env.DB.prepare(`SELECT * FROM races WHERE code = ?`).bind(code).first<any>();
  if (!r) return c.json({ error: 'race not found' }, 404);
  const b = await c.req.json().catch(() => ({} as any));
  const player = mkId(), now = Date.now();
  await c.env.DB.prepare(`INSERT OR REPLACE INTO race_players (code, player_id, name, car, updated_at) VALUES (?, ?, ?, ?, ?)`)
    .bind(code, player, (b.name ?? 'Racer').slice(0, 24), (b.car ?? '').slice(0, 24), now).run();
  return c.json({
    code, player_id: player, host: false, status: r.status, host_id: r.host_id,
    dest: { lat: r.dest_lat, lng: r.dest_lng, name: r.dest_name },
  });
});

// POST /api/race/:code/start — host drops the flag: sets a synced GO timestamp
// (a few seconds in the future) so both clients count down 3-2-1-GO together.
race.post('/:code/start', async (c) => {
  await ensureSchema(c.env.DB);
  const code = c.req.param('code').toUpperCase();
  const startAt = Date.now() + 4200; // GO moment
  await c.env.DB.prepare(`UPDATE races SET status='racing', started_at=? WHERE code=? AND (status='waiting' OR started_at IS NULL)`)
    .bind(startAt, code).run();
  const r = await c.env.DB.prepare(`SELECT started_at FROM races WHERE code=?`).bind(code).first<any>();
  return c.json({ ok: true, started_at: r?.started_at ?? startAt });
});

// POST /api/race/:code/update — push my live position/progress
race.post('/:code/update', async (c) => {
  await ensureSchema(c.env.DB);
  const code = c.req.param('code').toUpperCase();
  const b = await c.req.json().catch(() => ({} as any));
  if (!b.player_id) return c.json({ error: 'player_id required' }, 400);
  const now = Date.now();
  await c.env.DB.prepare(`UPDATE race_players SET lat=?, lng=?, dist=?, eta=?, updated_at=? WHERE code=? AND player_id=?`)
    .bind(b.lat ?? null, b.lng ?? null, b.dist ?? null, b.eta ?? null, now, code, b.player_id).run();
  if (b.finished) {
    await c.env.DB.prepare(`UPDATE race_players SET finished_at=? WHERE code=? AND player_id=? AND finished_at IS NULL`)
      .bind(now, code, b.player_id).run();
    await c.env.DB.prepare(`UPDATE races SET winner_id=?, status='done' WHERE code=? AND winner_id IS NULL`)
      .bind(b.player_id, code).run();
  }
  return c.json({ ok: true });
});

// GET /api/race/:code — full race state (players + winner)
race.get('/:code', async (c) => {
  await ensureSchema(c.env.DB);
  const code = c.req.param('code').toUpperCase();
  const r = await c.env.DB.prepare(`SELECT * FROM races WHERE code = ?`).bind(code).first<any>();
  if (!r) return c.json({ error: 'not found' }, 404);
  const players = await c.env.DB.prepare(
    `SELECT player_id, name, car, lat, lng, dist, eta, finished_at, updated_at FROM race_players WHERE code = ? ORDER BY finished_at IS NULL, finished_at, dist`
  ).bind(code).all<any>();
  return c.json({
    code, status: r.status, host_id: r.host_id, winner_id: r.winner_id, started_at: r.started_at,
    dest: { lat: r.dest_lat, lng: r.dest_lng, name: r.dest_name },
    players: players.results,
  });
});

export default race;
