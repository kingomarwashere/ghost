const geo = require('../../public/lib/geo.js');
const { haversine, bearing, toGL, decodePolyline6, nearestOnRoute, targetNavZoom, computeTrafficFC } = geo;

// Encode [lat,lng] pairs as a precision-6 polyline so we can round-trip the decoder.
function encode6(points) {
  let out = '', lastLat = 0, lastLng = 0;
  const enc = v => {
    v = v < 0 ? ~(v << 1) : v << 1;
    let s = '';
    while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; }
    s += String.fromCharCode(v + 63);
    return s;
  };
  for (const [lat, lng] of points) {
    const la = Math.round(lat * 1e6), lo = Math.round(lng * 1e6);
    out += enc(la - lastLat) + enc(lo - lastLng);
    lastLat = la; lastLng = lo;
  }
  return out;
}

describe('haversine', () => {
  it('is zero for identical points', () => {
    expect(haversine(-33.87, 151.21, -33.87, 151.21)).toBe(0);
  });
  it('measures ~1.11km per 0.01° of latitude', () => {
    const d = haversine(-33.80, 151.00, -33.79, 151.00);
    expect(d).toBeGreaterThan(1100);
    expect(d).toBeLessThan(1120);
  });
  it('is symmetric', () => {
    expect(haversine(-33.8, 151.0, -34.0, 151.3)).toBeCloseTo(haversine(-34.0, 151.3, -33.8, 151.0), 6);
  });
});

describe('bearing', () => {
  it('points north for a due-north step', () => {
    expect(bearing(-33.8, 151.0, -33.7, 151.0)).toBeCloseTo(0, 1);
  });
  it('points east for a due-east step', () => {
    expect(bearing(0, 151.0, 0, 151.1)).toBeCloseTo(90, 1);
  });
});

describe('toGL', () => {
  it('swaps [lat,lng] to [lng,lat]', () => {
    expect(toGL([[-33.87, 151.21], [-34.0, 151.0]])).toEqual([[151.21, -33.87], [151.0, -34.0]]);
  });
});

describe('decodePolyline6', () => {
  it('round-trips a set of AU coordinates', () => {
    const pts = [[-33.868, 151.207], [-33.870, 151.210], [-33.882, 151.201]];
    const decoded = decodePolyline6(encode6(pts));
    expect(decoded).toHaveLength(pts.length);
    decoded.forEach(([lat, lng], i) => {
      expect(lat).toBeCloseTo(pts[i][0], 5);
      expect(lng).toBeCloseTo(pts[i][1], 5);
    });
  });
});

describe('nearestOnRoute', () => {
  it('finds the closest vertex index', () => {
    const pts = [[-33.80, 151.0], [-33.81, 151.0], [-33.82, 151.0]];
    const { idx } = nearestOnRoute(pts, -33.819, 151.0);
    expect(idx).toBe(2);
  });
});

describe('targetNavZoom', () => {
  it('uses the 3D band when perspective3D is on', () => {
    expect(targetNavZoom(30, true)).toBe(18);   // >70km/h
    expect(targetNavZoom(5, true)).toBe(18.8);   // slow
  });
  it('zooms out with speed in 2D', () => {
    expect(targetNavZoom(25, false)).toBe(16.5); // >75km/h
    expect(targetNavZoom(3, false)).toBe(17.8);  // slow
  });
});

describe('computeTrafficFC', () => {
  const line = Array.from({ length: 20 }, (_, i) => [-33.80 - i * 0.001, 151.0]);
  it('returns empty when there are no congestion sources', () => {
    expect(computeTrafficFC(line, []).features).toHaveLength(0);
  });
  it('marks a congested stretch around a source', () => {
    const src = [{ lat: line[10][0], lng: line[10][1], sev: 'heavy' }];
    const fc = computeTrafficFC(line, src);
    expect(fc.features.length).toBeGreaterThan(0);
    expect(fc.features[0].properties.sev).toBe('heavy');
    expect(fc.features[0].geometry.type).toBe('LineString');
  });
  it('returns empty for a degenerate route', () => {
    expect(computeTrafficFC([[-33.8, 151.0]], [{ lat: -33.8, lng: 151.0, sev: 'slow' }]).features).toHaveLength(0);
  });
});
