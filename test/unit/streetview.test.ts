import { describe, it, expect } from 'vitest';
import { pickNearest } from '../../src/routes/streetview';

const img = (lng: number, lat: number, url: string) => ({ geometry: { coordinates: [lng, lat] }, thumb_1024_url: url });

describe('pickNearest', () => {
  it('returns the closest image to the target', () => {
    const images = [img(151.210, -33.870, 'far'), img(151.2101, -33.8701, 'near'), img(151.300, -33.900, 'farther')];
    expect(pickNearest(images, -33.8701, 151.2101)).toBe('near');
  });
  it('falls back to the 256 thumb when no 1024', () => {
    expect(pickNearest([{ geometry: { coordinates: [151.21, -33.87] }, thumb_256_url: 'small' }], -33.87, 151.21)).toBe('small');
  });
  it('skips images without geometry', () => {
    expect(pickNearest([{ thumb_1024_url: 'x' }, img(151.21, -33.87, 'ok')], -33.87, 151.21)).toBe('ok');
  });
  it('returns null for an empty set', () => {
    expect(pickNearest([], -33.87, 151.21)).toBeNull();
  });
});
