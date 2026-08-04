import { Hono } from 'hono';
import type { Env } from '../types';

// Custom vehicles pushed in from other Radical apps (e.g. Chisel's "Send to
// Ghost"): a GLB is stored in R2 under custom-cars/, a row lands in D1, and the
// client appends them to the fleet. Uploads are gated by a shared password.
const customCars = new Hono<{ Bindings: Env }>();

const MAX_BYTES = 15 * 1024 * 1024; // 15 MB — plenty for a single mesh
const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'model';

// GET /api/custom-cars — fleet additions, newest first.
customCars.get('/', async (c) => {
  const rows = await c.env.DB.prepare(
    'SELECT id, name, emoji, created_at FROM custom_cars ORDER BY created_at DESC LIMIT 200'
  ).all<{ id: string; name: string; emoji: string | null; created_at: number }>();
  return c.json(
    (rows.results ?? []).map((r) => ({
      id: r.id,
      name: r.name,
      emoji: r.emoji || '🛠️',
      model: `custom/${r.id}.glb`, // resolved by car3d.js as MODEL_DIR + file
      created_at: r.created_at,
    }))
  );
});

// POST /api/custom-cars?name=&emoji=  body: raw GLB bytes  header: x-ghost-pass
customCars.post('/', async (c) => {
  const pass = c.env.GHOST_UPLOAD_PASS || 'lickmyghost';
  if (c.req.header('x-ghost-pass') !== pass) return c.json({ error: 'wrong password' }, 401);

  const name = (c.req.query('name') || 'Chisel Model').trim().slice(0, 60);
  const emoji = (c.req.query('emoji') || '🛠️').trim().slice(0, 8);

  const body = await c.req.arrayBuffer();
  if (!body.byteLength) return c.json({ error: 'empty body' }, 400);
  if (body.byteLength > MAX_BYTES) return c.json({ error: 'model too large (15 MB max)' }, 413);
  // GLB magic number: "glTF" (0x46546C67, little-endian).
  if (new DataView(body).getUint32(0, true) !== 0x46546c67) {
    return c.json({ error: 'not a binary glTF (.glb)' }, 400);
  }

  const id = `${slug(name)}-${crypto.randomUUID().slice(0, 8)}`;
  await c.env.PHOTOS.put(`custom-cars/${id}.glb`, body, {
    httpMetadata: { contentType: 'model/gltf-binary' },
  });
  const now = Date.now();
  await c.env.DB.prepare(
    'INSERT INTO custom_cars (id, name, emoji, size, created_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(id, name, emoji, body.byteLength, now).run();

  return c.json({ ok: true, id, name, emoji, model: `custom/${id}.glb` }, 201);
});

export default customCars;
