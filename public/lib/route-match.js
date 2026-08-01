// ── Ghost shared core: live-route matching & arc-length ──────────────────────
// Pure functions extracted from app.js. In the browser these run as a classic
// <script> after geo.js (both read geo helpers off globalThis.GhostCore); in
// tests they require ./geo.js. app.js keeps thin same-named wrappers that thread
// the module globals (routePoints, _lastRouteIdx, routeCumDist) into these.
;(function () {
  'use strict';
  const geo = (typeof require !== 'undefined') ? require('./geo.js') : globalThis.GhostCore;
  const { haversine, bearing, nearestOnRoute } = geo;

  // Forward-biased route matcher for live nav. Searches a window ahead of the
  // current cursor so a route that loops near itself (interchanges/ramps) doesn't
  // snap our position far ahead; falls back to a global scan only when genuinely
  // off the windowed route (post-reroute or a big GPS jump).
  function matchRouteIdx(routePoints, lastIdx, lat, lng) {
    const len = routePoints.length;
    if (!len) return { idx: 0, dist: Infinity };
    const lo = Math.max(0, lastIdx - 4), hi = Math.min(len - 1, lastIdx + 200);
    let minD = Infinity, best = Math.min(lastIdx, len - 1);
    for (let i = lo; i <= hi; i++) { const d = haversine(routePoints[i][0], routePoints[i][1], lat, lng); if (d < minD) { minD = d; best = i; } }
    if (minD > 100) { const g = nearestOnRoute(routePoints, lat, lng); if (g.dist < minD) return g; }
    return { idx: best, dist: minD };
  }

  // routeCumDist[i] = metres travelled along the polyline to reach routePoints[i].
  function buildRouteCumDist(routePoints) {
    const cum = new Array(routePoints.length);
    let acc = 0;
    for (let i = 0; i < routePoints.length; i++) {
      if (i > 0) acc += haversine(routePoints[i - 1][0], routePoints[i - 1][1], routePoints[i][0], routePoints[i][1]);
      cum[i] = acc;
    }
    return cum;
  }

  // Ground-truth position → metres along the route (nearest vertex + partial seg).
  function posToProgressM(routePoints, cum, idx, lat, lng) {
    if (!cum.length) return 0;
    let m = cum[idx] || 0;
    const nxt = routePoints[idx + 1];
    if (nxt) {
      const seg = haversine(routePoints[idx][0], routePoints[idx][1], nxt[0], nxt[1]);
      const fromV = haversine(routePoints[idx][0], routePoints[idx][1], lat, lng);
      if (seg > 0) m += Math.max(0, Math.min(fromV, seg));
    }
    return m;
  }

  // Metres along the route → {lat,lng,idx,hdg} by walking the cumulative table.
  function progressMToPos(routePoints, cum, m) {
    const n = routePoints.length;
    if (!n || !cum.length) return null;
    if (m <= 0) return { lat: routePoints[0][0], lng: routePoints[0][1], idx: 0, hdg: n > 1 ? bearing(routePoints[0][0], routePoints[0][1], routePoints[1][0], routePoints[1][1]) : 0 };
    const total = cum[n - 1];
    if (m >= total) { const a = routePoints[n - 2] || routePoints[n - 1], b = routePoints[n - 1]; return { lat: b[0], lng: b[1], idx: n - 1, hdg: bearing(a[0], a[1], b[0], b[1]) }; }
    let lo = 0, hi = n - 1;
    while (lo + 1 < hi) { const mid = (lo + hi) >> 1; if (cum[mid] <= m) lo = mid; else hi = mid; }
    const a = routePoints[lo], b = routePoints[lo + 1];
    const segLen = (cum[lo + 1] - cum[lo]) || 1;
    const t = Math.max(0, Math.min(1, (m - cum[lo]) / segLen));
    return { lat: a[0] + (b[0] - a[0]) * t, lng: a[1] + (b[1] - a[1]) * t, idx: lo, hdg: bearing(a[0], a[1], b[0], b[1]) };
  }

  // Throttle gate for per-frame work (route-line redraw, traffic recompute). The
  // 60fps motion loop calls this with the last committed state; it returns true
  // only when the matched vertex advanced OR the car moved past `minMeters` since
  // the last redraw — so we stop re-uploading geometry on every animation frame.
  function routeSyncNeeded(prevIdx, newIdx, prevLat, prevLng, lat, lng, minMeters) {
    if (prevIdx == null || prevLat == null) return true;   // first frame — always draw
    if (newIdx !== prevIdx) return true;                   // advanced to a new vertex
    return haversine(prevLat, prevLng, lat, lng) >= (minMeters ?? 8);
  }

  const api = { matchRouteIdx, buildRouteCumDist, posToProgressM, progressMToPos, routeSyncNeeded };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof globalThis !== 'undefined') globalThis.GhostCore = Object.assign(globalThis.GhostCore || {}, api);
})();
