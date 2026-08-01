// ── Ghost shared core: geometry & geo utilities ──────────────────────────────
// Pure functions with no DOM/network deps, extracted from app.js so they can be
// unit-tested and reused. Loaded in the browser as a classic <script> before
// app.js (attaches to globalThis.GhostCore); imported directly by the test suite
// (module.exports). Keep this behaviour identical to the originals in app.js.
;(function () {
  'use strict';

  // Great-circle distance in metres between two [lat,lng] points.
  function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371000, r = Math.PI / 180;
    const dL = (lat2 - lat1) * r, dO = (lon2 - lon1) * r;
    const a = Math.sin(dL / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dO / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  // Initial compass bearing (degrees, 0-360) from point 1 to point 2.
  function bearing(lat1, lon1, lat2, lon2) {
    const r = Math.PI / 180;
    return (Math.atan2(
      Math.sin((lon2 - lon1) * r) * Math.cos(lat2 * r),
      Math.cos(lat1 * r) * Math.sin(lat2 * r) - Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos((lon2 - lon1) * r)
    ) * 180 / Math.PI + 360) % 360;
  }

  // routePoints are [lat,lng]; MapLibre/GeoJSON needs [lng,lat].
  const toGL = pts => pts.map(p => [p[1], p[0]]);

  // Decode a precision-6 encoded polyline (Valhalla) into [lat,lng] pairs.
  function decodePolyline6(str) {
    let idx = 0, lat = 0, lng = 0; const out = [];
    while (idx < str.length) {
      let b, shift = 0, res = 0;
      do { b = str.charCodeAt(idx++) - 63; res |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      lat += (res & 1) ? ~(res >> 1) : res >> 1; shift = res = 0;
      do { b = str.charCodeAt(idx++) - 63; res |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      lng += (res & 1) ? ~(res >> 1) : res >> 1;
      out.push([lat / 1e6, lng / 1e6]);
    }
    return out;
  }

  // Global nearest-vertex scan over a polyline.
  function nearestOnRoute(pts, lat, lng) {
    let minD = Infinity, minI = 0;
    for (let i = 0; i < pts.length; i++) {
      const d = haversine(pts[i][0], pts[i][1], lat, lng);
      if (d < minD) { minD = d; minI = i; }
    }
    return { idx: minI, dist: minD };
  }

  // Target follow-camera zoom for a given ground speed. `perspective3D` toggles
  // the 3D driving view's fixed zoom band.
  function targetNavZoom(speedMs, perspective3D) {
    const kmh = speedMs * 3.6;
    if (perspective3D) return kmh > 70 ? 18 : 18.8;
    if (kmh > 75) return 16.5;
    if (kmh > 35) return 17.2;
    return 17.8;
  }

  // Build a GeoJSON FeatureCollection of the congested sub-segments of a route.
  // `points` is [lat,lng][]; `srcs` is [{lat,lng,sev:'heavy'|'slow'}]. Pure — the
  // caller supplies the live congestion sources.
  function computeTrafficFC(points, srcs) {
    const feats = [];
    if (!points || points.length < 2) return { type: 'FeatureCollection', features: feats };
    if (!srcs || !srcs.length) return { type: 'FeatureCollection', features: feats };
    const THRESH = 80, DILATE = 120; // metres: match radius + spread
    const sev = new Array(points.length).fill(0);
    for (let i = 0; i < points.length; i++) {
      const la = points[i][0], lo = points[i][1];
      for (const s of srcs) {
        if (haversine(la, lo, s.lat, s.lng) < THRESH) { sev[i] = Math.max(sev[i], s.sev === 'heavy' ? 2 : 1); }
      }
    }
    // Dilate congestion along the route so a point report colours a visible stretch.
    const dil = sev.slice();
    for (let i = 0; i < points.length; i++) {
      if (!sev[i]) continue;
      let d = 0;
      for (let j = i + 1; j < points.length; j++) { d += haversine(points[j - 1][0], points[j - 1][1], points[j][0], points[j][1]); if (d > DILATE) break; dil[j] = Math.max(dil[j], sev[i]); }
      d = 0;
      for (let j = i - 1; j >= 0; j--) { d += haversine(points[j + 1][0], points[j + 1][1], points[j][0], points[j][1]); if (d > DILATE) break; dil[j] = Math.max(dil[j], sev[i]); }
    }
    // Group consecutive equal-severity vertices into line features.
    let start = 0;
    while (start < points.length) {
      if (!dil[start]) { start++; continue; }
      let end = start;
      while (end + 1 < points.length && dil[end + 1] === dil[start]) end++;
      const a = Math.max(0, start - 1), b = Math.min(points.length - 1, end + 1);
      if (b > a) feats.push({ type: 'Feature', properties: { sev: dil[start] === 2 ? 'heavy' : 'slow' }, geometry: { type: 'LineString', coordinates: toGL(points.slice(a, b + 1)) } });
      start = end + 1;
    }
    return { type: 'FeatureCollection', features: feats };
  }

  const api = { haversine, bearing, toGL, decodePolyline6, nearestOnRoute, targetNavZoom, computeTrafficFC };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;                 // tests (CJS)
  if (typeof globalThis !== 'undefined') globalThis.GhostCore = Object.assign(globalThis.GhostCore || {}, api); // browser
})();
