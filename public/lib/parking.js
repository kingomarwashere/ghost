// ── Ghost shared core: "Find My Car" pure helpers ────────────────────────────
// Freshness + display formatting for the parked-car memory. No DOM/localStorage
// here (that stays in app.js) — just the testable logic. Browser loads this as a
// classic <script> before app.js (attaches to globalThis.GhostCore); the test
// suite requires it (module.exports). Keep identical to the originals in app.js.
;(function () {
  'use strict';

  // Is a stored parking record usable? Needs real coords and, if timestamped,
  // must be within ttl (stale parking is worse than none — you've since moved).
  function parkFresh(p, ttl, now) {
    now = now || Date.now();
    if (!p || typeof p.lat !== 'number' || typeof p.lng !== 'number') return false;
    if (p.ts && (now - p.ts) > ttl) return false;
    return true;
  }

  // "parked <ago>" for the popup.
  function parkedAgo(ts, now) {
    now = now || Date.now();
    if (!ts) return 'here';
    const s = (now - ts) / 1000;
    if (s < 90) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} hr ago`;
    return `${Math.round(s / 86400)} d ago`;
  }

  const api = { parkFresh, parkedAgo };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;                 // tests (CJS)
  if (typeof globalThis !== 'undefined') globalThis.GhostCore = Object.assign(globalThis.GhostCore || {}, api); // browser
})();
