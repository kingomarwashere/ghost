import { describe, it, expect } from 'vitest';
import { normalizeFuel } from '../../src/routes/fuel';

const data = {
  stations: [
    { code: '1', brand: 'Shell', name: 'Shell Redfern', location: { latitude: -33.892, longitude: 151.204 } },
    { code: '2', brand: 'BP', name: 'BP Surry Hills', location: { latitude: -33.885, longitude: 151.211 } },
    { code: '3', brand: 'Ampol', name: 'No price here', location: { latitude: -33.870, longitude: 151.210 } },
  ],
  prices: [
    { stationcode: '1', fueltype: 'U91', price: 189.9, lastupdated: 'x' },
    { stationcode: '2', fueltype: 'U91', price: 179.5, lastupdated: 'y' },
    { stationcode: '2', fueltype: 'DL', price: 199.0, lastupdated: 'y' }, // wrong fuel type — ignored
  ],
};

describe('normalizeFuel', () => {
  const r = normalizeFuel(data, 'U91', -33.87, 151.21);
  it('joins prices to stations by code and filters by fuel type', () => {
    expect(r.find(s => s.brand === 'Shell')?.price).toBe(189.9);
    expect(r.find(s => s.brand === 'BP')?.price).toBe(179.5);
    expect(r.find(s => s.brand === 'Ampol')?.price).toBeNull();
  });
  it('sorts nearest first', () => {
    // query point -33.87,151.21: Ampol ~0m, BP ~1.7km, Shell ~2.5km
    expect(r.map(s => s.brand)).toEqual(['Ampol', 'BP', 'Shell']);
    expect(r[0].dist).toBeLessThanOrEqual(r[1].dist);
    expect(r[1].dist).toBeLessThanOrEqual(r[2].dist);
  });
  it('computes distance from the query point', () => {
    expect(r.every(s => typeof s.dist === 'number' && s.dist >= 0)).toBe(true);
  });
  it('is safe on empty/absent input', () => {
    expect(normalizeFuel(null, 'U91', 0, 0)).toEqual([]);
    expect(normalizeFuel({ stations: [] }, 'U91', 0, 0)).toEqual([]);
  });
});
