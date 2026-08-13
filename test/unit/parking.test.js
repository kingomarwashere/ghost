const { parkFresh, parkedAgo } = require('../../public/lib/parking.js');

const NOW = 1_700_000_000_000;
const HOUR = 3600e3, DAY = 86400e3, TTL = 7 * DAY;

describe('parkFresh', () => {
  it('accepts a valid, recent record', () => {
    expect(parkFresh({ lat: -33.8, lng: 151.2, ts: NOW - HOUR }, TTL, NOW)).toBe(true);
  });
  it('accepts a record with no timestamp (never expires)', () => {
    expect(parkFresh({ lat: -33.8, lng: 151.2 }, TTL, NOW)).toBe(true);
  });
  it('rejects a record older than the TTL', () => {
    expect(parkFresh({ lat: -33.8, lng: 151.2, ts: NOW - 8 * DAY }, TTL, NOW)).toBe(false);
  });
  it('rejects null / missing / non-numeric coords', () => {
    expect(parkFresh(null, TTL, NOW)).toBe(false);
    expect(parkFresh({}, TTL, NOW)).toBe(false);
    expect(parkFresh({ lat: '-33.8', lng: 151.2 }, TTL, NOW)).toBe(false);
  });
});

describe('parkedAgo', () => {
  it('reads recent times', () => {
    expect(parkedAgo(NOW - 30e3, NOW)).toBe('just now');
    expect(parkedAgo(NOW - 12 * 60e3, NOW)).toBe('12 min ago');
    expect(parkedAgo(NOW - 3 * HOUR, NOW)).toBe('3 hr ago');
    expect(parkedAgo(NOW - 2 * DAY, NOW)).toBe('2 d ago');
  });
  it('handles a missing timestamp', () => {
    expect(parkedAgo(0, NOW)).toBe('here');
  });
});
