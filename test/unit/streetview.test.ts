import { describe, it, expect } from 'vitest';
import { pickNearest } from '../../src/routes/streetview';

const img = (lng: number, lat: number, url: string) => ({ geometry: { coordinates: [lng, lat] }, thumb_1024_url: url });

describe('pickNearest', () => {
  it('returns the closest image object to the target', () => {
    const images = [img(151.210, -33.870, 'far'), img(151.2101, -33.8701, 'near'), img(151.300, -33.900, 'farther')];
    expect(pickNearest(images, -33.8701, 151.2101).thumb_1024_url).toBe('near');
  });
  it('skips images without geometry', () => {
    expect(pickNearest([{ thumb_1024_url: 'x' }, img(151.21, -33.87, 'ok')], -33.87, 151.21).thumb_1024_url).toBe('ok');
  });
  it('returns null for an empty set', () => {
    expect(pickNearest([], -33.87, 151.21)).toBeNull();
  });
});
