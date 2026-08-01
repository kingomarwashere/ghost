import { afterEach, describe, it, expect, vi } from 'vitest';
import worker from '../../src/index';
import { urlOf, jsonResponse as json, testEnv, testCtx, installCache } from './_harness';

const PHOTON_HOUSE = {
  features: [{
    properties: { housenumber: '83', street: 'Queen Street', suburb: 'Ashfield', state: 'New South Wales', osm_key: 'place', osm_value: 'house' },
    geometry: { coordinates: [151.125, -33.888] },
  }],
};
const NOM_HOUSE = [{
  lat: '-33.888', lon: '151.125', display_name: '83, Queen Street, Ashfield, NSW',
  category: 'building', type: 'house', importance: 0.3,
  address: { house_number: '83', road: 'Queen Street', suburb: 'Ashfield', state: 'New South Wales' },
}];

function get(q: string, extra = '') {
  const req = new Request(`https://ghost.test/api/search?q=${encodeURIComponent(q)}${extra}`);
  return worker.fetch(req, testEnv, testCtx());
}

// Records every outbound URL and answers photon / nominatim (free + structured).
function installGeocoderStub() {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: any) => {
    const u = urlOf(input);
    calls.push(u);
    if (u.includes('photon.komoot.io')) return json(PHOTON_HOUSE);
    if (u.includes('nominatim')) return json(NOM_HOUSE);
    return json([]);
  }));
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe('/api/search', () => {
  it('returns [] for queries shorter than 2 chars without hitting the network', async () => {
    installCache();
    const fn = vi.fn(() => json([]));
    vi.stubGlobal('fetch', fn);
    expect(await (await get('a')).json()).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });

  it('fires the structured Nominatim pass for a house-led address query', async () => {
    installCache();
    const calls = installGeocoderStub();
    const results = await (await get('83 queen st ashfield unique1', '&lat=-33.88&lon=151.12')).json() as any[];
    expect(results.some(r => r.name === '83 Queen Street' && r.house)).toBe(true);
    // The structured pass sends a `street=` field (free-text passes never do).
    expect(calls.some(u => /nominatim.*[?&]street=/.test(u))).toBe(true);
  });

  it('does NOT fire the structured pass for a plain place query', async () => {
    installCache();
    const calls = installGeocoderStub();
    await get('cafe unique2', '&lat=-33.88&lon=151.12');
    expect(calls.some(u => /[?&]street=/.test(u))).toBe(false);
    expect(calls.some(u => u.includes('photon.komoot.io'))).toBe(true);
  });

  it('de-duplicates the same civic address arriving from multiple providers', async () => {
    installCache();
    installGeocoderStub();
    const results = await (await get('83 queen st ashfield unique3', '&lat=-33.88&lon=151.12')).json() as any[];
    expect(results.filter(r => r.name === '83 Queen Street').length).toBe(1);
  });
});
