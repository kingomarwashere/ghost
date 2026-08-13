// Known Australian police-aviation aircraft, keyed by ICAO 24-bit Mode-S hex
// (lower-case). Australia's civil hex block is 7C0000–7CFFFF, so these all start
// `7c`. State air wings fly VH-registered civil aircraft with recognisable rego
// prefixes: NSW uses VH-PH_ ("Police Helicopter"), Victoria uses VH-PV_
// ("Police Victoria"). This list is the *deterministic* match; new/rotated tails
// are caught heuristically by tagPolice() and can be promoted here later.
//
// Sources: hexdb.io reg↔hex lookups, CASA register, Wikipedia (state air wings).
export interface PoliceAircraft {
  reg: string;       // civil registration / tail number
  type: string;      // ICAO aircraft type code
  operator: string;  // human-readable operator
}

// Hexes verified via hexdb.io reg↔hex lookups; ownership confirmed on the CASA
// register (mirrored at 16right.com). `type` is documentation only — live feeds
// supply the real type at render time. reg-only aircraft (hex unconfirmed) are
// intentionally omitted rather than guessed; the rego/callsign heuristics below
// catch those live.
export const POLICE_HEX: Record<string, PoliceAircraft> = {
  // NSW Police — Aviation Command / "PolAir" (helis VH-PH_, Caravans VH-D_V)
  '7c4ced': { reg: 'VH-PHB', type: 'B429', operator: 'NSW Police (PolAir)' },
  '7c4d02': { reg: 'VH-PHW', type: 'B429', operator: 'NSW Police (PolAir)' },
  '7c4cf8': { reg: 'VH-PHM', type: 'B429', operator: 'NSW Police (PolAir)' },
  '7c4d05': { reg: 'VH-PHZ', type: 'B412', operator: 'NSW Police (PolAir)' },
  '7c4e49': { reg: 'VH-PQZ', type: 'B412', operator: 'NSW Police (PolAir)' },
  '7c1239': { reg: 'VH-DVV', type: 'C208', operator: 'NSW Police (PolAir)' },
  '7c0ff9': { reg: 'VH-DFV', type: 'C208', operator: 'NSW Police (PolAir)' },
  '7c1185': { reg: 'VH-DQV', type: 'C208', operator: 'NSW Police (PolAir)' },
  // Victoria Police — Air Wing (VH-PV_, callsigns POL30–35)
  '7c4ef2': { reg: 'VH-PVO', type: 'A139', operator: 'Victoria Police Air Wing' },
  '7c4ef5': { reg: 'VH-PVR', type: 'A139', operator: 'Victoria Police Air Wing' },
  '7c4ef4': { reg: 'VH-PVQ', type: 'A139', operator: 'Victoria Police Air Wing' },
  '7c4ee8': { reg: 'VH-PVE', type: 'B350', operator: 'Victoria Police Air Wing' },
  // Queensland Police — Air Operations (fixed-wing surveillance)
  '7caedf': { reg: 'VH-8TT', type: 'B350', operator: 'QLD Police Air Operations' },
  '7cae3f': { reg: 'VH-8PD', type: 'B350', operator: 'QLD Police Air Operations' },
  '7cae40': { reg: 'VH-8PE', type: 'B350', operator: 'QLD Police Air Operations' },
  '7cae41': { reg: 'VH-8PF', type: 'B350', operator: 'QLD Police Air Operations' },
  '7c4e47': { reg: 'VH-PQX', type: 'C208', operator: 'QLD Police Air Operations' },
  '7c4e8d': { reg: 'VH-PSV', type: 'C208', operator: 'QLD Police Air Operations' },
  '7c5c08': { reg: 'VH-SGQ', type: 'B350', operator: 'QLD Police Air Operations' },
  // QGAir Rescue (QLD state SAR under the QPS Aviation Capability Group)
  '7c151d': { reg: 'VH-EGF', type: 'A139', operator: 'QGAir Rescue (QLD)' },
  '7c1522': { reg: 'VH-EGK', type: 'A139', operator: 'QGAir Rescue (QLD)' },
  '7c16cf': { reg: 'VH-ESH', type: 'A139', operator: 'QGAir Rescue (QLD)' },
  '7c16e1': { reg: 'VH-ESZ', type: 'A139', operator: 'QGAir Rescue (QLD)' },
  '7c17cd': { reg: 'VH-EZJ', type: 'A139', operator: 'QGAir Rescue (QLD)' },
  // Western Australia Police — Air Wing (VH-WP_ Pilatus, VH-VQ_/VH-VLA)
  '7c7180': { reg: 'VH-WPE', type: 'PC12', operator: 'WA Police Air Wing' },
  '7c718c': { reg: 'VH-WPQ', type: 'PC12', operator: 'WA Police Air Wing' },
  '7c7194': { reg: 'VH-WPY', type: 'PC12', operator: 'WA Police Air Wing' },
  '7c6bdc': { reg: 'VH-VLA', type: 'C208', operator: 'WA Police Air Wing' },
  '7c6ca7': { reg: 'VH-VQX', type: 'EC45', operator: 'WA Police Air Wing' },
  '7c6ca8': { reg: 'VH-VQY', type: 'EC45', operator: 'WA Police Air Wing' },
  // South Australia Police (SAPOL)
  '7c2496': { reg: 'VH-HIG', type: 'PC12', operator: 'SA Police (SAPOL)' },
  // Northern Territory Police — Air Wing
  '7c79fd': { reg: 'VH-YDR', type: 'PC12', operator: 'NT Police Air Wing' },
  // Australian Federal Police (AFP)
  '7cb08f': { reg: 'VH-85T', type: 'B350', operator: 'Australian Federal Police' },
  '7c1563': { reg: 'VH-EID', type: 'B350', operator: 'Australian Federal Police' },
};

// Raw aircraft object as returned by the airplanes.live / adsb.lol v2 API (the
// shared ADSBExchange schema). Only the fields we read are typed.
export interface AdsbAircraft {
  hex?: string;
  flight?: string;      // callsign (may have trailing spaces)
  r?: string;           // registration
  t?: string;           // ICAO type code
  lat?: number;
  lon?: number;
  alt_baro?: number | string; // ft, or "ground"
  alt_geom?: number;
  gs?: number;          // ground speed, knots
  track?: number;       // true track / heading, degrees
  category?: string;
  squawk?: string;
  dbFlags?: number;     // bitfield: 1 = military
}

// Rego prefixes used by Australian police air wings (VH-PH… NSW, VH-PV… VIC).
const POLICE_REGO_RE = /^VH-P[HV]/i;
const POLAIR_CALLSIGN_RE = /POL\s?AIR|POLAIR|POLICE/i;

export interface PoliceTag {
  police: boolean;
  operator: string | null;
}

// Decide whether an aircraft is a police unit. Allow-list first (authoritative),
// then rego/callsign heuristics so freshly-registered or rotated tails still get
// flagged. dbFlags military bit is NOT treated as police (police fly civil regos).
export function tagPolice(ac: AdsbAircraft): PoliceTag {
  const hex = (ac.hex || '').toLowerCase().replace(/^~/, '');
  const known = POLICE_HEX[hex];
  if (known) return { police: true, operator: known.operator };

  const reg = (ac.r || '').trim();
  if (POLICE_REGO_RE.test(reg)) {
    const operator = /^VH-PV/i.test(reg) ? 'Victoria Police Air Wing'
      : /^VH-PH/i.test(reg) ? 'NSW Police (PolAir)'
      : 'Police (AU)';
    return { police: true, operator };
  }

  if (POLAIR_CALLSIGN_RE.test((ac.flight || '').trim())) {
    return { police: true, operator: 'PolAir' };
  }

  return { police: false, operator: null };
}

// Slim, browser-facing shape. Small on purpose — this is polled every ~10s.
export interface Plane {
  hex: string;
  lat: number;
  lng: number;
  alt: number | null;   // ft (null when on ground / unknown)
  gs: number | null;    // ground speed, knots
  track: number;        // heading, degrees (0 = north)
  flight: string;       // callsign (trimmed)
  reg: string;          // registration
  type: string;         // ICAO type code
  category: string;
  police: boolean;
  operator: string | null;
}

export function toPlane(ac: AdsbAircraft): Plane | null {
  if (typeof ac.lat !== 'number' || typeof ac.lon !== 'number') return null;
  const { police, operator } = tagPolice(ac);
  const altNum = typeof ac.alt_baro === 'number' ? ac.alt_baro : null; // "ground" → null
  return {
    hex: (ac.hex || '').toLowerCase().replace(/^~/, ''),
    lat: ac.lat,
    lng: ac.lon,
    alt: altNum,
    gs: typeof ac.gs === 'number' ? Math.round(ac.gs) : null,
    track: typeof ac.track === 'number' ? ac.track : 0,
    flight: (ac.flight || '').trim(),
    reg: (ac.r || '').trim(),
    type: (ac.t || '').trim(),
    category: (ac.category || '').trim(),
    police,
    operator,
  };
}

// airplanes.live point queries take a centre + radius in nautical miles (≤250).
// Convert a map bounding box to the smallest enclosing point+radius. Radius is
// half the corner-to-corner diagonal, padded slightly and capped at the API max.
const NM_PER_M = 1 / 1852;
export function bboxToPointRadius(
  swLat: number, swLng: number, neLat: number, neLng: number,
): { lat: number; lon: number; radiusNm: number } {
  const lat = (swLat + neLat) / 2;
  const lon = (swLng + neLng) / 2;
  const diagM = haversineM(swLat, swLng, neLat, neLng);
  const radiusNm = Math.min(250, Math.max(1, Math.ceil((diagM / 2) * NM_PER_M) + 1));
  return { lat, lon, radiusNm };
}

export function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000, toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}
