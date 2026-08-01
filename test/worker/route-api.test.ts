import { afterEach, describe, it, expect, vi } from 'vitest';
import worker from '../../src/index';
import { urlOf, jsonResponse as json, testEnv, testCtx } from './_harness';

const TRIP = { trip: { legs: [{ shape: 'abc', maneuvers: [] }], summary: { time: 100 } } };
const LOCS = { locations: [{ lat: -33.87, lon: 151.21 }, { lat: -33.80, lon: 151.00 }] };

function post(body: any) {
  const req = new Request('https://ghost.test/api/route', { method: 'POST', body: JSON.stringify(body) });
  return worker.fetch(req, testEnv, testCtx());
}

afterEach(() => vi.unstubAllGlobals());

describe('/api/route', () => {
  it('rejects a body without two locations', async () => {
    vi.stubGlobal('fetch', vi.fn(() => json(TRIP)));
    expect((await post({ locations: [{ lat: 1, lon: 1 }] })).status).toBe(400);
  });

  it('passes a valid Valhalla trip through', async () => {
    vi.stubGlobal('fetch', vi.fn(() => json(TRIP)));
    const res = await post(LOCS);
    expect(res.status).toBe(200);
    expect((await res.json() as any).trip.legs[0].shape).toBe('abc');
  });

  it('falls back to the second mirror on a 429', async () => {
    const fn = vi.fn((input: any) => urlOf(input).includes('valhalla1') ? json({ error: 'rate limited' }, 429) : json(TRIP));
    vi.stubGlobal('fetch', fn);
    const res = await post(LOCS);
    expect(res.status).toBe(200);
    expect(fn.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect((await res.json() as any).trip.legs[0].shape).toBe('abc');
  });

  it('surfaces an unroutable 4xx as 422 without retrying', async () => {
    const fn = vi.fn(() => json({ error: 'unroutable' }, 400));
    vi.stubGlobal('fetch', fn);
    expect((await post(LOCS)).status).toBe(422);
    expect(fn).toHaveBeenCalledTimes(1); // non-429 4xx short-circuits
  });

  it('treats a 200 with no trip as a failure (502)', async () => {
    vi.stubGlobal('fetch', vi.fn(() => json({ ok: true })));
    expect((await post(LOCS)).status).toBe(502);
  });
});
