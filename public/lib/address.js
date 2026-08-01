// ── Ghost shared core: address parsing & search ranking ──────────────────────
// The heart of "flawless" address search. Pure, testable. Browser loads this as
// a classic <script> after geo.js; tests require it. app.js keeps a thin
// scoreResult wrapper that supplies live history flags.
;(function () {
  'use strict';
  const geo = (typeof require !== 'undefined') ? require('./geo.js') : globalThis.GhostCore;
  const { haversine } = geo;

  // AU street-type + directional abbreviations → canonical full word, so
  // "83 queen st" and "83 Queen Street" normalize to the same string. Both the
  // abbreviation and the full word map to the full word (idempotent).
  const STREET_ABBR = {
    st: 'street', str: 'street', street: 'street',
    rd: 'road', road: 'road',
    ave: 'avenue', av: 'avenue', avenue: 'avenue',
    blvd: 'boulevard', bvd: 'boulevard', boulevard: 'boulevard',
    hwy: 'highway', highway: 'highway', fwy: 'freeway', freeway: 'freeway', mwy: 'motorway', motorway: 'motorway',
    ln: 'lane', lane: 'lane',
    ct: 'court', crt: 'court', court: 'court',
    cres: 'crescent', cr: 'crescent', crescent: 'crescent',
    cct: 'circuit', circuit: 'circuit', cir: 'circle', circle: 'circle',
    pde: 'parade', parade: 'parade',
    dr: 'drive', drv: 'drive', drive: 'drive',
    pl: 'place', place: 'place',
    tce: 'terrace', terrace: 'terrace',
    sq: 'square', square: 'square',
    cl: 'close', close: 'close',
    gr: 'grove', grove: 'grove',
    gdn: 'gardens', gdns: 'gardens', gardens: 'gardens',
    pkwy: 'parkway', pwy: 'parkway', parkway: 'parkway',
    wy: 'way', way: 'way',
    esp: 'esplanade', esplanade: 'esplanade',
    row: 'row', mews: 'mews', walk: 'walk', rise: 'rise',
    // directionals
    n: 'north', s: 'south', e: 'east', w: 'west',
    ne: 'northeast', nw: 'northwest', se: 'southeast', sw: 'southwest',
    north: 'north', south: 'south', east: 'east', west: 'west',
  };
  // The canonical street-type words (used to split street from locality).
  const STREET_TYPE_WORDS = new Set(Object.values(STREET_ABBR));

  // Lowercase, strip punctuation, collapse whitespace, then map each token through
  // the abbreviation table. Returns a canonical string for equality/inclusion tests.
  function normalizeStreet(s) {
    if (!s) return '';
    const toks = String(s).toLowerCase()
      .replace(/[.,]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .split(' ')
      .filter(Boolean)
      .map(t => STREET_ABBR[t] || t);
    return toks.join(' ');
  }

  // Leading house-number token of a string, or '' — handles "12", "12a",
  // "12-14" (ranges) and "2/83" (unit/street). Anchored to the start.
  function leadingNumber(s) {
    const m = String(s || '').trim().match(/^(\d+[a-z]?(?:\s*[-/]\s*\d+[a-z]?)?)\b/i);
    return m ? m[1].replace(/\s*([-/])\s*/g, '$1').toLowerCase() : '';
  }

  // Parse a search query into address parts. `isAddress` is true when the query
  // leads with a house number — that's the signal to switch ranking into
  // address mode and to fire the structured Nominatim pass server-side.
  function parseAddressQuery(q) {
    const raw = String(q || '').trim();
    const houseNumber = leadingNumber(raw);
    if (!houseNumber) return { houseNumber: '', street: normalizeStreet(raw), locality: '', isAddress: false };
    // Strip the number, normalize the remainder, split street vs trailing locality
    // at the last street-type word ("queen street | ashfield").
    const restNorm = normalizeStreet(raw.slice(raw.indexOf(houseNumber.split(/[-/]/)[0]) + houseNumber.length));
    const toks = restNorm.split(' ').filter(Boolean);
    let splitAt = -1;
    for (let i = 0; i < toks.length; i++) if (STREET_TYPE_WORDS.has(toks[i])) splitAt = i;
    const street = splitAt >= 0 ? toks.slice(0, splitAt + 1).join(' ') : toks.join(' ');
    const locality = splitAt >= 0 ? toks.slice(splitAt + 1).join(' ') : '';
    return { houseNumber, street, locality, isAddress: true };
  }

  // Does a result look like the civic address the user typed? True when the
  // result carries a house number and its leading number matches the query's
  // (or the query range's first component).
  function candidateHouseMatches(r, parsed) {
    if (!r || !r.house) return false;
    const rn = leadingNumber(r.name);
    if (!rn) return false;
    if (rn === parsed.houseNumber) return true;
    return rn.split(/[-/]/)[0] === parsed.houseNumber.split(/[-/]/)[0];
  }

  // Text-match score (0-1) of a normalized query against a candidate's normalized
  // name (falling back to its sub-line, then per-token overlap).
  function textScore(qNorm, nameNorm, subNorm) {
    if (!qNorm) return 0;
    if (nameNorm === qNorm) return 1.00;
    if (nameNorm.startsWith(qNorm)) return 0.92;
    if (nameNorm.includes(' ' + qNorm) || nameNorm.includes(qNorm + ' ')) return 0.82;
    if (nameNorm.includes(qNorm)) return 0.70;
    if (subNorm.includes(qNorm)) return 0.45;
    const toks = qNorm.split(' ').filter(t => t.length > 1);
    if (!toks.length) return 0;
    const hay = nameNorm + ' ' + subNorm;
    const hits = toks.filter(t => hay.includes(t)).length;
    return hits / toks.length * 0.55;
  }

  // Relevance score (higher = better), clamped to [0,1].
  //   scoreResult(r, q, { lat, lng, isFav, isRecent })
  // Address mode (query leads with a house number): text + exact house-number
  // match dominate and proximity is only a faint tiebreak, so the right building
  // several km away still beats a bus stop 100 m away. Place/POI mode keeps the
  // original proximity-forward weighting. All boosts are capped.
  function scoreResult(r, q, opts) {
    opts = opts || {};
    const lat = opts.lat, lng = opts.lng;
    const parsed = parseAddressQuery(q);
    const qNorm = normalizeStreet(q);
    const nameNorm = normalizeStreet(r.name || '');
    const subNorm = normalizeStreet(r.sub || '');

    const txt = textScore(qNorm, nameNorm, subNorm);
    const dist = r.dist != null ? r.dist : (lat && lng ? haversine(lat, lng, r.lat, r.lng) : 50000);
    const prox = dist < 200 ? 1 : Math.max(0, 1 - Math.log10(dist / 200) / 3.2);
    const imp = Math.min(1, r.importance != null ? r.importance : 0.5);
    const hist = opts.isFav ? 0.25 : (opts.isRecent ? 0.12 : 0);

    if (parsed.isAddress) {
      let score = txt * 0.55 + prox * 0.08 + imp * 0.12 + hist * 0.05;
      if (candidateHouseMatches(r, parsed)) score += 0.45;   // exact civic address
      else if (r.house) score += 0.12;                        // right street, other number
      else score -= 0.15;                                     // a POI when an address was typed
      return Math.max(0, Math.min(1, score));
    }
    return Math.max(0, Math.min(1, txt * 0.48 + prox * 0.24 + imp * 0.18 + hist * 0.10));
  }

  const api = { normalizeStreet, leadingNumber, parseAddressQuery, candidateHouseMatches, textScore, scoreResult };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof globalThis !== 'undefined') globalThis.GhostCore = Object.assign(globalThis.GhostCore || {}, api);
})();
