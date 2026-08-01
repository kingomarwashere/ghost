const rm = require('../../public/lib/route-match.js');
const { matchRouteIdx, buildRouteCumDist, posToProgressM, progressMToPos, routeSyncNeeded } = rm;
const { haversine } = require('../../public/lib/geo.js');

// A straight ~1km northbound line, 0.001° (~111m) between vertices.
const route = Array.from({ length: 11 }, (_, i) => [-33.80 - i * 0.001, 151.0]);
const cum = buildRouteCumDist(route);

describe('buildRouteCumDist', () => {
  it('starts at 0 and increases monotonically', () => {
    expect(cum[0]).toBe(0);
    for (let i = 1; i < cum.length; i++) expect(cum[i]).toBeGreaterThan(cum[i - 1]);
  });
  it('total length matches the sum of segments', () => {
    let sum = 0;
    for (let i = 1; i < route.length; i++) sum += haversine(route[i - 1][0], route[i - 1][1], route[i][0], route[i][1]);
    expect(cum[cum.length - 1]).toBeCloseTo(sum, 3);
  });
});

describe('matchRouteIdx', () => {
  it('returns Infinity distance for an empty route', () => {
    expect(matchRouteIdx([], 0, -33.8, 151.0).dist).toBe(Infinity);
  });
  it('snaps to the nearest forward vertex', () => {
    const { idx } = matchRouteIdx(route, 0, -33.8049, 151.0);
    expect(idx).toBe(5);
  });
  it('advances as the car moves along the route', () => {
    let last = 0;
    for (let i = 0; i < route.length; i++) {
      const { idx } = matchRouteIdx(route, last, route[i][0], route[i][1]);
      expect(idx).toBeGreaterThanOrEqual(last);
      last = idx;
    }
    expect(last).toBe(route.length - 1);
  });
  it('falls back to a global scan when far off the forward window', () => {
    // Sitting exactly on the last vertex but with a stale early cursor.
    const { idx } = matchRouteIdx(route, 0, route[10][0], route[10][1]);
    expect(idx).toBe(10);
  });
});

describe('progressMToPos / posToProgressM', () => {
  it('clamps before the start', () => {
    expect(progressMToPos(route, cum, -50)).toMatchObject({ idx: 0 });
  });
  it('clamps past the end', () => {
    expect(progressMToPos(route, cum, cum[cum.length - 1] + 999)).toMatchObject({ idx: route.length - 1 });
  });
  it('interpolates the midpoint of a segment', () => {
    const midM = (cum[3] + cum[4]) / 2;
    const p = progressMToPos(route, cum, midM);
    expect(p.idx).toBe(3);
    expect(p.lat).toBeCloseTo((route[3][0] + route[4][0]) / 2, 5);
  });
  it('round-trips position → metres → position', () => {
    const m = posToProgressM(route, cum, 4, route[4][0], route[4][1]);
    expect(m).toBeCloseTo(cum[4], 2);
  });
});

describe('routeSyncNeeded (lag throttle)', () => {
  it('always draws on the first frame', () => {
    expect(routeSyncNeeded(null, 0, null, null, -33.8, 151.0, 8)).toBe(true);
  });
  it('redraws when the matched vertex advances', () => {
    expect(routeSyncNeeded(3, 4, -33.8, 151.0, -33.8, 151.0, 8)).toBe(true);
  });
  it('skips a sub-threshold move within the same vertex', () => {
    // ~1m north, same index → no redraw
    expect(routeSyncNeeded(3, 3, -33.80000, 151.0, -33.80001, 151.0, 8)).toBe(false);
  });
  it('redraws once the car has moved past the distance threshold', () => {
    // ~22m north, same index → redraw
    expect(routeSyncNeeded(3, 3, -33.80000, 151.0, -33.80020, 151.0, 8)).toBe(true);
  });
});
