import { Hono } from 'hono';
import type { Env } from '../types';

const cw = new Hono<{ Bindings: Env }>();

// GET reports in map bounds
cw.get('/', async (c) => {
  const { swlat, swlng, nelat, nelng, plate } = c.req.query();
  let rows;
  if (plate) {
    rows = await c.env.DB.prepare(
      `SELECT id,plate,photo_key,lat,lng,description,report_type,confirms,created_at
       FROM cop_watch WHERE plate LIKE ? ORDER BY created_at DESC LIMIT 50`
    ).bind(`%${plate.toUpperCase()}%`).all();
  } else if (swlat) {
    rows = await c.env.DB.prepare(
      `SELECT id,plate,photo_key,lat,lng,description,report_type,confirms,created_at
       FROM cop_watch
       WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?
         AND created_at > ?
       ORDER BY created_at DESC LIMIT 100`
    ).bind(+swlat, +nelat, +swlng, +nelng, Date.now() - 7 * 86400_000).all();
  } else {
    rows = await c.env.DB.prepare(
      `SELECT id,plate,photo_key,lat,lng,description,report_type,confirms,created_at
       FROM cop_watch ORDER BY created_at DESC LIMIT 50`
    ).all();
  }
  return c.json(rows.results);
});

// POST submit report (multipart: fields + optional photo)
cw.post('/', async (c) => {
  const form = await c.req.formData();
  const lat  = parseFloat(form.get('lat') as string);
  const lng  = parseFloat(form.get('lng') as string);
  if (isNaN(lat) || isNaN(lng)) return c.json({ error: 'lat/lng required' }, 400);

  const plate       = ((form.get('plate') as string) ?? '').toUpperCase().trim().slice(0, 10);
  const description = ((form.get('description') as string) ?? '').slice(0, 500);
  const report_type = (form.get('report_type') as string) ?? 'sighting';
  const id = crypto.randomUUID().replace(/-/g,'').slice(0, 16);

  // Hash the CF-Connecting-IP for anonymous deduplication
  const ip = c.req.header('CF-Connecting-IP') ?? 'unknown';
  const enc = new TextEncoder().encode(ip + id);
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', enc)))
    .slice(0,8).map(b => b.toString(16).padStart(2,'0')).join('');

  // Upload photo if present
  let photo_key: string | null = null;
  const photo = form.get('photo') as File | null;
  if (photo && photo.size > 0 && photo.size < 8 * 1024 * 1024) {
    photo_key = `cw/${id}.jpg`;
    await c.env.PHOTOS.put(photo_key, photo.stream(), {
      httpMetadata: { contentType: 'image/jpeg' },
    });
  }

  await c.env.DB.prepare(
    `INSERT INTO cop_watch (id,plate,photo_key,lat,lng,description,report_type,confirms,reporter_hash,created_at)
     VALUES (?,?,?,?,?,?,?,0,?,?)`
  ).bind(id, plate||null, photo_key, lat, lng, description||null, report_type, hash, Date.now()).run();

  const pts = 150 + (photo_key ? 200 : 0);
  return c.json({ ok: true, id, pts, hasPhoto: !!photo_key });
});

// GET photo from R2
cw.get('/photo/:key{.+}', async (c) => {
  const key = 'cw/' + c.req.param('key');
  const obj = await c.env.PHOTOS.get(key);
  if (!obj) return c.json({ error: 'not found' }, 404);
  return new Response(obj.body, {
    headers: {
      'Content-Type': 'image/jpeg',
      'Cache-Control': 'public, max-age=86400',
    },
  });
});

// POST confirm a report
cw.post('/:id/confirm', async (c) => {
  const { id } = c.req.param();
  await c.env.DB.prepare(`UPDATE cop_watch SET confirms=confirms+1 WHERE id=?`).bind(id).run();
  return c.json({ ok: true, pts: 50 });
});

export default cw;
