// ── Geocoding: pure mapping / parsing / dedupe (no network) ───────────────────
// Kept free of fetch so it can be unit-tested with captured Photon / Nominatim
// JSON. index.ts does the fetching (incl. the structured address pass) and calls
// these. The ranking that decides ordering lives client-side in
// public/lib/address.js; here we only normalise, tag, and de-duplicate.

export interface GeoResult {
  lat: number;
  lng: number;
  name: string;
  sub: string;
  osmKey: string;
  osmVal: string;
  house: boolean;
  importance: number;
}

// AU street-type abbreviations → canonical word, so dedupe keys collapse
// "Queen St" and "Queen Street". Mirrors public/lib/address.js.
const STREET_ABBR: Record<string, string> = {
  st: 'street', str: 'street', rd: 'road', ave: 'avenue', av: 'avenue',
  blvd: 'boulevard', bvd: 'boulevard', hwy: 'highway', fwy: 'freeway',
  ln: 'lane', ct: 'court', crt: 'court', cres: 'crescent', cr: 'crescent',
  cct: 'circuit', pde: 'parade', dr: 'drive', drv: 'drive', pl: 'place',
  tce: 'terrace', sq: 'square', cl: 'close', gr: 'grove', gdns: 'gardens',
  pkwy: 'parkway', wy: 'way', esp: 'esplanade',
  n: 'north', s: 'south', e: 'east', w: 'west',
};
const STREET_TYPE_WORDS = new Set(Object.values(STREET_ABBR));

export function normStreet(s: string): string {
  return String(s || '').toLowerCase().replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim()
    .split(' ').filter(Boolean).map(t => STREET_ABBR[t] || t).join(' ');
}

function leadingNumber(s: string): string {
  const m = String(s || '').trim().match(/^(\d+[a-z]?(?:\s*[-/]\s*\d+[a-z]?)?)\b/i);
  return m ? m[1].replace(/\s*([-/])\s*/g, '$1').toLowerCase() : '';
}

export interface ParsedAddress {
  isAddress: boolean;
  houseNumber: string;
  street: string;
  locality: string;
}

// Detect a house-number-led query and split "83 queen st ashfield" into a street
// ("83 queen st") and a locality ("ashfield") for a Nominatim structured search.
export function parseAddress(q: string): ParsedAddress {
  const raw = String(q || '').trim();
  const houseNumber = leadingNumber(raw);
  if (!houseNumber) return { isAddress: false, houseNumber: '', street: raw, locality: '' };
  const rest = raw.slice(raw.indexOf(houseNumber.split(/[-/]/)[0]) + houseNumber.length).trim();
  const toks = rest.split(/\s+/).filter(Boolean);
  let splitAt = -1;
  for (let i = 0; i < toks.length; i++) if (STREET_TYPE_WORDS.has(STREET_ABBR[toks[i].toLowerCase()] || toks[i].toLowerCase())) splitAt = i;
  const street = splitAt >= 0 ? toks.slice(0, splitAt + 1).join(' ') : toks.join(' ');
  const locality = splitAt >= 0 ? toks.slice(splitAt + 1).join(' ') : '';
  return { isAddress: true, houseNumber, street: `${houseNumber} ${street}`.trim(), locality };
}

export function mapPhoton(json: any): GeoResult[] {
  const out: GeoResult[] = [];
  if (!json?.features) return out;
  for (const f of json.features) {
    const p = f.properties ?? {}; const g = f.geometry?.coordinates;
    if (!g) continue;
    // Keep the house number IN the name ("83 Queen Street") so civic addresses are
    // recognisable and rank above nearby bus stops — dropping it collapsed them to
    // a bare "Queen Street".
    const hn = p.housenumber;
    const name = hn && (p.street || p.name) ? `${hn} ${p.street || p.name}`.trim()
      : (p.name || p.street || p.city || p.county || 'Place');
    out.push({
      lat: g[1], lng: g[0], name,
      sub: [hn ? null : p.street, p.suburb || p.district || p.town || p.village || p.city, p.state].filter(Boolean).join(', '),
      osmKey: p.osm_key ?? '', osmVal: p.osm_value ?? '', house: !!hn, importance: hn ? 0.9 : 0.5,
    });
  }
  return out;
}

export function mapNominatim(rows: any): GeoResult[] {
  const out: GeoResult[] = [];
  if (!Array.isArray(rows)) return out;
  for (const r of rows) {
    const a = r.address ?? {};
    const hn = a.house_number, road = a.road;
    const raw = hn && road ? `${hn} ${road}` : (r.name || road || a.suburb || r.display_name?.split(',')[0] || 'Place');
    if (r.lat == null || r.lon == null) continue;
    out.push({
      lat: parseFloat(r.lat), lng: parseFloat(r.lon), name: raw,
      sub: [!hn && road && !String(raw).includes(road) ? road : null, a.suburb || a.quarter || a.village || a.town || a.city_district, a.state_district || a.state].filter(Boolean).join(', '),
      osmKey: r.category ?? '', osmVal: r.type ?? '', house: !!hn, importance: hn ? 0.9 : (r.importance ?? 0.5),
    });
  }
  return out;
}

// Merge result lists and drop duplicates. House results key on
// number+street+suburb so the same civic address from Photon and both Nominatim
// passes collapses to one; everything else keys on name + ~1m-precise coords so
// genuinely distinct nearby places survive.
export function dedupe(lists: GeoResult[][]): GeoResult[] {
  const seen = new Set<string>();
  const out: GeoResult[] = [];
  for (const r of lists.flat()) {
    if (!r || r.lat == null || r.lng == null || !r.name || isNaN(r.lat) || isNaN(r.lng)) continue;
    const key = r.house
      ? `h|${normStreet(r.name)}|${normStreet(r.sub)}`
      : `${String(r.name).toLowerCase()}|${r.lat.toFixed(5)}|${r.lng.toFixed(5)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}
