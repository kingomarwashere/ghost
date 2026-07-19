/**
 * Multi-source live data scraper
 *
 * Source 1 — NSW Live Traffic (official govt API, always works)
 *   Endpoints: incident, roadwork, majorevent, flood, alpine
 *   Update cadence: ~60 min; we poll every 5 min so we catch new ones fast
 *
 * Source 2 — Waze live-map (crowdsourced; Waze added reCAPTCHA in 2025 so
 *   requests from CF Worker IPs get 403 — we attempt anyway and skip gracefully)
 */

import type { D1Database } from '@cloudflare/workers-types';

// ─── Types ───────────────────────────────────────────────────────────────────

type ReportType =
  | 'police' | 'speed_trap' | 'accident' | 'hazard'
  | 'traffic' | 'closure' | 'roadwork' | 'weather' | 'blocked_lane';

// ─── NSW LIVE TRAFFIC ────────────────────────────────────────────────────────

const LT_BASE = 'http://data.livetraffic.com/traffic/hazards';
const LT_DEFAULT_TTL = 4 * 60 * 60 * 1000;   // 4 h for incidents without an end date
const LT_MAX_TTL     = 7 * 24 * 60 * 60 * 1000; // cap roadworks at 7 days

const LT_ENDPOINTS = [
  `${LT_BASE}/incident.json`,
  `${LT_BASE}/roadwork.json`,
  `${LT_BASE}/majorevent.json`,
  `${LT_BASE}/flood.json`,
  `${LT_BASE}/alpine.json`,
];

interface LTFeature {
  id: number | string;
  geometry: { coordinates: [number, number] }; // [lng, lat]
  properties: {
    mainCategory?: string;
    displayName?: string;
    end?: number | null;
    created?: number;
    roads?: Array<{
      mainStreet?: string;
      crossStreet?: string;
      suburb?: string;
      region?: string;
    }>;
  };
}

interface LTResponse { features?: LTFeature[] }

function mapLTCategory(cat: string): { type: ReportType; label: string } | null {
  switch ((cat ?? '').toUpperCase()) {
    case 'CRASH':                       return { type: 'accident',  label: 'Crash' };
    case 'ADVERSE WEATHER':             return { type: 'weather',   label: 'Adverse weather' };
    case 'BREAKDOWN':                   return { type: 'hazard',    label: 'Breakdown' };
    case 'HAZARD':                      return { type: 'hazard',    label: 'Road hazard' };
    case 'BURST WATER MAIN':            return { type: 'hazard',    label: 'Burst water main' };
    case 'CHANGED TRAFFIC CONDITIONS':  return { type: 'traffic',   label: 'Changed traffic conditions' };
    case 'EMERGENCY ROADWORK':          return { type: 'roadwork',  label: 'Emergency roadwork' };
    case 'SCHEDULED ROADWORK':          return { type: 'roadwork',  label: 'Roadwork' };
    case 'TRAFFIC LIGHTS BLACKED OUT':  return { type: 'hazard',    label: 'Traffic lights out' };
    case 'TRAFFIC LIGHTS FLASHING YELLOW': return { type: 'hazard', label: 'Traffic lights flashing' };
    case 'TRAFFIC LIGHTS':              return { type: 'hazard',    label: 'Traffic light fault' };
    case 'ROAD CLOSURE':                return { type: 'closure',   label: 'Road closure' };
    case 'SPECIAL EVENT':               return { type: 'traffic',   label: 'Special event' };
    case 'FLOOD':                       return { type: 'weather',   label: 'Flooding' };
    case 'ALPINE':                      return { type: 'weather',   label: 'Alpine conditions' };
    default:                            return null;
  }
}

async function scrapeLiveTraffic(db: D1Database, now: number): Promise<number> {
  const responses = await Promise.allSettled(
    LT_ENDPOINTS.map(url =>
      fetch(url, {
        headers: { Accept: 'application/json', 'User-Agent': 'radar-nsw/1.0' },
        signal: AbortSignal.timeout(15_000),
      }).then(r => r.ok ? r.json() as Promise<LTResponse> : Promise.reject(`HTTP ${r.status}`))
    )
  );

  const seen = new Map<string, {
    lat: number; lng: number; type: ReportType; desc: string; expiresAt: number;
  }>();

  for (const res of responses) {
    if (res.status !== 'fulfilled') continue;
    for (const f of res.value.features ?? []) {
      const key = `lt-${f.id}`;
      if (seen.has(key)) continue;
      const mapped = mapLTCategory(f.properties.mainCategory ?? '');
      if (!mapped) continue;

      const [lng, lat] = f.geometry.coordinates;
      const r = (f.properties.roads ?? [])[0] ?? {};
      const parts = [
        mapped.label,
        r.mainStreet ? `— ${r.mainStreet}` : '',
        r.crossStreet ? `near ${r.crossStreet}` : '',
        r.suburb ?? '',
      ].filter(Boolean);

      const expiresAt = f.properties.end
        ? Math.min(f.properties.end, now + LT_MAX_TTL)
        : now + LT_DEFAULT_TTL;

      seen.set(key, { lat, lng, type: mapped.type, desc: parts.join(' '), expiresAt });
    }
  }

  if (!seen.size) return 0;

  const entries = [...seen.entries()];
  for (let i = 0; i < entries.length; i += 50) {
    const chunk = entries.slice(i, i + 50);
    await db.batch(chunk.flatMap(([id, r]) => [
      db.prepare(`
        INSERT INTO reports (id, lat, lng, type, description, confirms, denies, created_at, expires_at, reporter_hash)
        VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, 'livetraffic')
        ON CONFLICT(id) DO UPDATE SET expires_at = excluded.expires_at, description = excluded.description
      `).bind(id, r.lat, r.lng, r.type, r.desc, now, r.expiresAt),
      db.prepare(`INSERT OR IGNORE INTO report_history (id, lat, lng, type, created_at) VALUES (?, ?, ?, ?, ?)`)
        .bind(id.replace('lt-', 'lh-'), r.lat, r.lng, r.type, now),
    ]));
  }
  return seen.size;
}

// ─── OPENWEBNINJA (Waze proxy) ────────────────────────────────────────────────
// Proxies Waze data via residential IPs — bypasses Waze's IP block.

const OWN_BASE  = 'https://api.openwebninja.com/waze/alerts-and-jams';
const WAZE_TTL_MS = 90 * 60 * 1000;

const NSW  = { n: -28.15, s: -37.51, w: 140.99, e: 153.64 };
const ROWS = 3;
const COLS = 4;

interface OWNAlert {
  alert_id: string;
  type: string;
  subtype: string | null;
  street: string | null;
  city: string | null;
  latitude: number;
  longitude: number;
  num_thumbs_up: number;
  publish_datetime_utc: string | null;
}
interface OWNJam {
  jam_id: string;
  level: number;
  speed_kmh: number;
  street: string | null;
  city: string | null;
  line_coordinates: Array<{ lat: number; lon: number }>;
}
interface OWNResponse {
  status: string;
  data?: { alerts?: OWNAlert[]; jams?: OWNJam[] };
}

function mapOWNAlert(type: string, sub: string | null): { type: ReportType; label: string } | null {
  const s = sub ?? '';
  switch (type) {
    case 'POLICE':
      if (s === 'POLICE_HIDING')             return { type: 'police', label: 'Hidden police' };
      if (s === 'POLICE_WITH_MOBILE_CAMERA') return { type: 'police', label: 'Mobile speed camera' };
      return                                        { type: 'police', label: 'Police' };
    case 'ACCIDENT':
      return { type: 'accident', label: s === 'ACCIDENT_MAJOR' ? 'Major accident' : 'Accident' };
    case 'HAZARD':
      if (s.includes('WEATHER_FOG'))    return { type: 'weather',      label: 'Fog' };
      if (s.includes('WEATHER_RAIN'))   return { type: 'weather',      label: 'Heavy rain' };
      if (s.includes('WEATHER_FLOOD'))  return { type: 'weather',      label: 'Flooding' };
      if (s.includes('WEATHER_HAIL'))   return { type: 'weather',      label: 'Hail' };
      if (s.includes('WEATHER'))        return { type: 'weather',      label: 'Weather hazard' };
      if (s.includes('CONSTRUCTION') || s.includes('ROAD_WORK')) return { type: 'roadwork', label: 'Road works' };
      if (s === 'HAZARD_ON_ROAD_LANE_CLOSED')         return { type: 'blocked_lane', label: 'Lane closed' };
      if (s === 'HAZARD_ON_ROAD_OBJECT')              return { type: 'hazard',       label: 'Object on road' };
      if (s === 'HAZARD_ON_ROAD_POT_HOLE')            return { type: 'hazard',       label: 'Pothole' };
      if (s === 'HAZARD_ON_ROAD_TRAFFIC_LIGHT_FAULT') return { type: 'hazard',       label: 'Traffic light fault' };
      if (s === 'HAZARD_ON_ROAD_CAR_STOPPED')         return { type: 'hazard',       label: 'Broken down vehicle' };
      if (s === 'HAZARD_ON_SHOULDER_ANIMALS')         return { type: 'hazard',       label: 'Animals on road' };
      if (s === 'HAZARD_ON_ROAD_ICE')                 return { type: 'weather',      label: 'Ice on road' };
      return { type: 'hazard', label: 'Road hazard' };
    case 'ROAD_CLOSED':
      return { type: s === 'ROAD_CLOSED_CONSTRUCTION' ? 'roadwork' : 'closure', label: 'Road closed' };
    case 'JAM':
      return null; // handled separately via jams array
    default: return null;
  }
}

async function fetchOWNTile(
  apiKey: string,
  bottom: number, left: number, top: number, right: number,
): Promise<OWNResponse> {
  try {
    const url = `${OWN_BASE}?bottom_left=${bottom},${left}&top_right=${top},${right}&alert_types=POLICE,ACCIDENT,HAZARD,ROAD_CLOSED,JAM&max_alerts=200&max_jams=300`;
    const res = await fetch(url, {
      headers: { 'x-api-key': apiKey },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return { status: 'ERROR' };
    return await res.json() as OWNResponse;
  } catch {
    return { status: 'ERROR' };
  }
}

async function scrapeOpenWebNinja(db: D1Database, apiKey: string, now: number): Promise<number> {
  const latStep = (NSW.n - NSW.s) / ROWS;
  const lngStep = (NSW.e - NSW.w) / COLS;

  const fetches = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const bottom = NSW.s + r * latStep;
      const left   = NSW.w + c * lngStep;
      fetches.push(fetchOWNTile(apiKey, bottom, left, bottom + latStep, left + lngStep));
    }
  }

  const results = await Promise.allSettled(fetches);
  const seen = new Map<string, { lat: number; lng: number; type: ReportType; desc: string }>();

  for (const res of results) {
    if (res.status !== 'fulfilled' || res.value.status !== 'OK') continue;
    const { alerts = [], jams = [] } = res.value.data ?? {};

    for (const alert of alerts) {
      if (seen.has(alert.alert_id)) continue;
      const mapped = mapOWNAlert(alert.type, alert.subtype);
      if (!mapped) continue;
      const street = alert.street ? ` on ${alert.street}` : '';
      const city   = alert.city   ? `, ${alert.city}`     : '';
      seen.set(alert.alert_id, {
        lat: alert.latitude, lng: alert.longitude,
        type: mapped.type, desc: `${mapped.label}${street}${city}`,
      });
    }

    for (const jam of jams) {
      if (seen.has(jam.jam_id)) continue;
      if ((jam.level ?? 0) < 3 || !jam.line_coordinates?.length) continue;
      const mid    = jam.line_coordinates[Math.floor(jam.line_coordinates.length / 2)];
      const street = jam.street ? ` on ${jam.street}` : '';
      const sev    = jam.level >= 5 ? 'Road blocked' : jam.level === 4 ? 'Standstill' : 'Heavy traffic';
      const spd    = jam.speed_kmh != null ? ` (${Math.round(jam.speed_kmh)} km/h)` : '';
      seen.set(jam.jam_id, {
        lat: mid.lat, lng: mid.lon,
        type: 'traffic', desc: `${sev}${spd}${street}`,
      });
    }
  }

  if (!seen.size) return 0;

  const expiresAt = now + WAZE_TTL_MS;
  const entries   = [...seen.entries()];
  for (let i = 0; i < entries.length; i += 50) {
    const chunk = entries.slice(i, i + 50);
    await db.batch(chunk.flatMap(([rawId, r]) => {
      // Stable 24-char ID from the alert/jam ID
      const id     = `wz${rawId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 22)}`;
      const histId = `wh${rawId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 22)}`;
      return [
        db.prepare(`
          INSERT INTO reports (id, lat, lng, type, description, confirms, denies, created_at, expires_at, reporter_hash)
          VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, 'waze')
          ON CONFLICT(id) DO UPDATE SET expires_at = excluded.expires_at, description = excluded.description
        `).bind(id, r.lat, r.lng, r.type, r.desc, now, expiresAt),
        db.prepare(`INSERT OR IGNORE INTO report_history (id, lat, lng, type, created_at) VALUES (?, ?, ?, ?, ?)`)
          .bind(histId, r.lat, r.lng, r.type, now),
      ];
    }));
  }
  return seen.size;
}

// ─── Main export ─────────────────────────────────────────────────────────────

export async function scrapeAll(db: D1Database, apiKey = ''): Promise<{
  livetraffic: number; waze: number;
}> {
  const now = Date.now();
  const [ltCount, wazeCount] = await Promise.all([
    scrapeLiveTraffic(db, now),
    apiKey ? scrapeOpenWebNinja(db, apiKey, now) : Promise.resolve(0),
  ]);
  return { livetraffic: ltCount, waze: wazeCount };
}

export { scrapeAll as scrapeWaze };
