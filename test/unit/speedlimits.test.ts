import { describe, it, expect } from 'vitest';
import { mapWays } from '../../src/routes/speedlimits';

const geom = [{ lat: -33.87, lon: 151.20 }, { lat: -33.871, lon: 151.201 }];

describe('mapWays', () => {
  it('reads a numeric maxspeed', () => {
    expect(mapWays([{ geometry: geom, tags: { maxspeed: '50', highway: 'residential' } }])[0].limit).toBe(50);
  });
  it('reads an AU maxspeed tag', () => {
    expect(mapWays([{ geometry: geom, tags: { maxspeed: 'AU:urban', highway: 'primary' } }])[0].limit).toBe(50);
    expect(mapWays([{ geometry: geom, tags: { maxspeed: 'AU:motorway', highway: 'motorway' } }])[0].limit).toBe(110);
  });
  it('falls back to the road-class default when maxspeed is absent', () => {
    expect(mapWays([{ geometry: geom, tags: { highway: 'residential' } }])[0].limit).toBe(50);
    expect(mapWays([{ geometry: geom, tags: { highway: 'motorway' } }])[0].limit).toBe(100);
    expect(mapWays([{ geometry: geom, tags: { highway: 'tertiary' } }])[0].limit).toBe(60);
  });
  it('maps coords to [lat,lng] pairs', () => {
    expect(mapWays([{ geometry: geom, tags: { maxspeed: '60' } }])[0].coords).toEqual([[-33.87, 151.20], [-33.871, 151.201]]);
  });
  it('skips ways with no geometry or no resolvable limit', () => {
    expect(mapWays([{ tags: { maxspeed: '50' } }])).toHaveLength(0);           // no geometry
    expect(mapWays([{ geometry: geom, tags: { highway: 'footway' } }])).toHaveLength(0); // no default, no maxspeed
    expect(mapWays([])).toHaveLength(0);
  });
});
