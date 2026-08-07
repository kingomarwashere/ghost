import { Hono } from 'hono';
import type { Env } from '../types';
import { getUser } from './auth';

const route = new Hono<{ Bindings: Env }>();

// Routing upstreams tried in order. Our self-hosted Valhalla (Adelaide, secret-gated)
// is primary: it's in-country and unshared, so it answers in well under a second and
// gets a short timeout. The public OSM mirrors stay as fallback for when our box is
// down/rebuilding — they're in Germany and shared, hence the generous 12s ceiling.
interface Upstream { url: string; timeoutMs: number; secret?: boolean }
const ROUTE_UPSTREAMS: Upstream[] = [
  { url: 'https://ghost-valhalla.theradicalparty.com/route', timeoutMs: 5_000, secret: true },
  { url: 'https://valhalla1.openstreetmap.de/route', timeoutMs: 12_000 },
  { url: 'https://valhalla.openstreetmap.de/route', timeoutMs: 12_000 },
];

// Fetch a route, trying each upstream in order with retry/backoff. A valid Valhalla
// response MUST carry a decodable trip; a 200 with no trip is treated as a failure so
// a flaky upstream can't hand the client an un-navigable route.
async function fetchRoute(
  payload: string,
  secret?: string,
): Promise<{ ok: true; data: any } | { ok: false; status: number; detail: any }> {
  let lastDetail: any = 'no upstream reached';
  for (let i = 0; i < ROUTE_UPSTREAMS.length; i++) {
    const up = ROUTE_UPSTREAMS[i];
    // Skip the secret-gated primary if we have no secret configured — it would just 403.
    if (up.secret && !secret) continue;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (up.secret && secret) headers['X-Ghost-Secret'] = secret;
    try {
      const resp = await fetch(up.url, {
        method: 'POST',
        headers,
        body: payload,
        signal: AbortSignal.timeout(up.timeoutMs),
      });
      const data: any = await resp.json().catch(() => null);
      if (resp.ok && data && data.trip && Array.isArray(data.trip.legs) && data.trip.legs[0]?.shape) {
        return { ok: true, data };
      }
      lastDetail = data ?? `upstream ${resp.status}`;
      // 4xx that isn't rate-limiting (e.g. unroutable locations) won't improve on
      // retry — surface it immediately. (Our gateway's 403 is excluded: fall through
      // to the public mirrors instead of failing the whole request.)
      if (resp.status >= 400 && resp.status < 500 && resp.status !== 429 && resp.status !== 403) {
        return { ok: false, status: 422, detail: lastDetail };
      }
    } catch (e: any) {
      lastDetail = e?.name === 'TimeoutError' ? 'upstream timeout' : (e?.message ?? 'fetch error');
    }
    // Backoff before the next upstream: 250ms, 600ms.
    if (i < ROUTE_UPSTREAMS.length - 1) await new Promise(r => setTimeout(r, 250 + i * 350));
  }
  return { ok: false, status: 502, detail: lastDetail };
}

route.post('/', async (c) => {
  let body: { locations?: Array<{ lon: number; lat: number }> } | null = null;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid json' }, 400); }
  if (!body?.locations || body.locations.length < 2) return c.json({ error: 'need at least 2 locations' }, 400);

  const result = await fetchRoute(JSON.stringify(body), c.env.VALHALLA_SECRET);
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
