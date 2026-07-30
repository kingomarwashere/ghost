import { Hono } from 'hono';
import type { Env } from '../types';
import { getUser } from './auth';

const route = new Hono<{ Bindings: Env }>();

// Public Valhalla mirrors. We hit them in order; if one is rate-limited (429),
// erroring (5xx) or times out, we fall through to the next before giving up.
const ROUTE_UPSTREAMS = [
  'https://valhalla1.openstreetmap.de/route',
  'https://valhalla.openstreetmap.de/route',
];
const ROUTE_TIMEOUT_MS = 12_000;
const ROUTE_ATTEMPTS = 3; // total tries across upstreams before failing

// Fetch a route with per-attempt timeout + retry/backoff across mirrors. A valid
// Valhalla response MUST carry a decodable trip; a 200 with no trip is treated as
// a failure so a flaky upstream can't hand the client an un-navigable route.
async function fetchRoute(payload: string): Promise<{ ok: true; data: any } | { ok: false; status: number; detail: any }> {
  let lastDetail: any = 'no upstream reached';
  for (let attempt = 0; attempt < ROUTE_ATTEMPTS; attempt++) {
    const url = ROUTE_UPSTREAMS[attempt % ROUTE_UPSTREAMS.length];
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        signal: AbortSignal.timeout(ROUTE_TIMEOUT_MS),
      });
      const data: any = await resp.json().catch(() => null);
      if (resp.ok && data && data.trip && Array.isArray(data.trip.legs) && data.trip.legs[0]?.shape) {
        return { ok: true, data };
      }
      lastDetail = data ?? `upstream ${resp.status}`;
      // 4xx that isn't rate-limiting (e.g. unroutable locations) won't improve on
      // retry — surface it immediately.
      if (resp.status >= 400 && resp.status < 500 && resp.status !== 429) {
        return { ok: false, status: 422, detail: lastDetail };
      }
    } catch (e: any) {
      lastDetail = e?.name === 'TimeoutError' ? 'upstream timeout' : (e?.message ?? 'fetch error');
    }
    // Backoff before the next mirror/attempt: 250ms, 600ms.
    if (attempt < ROUTE_ATTEMPTS - 1) await new Promise(r => setTimeout(r, 250 + attempt * 350));
  }
  return { ok: false, status: 502, detail: lastDetail };
}

route.post('/', async (c) => {
  let body: { locations?: Array<{ lon: number; lat: number }> } | null = null;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid json' }, 400); }
  if (!body?.locations || body.locations.length < 2) return c.json({ error: 'need at least 2 locations' }, 400);

  const result = await fetchRoute(JSON.stringify(body));
  if (!result.ok) return c.json({ error: 'routing failed', detail: result.detail }, result.status as any);
  const data = result.data;

  // Log asynchronously — don't block the response
  c.executionCtx.waitUntil((async () => {
    try {
      const locs = body?.locations ?? [];
      const from = locs[0];
      const to   = locs[locs.length - 1];
      if (!from || !to || locs.length < 2) return;

      let userId: string | null = null;
      const token = c.req.header('Authorization')?.replace('Bearer ', '');
      if (token) {
        const user = await getUser(c.env.DB, token) as { id: string } | null;
        userId = user?.id ?? null;
      }

      const id = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
      await c.env.DB.prepare(
        'INSERT INTO route_logs (id, from_lat, from_lng, to_lat, to_lng, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).bind(id, from.lat, from.lon, to.lat, to.lon, userId, Date.now()).run();
    } catch { /* non-critical */ }
  })());

  return c.json(data);
});

export default route;
