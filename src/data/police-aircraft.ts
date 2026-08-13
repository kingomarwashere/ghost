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

export const POLICE_HEX: Record<string, PoliceAircraft> = {
  '7c4ced': { reg: 'VH-PHB', type: 'AS50', operator: 'NSW Police (PolAir)' },
  '7c4ef2': { reg: 'VH-PVO', type: 'AW139', operator: 'Victoria Police Air Wing' },
  '7c4ef5': { reg: 'VH-PVR', type: 'AW139', operator: 'Victoria Police Air Wing' },
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
