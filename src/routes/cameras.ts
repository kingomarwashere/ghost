import { Hono } from 'hono';
import type { Env, Camera } from '../types';

const cameras = new Hono<{ Bindings: Env }>();

// GET /api/cameras?swlat=&swlng=&nelat=&nelng=&type=
cameras.get('/', async (c) => {
  const { swlat, swlng, nelat, nelng, type } = c.req.query();
  if (!swlat || !swlng || !nelat || !nelng) {
    return c.json({ error: 'bounds required: swlat, swlng, nelat, nelng' }, 400);
  }

  let query = `
    SELECT id, lat, lng, type, source, description, state, road, speed_limit, direction
    FROM cameras
    WHERE lat BETWEEN ? AND ?
      AND lng BETWEEN ? AND ?
  `;
  const params: (string | number)[] = [
    parseFloat(swlat), parseFloat(nelat),
    parseFloat(swlng), parseFloat(nelng),
  ];

  if (type) {
    query += ' AND type = ?';
    params.push(type);
  }

  query += ' ORDER BY lat LIMIT 500';

  const rows = await c.env.DB.prepare(query).bind(...params).all<Camera>();
  return c.json(rows.results);
});

// GET /api/cameras/stats
cameras.get('/stats', async (c) => {
  const row = await c.env.DB.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN type = 'speed' THEN 1 ELSE 0 END) as speed,
      SUM(CASE WHEN type = 'red_light' THEN 1 ELSE 0 END) as red_light,
      SUM(CASE WHEN type = 'average_speed' THEN 1 ELSE 0 END) as average_speed,
      SUM(CASE WHEN source = 'osm' THEN 1 ELSE 0 END) as from_osm,
      SUM(CASE WHEN source = 'gov' THEN 1 ELSE 0 END) as from_gov
    FROM cameras
  `).first();
  return c.json(row);
});

export default cameras;
