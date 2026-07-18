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

// ─── WAZE ────────────────────────────────────────────────────────────────────
// Waze added reCAPTCHA gate in 2025; CF Worker IPs typically get 403.
// We still attempt with every valid header — if it works, great.

const WAZE_BASE = 'https://www.waze.com/live-map/api/georss';
const WAZE_TTL_MS = 90 * 60 * 1000;

const NSW = { n: -28.15, s: -37.51, w: 140.99, e: 153.64 };
const ROWS = 3;
const COLS = 4;

interface WazeAlert {
  uuid: string;
  type: string;
  subtype?: string;
  street?: string;
  city?: string;
  location: { x: number; y: number };
  pubMillis: number;
}
interface WazeJam {
  uuid: string;
  level: number;
  speedKMH: number;
  street?: string;
  line: Array<{ x: number; y: number }>;
  pubMillis: number;
}
interface WazeResponse { alerts?: WazeAlert[]; jams?: WazeJam[] }

function mapWazeAlert(type: string, sub: string): { type: ReportType; label: string } | null {
  switch (type) {
    case 'POLICE':
      return { type: 'police', label: sub === 'POLICE_HIDING' ? 'Hidden police' : sub === 'POLICE_CAR_STOPPED' ? 'Police stopped' : 'Police' };
    case 'ACCIDENT':
      return { type: 'accident', label: sub === 'ACCIDENT_MAJOR' ? 'Major accident' : 'Accident' };
    case 'HAZARD':
      if (sub.includes('WEATHER_FOG'))    return { type: 'weather',      label: 'Fog' };
      if (sub.includes('WEATHER_RAIN'))   return { type: 'weather',      label: 'Heavy rain' };
      if (sub.includes('WEATHER_FLOOD'))  return { type: 'weather',      label: 'Flooding' };
      if (sub.includes('WEATHER_HAIL'))   return { type: 'weather',      label: 'Hail' };
      if (sub.includes('WEATHER'))        return { type: 'weather',      label: 'Weather hazard' };
      if (sub.includes('CONSTRUCTION') || sub.includes('ROAD_WORK')) return { type: 'roadwork', label: 'Road works' };
      if (sub === 'HAZARD_ON_ROAD_LANE_CLOSED')          return { type: 'blocked_lane', label: 'Lane closed' };
      if (sub === 'HAZARD_ON_ROAD_OBJECT')               return { type: 'hazard',       label: 'Object on road' };
      if (sub === 'HAZARD_ON_ROAD_POT_HOLE')             return { type: 'hazard',       label: 'Pothole' };
      if (sub === 'HAZARD_ON_ROAD_TRAFFIC_LIGHT_FAULT')  return { type: 'hazard',       label: 'Traffic light fault' };
      if (sub === 'HAZARD_ON_ROAD_CAR_STOPPED')          return { type: 'hazard',       label: 'Broken down vehicle' };
      if (sub === 'HAZARD_ON_SHOULDER_ANIMALS')          return { type: 'hazard',       label: 'Animals on road' };
      if (sub === 'HAZARD_ON_ROAD_ICE')                  return { type: 'weather',      label: 'Ice on road' };
      return { type: 'hazard', label: 'Road hazard' };
    case 'ROAD_CLOSED':
      return { type: sub === 'ROAD_CLOSED_CONSTRUCTION' ? 'roadwork' : 'closure', label: 'Road closed' };
    default: return null;
  }
}

async function fetchWazeTile(left: number, bottom: number, right: number, top: number): Promise<WazeResponse> {
  try {
    const url = `${WAZE_BASE}?top=${top}&bottom=${bottom}&left=${left}&right=${right}&env=row&types=alerts,traffic&ma=500&mj=300`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'Accept-Language': 'en-AU,en-GB;q=0.9,en;q=0.8',
        'Referer': 'https://www.waze.com/live-map',
        'X-Requested-With': 'XMLHttpRequest',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin',
      },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return {};
    return await res.json() as WazeResponse;
  } catch {
    return {};
  }
}

async function scrapeWazeTiles(db: D1Database, now: number): Promise<{ upserted: number; attempted: number }> {
  const latStep = (NSW.n - NSW.s) / ROWS;
  const lngStep = (NSW.e - NSW.w) / COLS;

  const tiles: Promise<WazeResponse>[] = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const bottom = NSW.s + r * latStep;
      const left   = NSW.w + c * lngStep;
      tiles.push(fetchWazeTile(left, bottom, left + lngStep, bottom + latStep));
    }
  }

  const results = await Promise.allSettled(tiles);
  const seen = new Map<string, { lat: number; lng: number; type: ReportType; desc: string }>();

  for (const res of results) {
    if (res.status !== 'fulfilled') continue;
    const data = res.value;

    for (const alert of data.alerts ?? []) {
      if (seen.has(alert.uuid)) continue;
      const mapped = mapWazeAlert(alert.type, alert.subtype ?? '');
      if (!mapped) continue;
      const street = alert.street ? ` on ${alert.street}` : '';
      const city   = alert.city   ? `, ${alert.city}`    : '';
      seen.set(alert.uuid, {
        lat: alert.location.y, lng: alert.location.x,
        type: mapped.type, desc: `${mapped.label}${street}${city}`,
      });
    }

    for (const jam of data.jams ?? []) {
      if (seen.has(jam.uuid)) continue;
      if ((jam.level ?? 0) < 3 || !jam.line?.length) continue;
      const mid = jam.line[Math.floor(jam.line.length / 2)];
      const street   = jam.street ? ` on ${jam.street}` : '';
      const severity = jam.level >= 5 ? 'Road blocked' : jam.level === 4 ? 'Standstill' : 'Heavy traffic';
      const speed    = jam.speedKMH != null ? ` (${Math.round(jam.speedKMH)} km/h)` : '';
      seen.set(jam.uuid, { lat: mid.y, lng: mid.x, type: 'traffic', desc: `${severity}${speed}${street}` });
    }
  }

  if (!seen.size) return { upserted: 0, attempted: tiles.length };

  const expiresAt = now + WAZE_TTL_MS;
  const entries = [...seen.entries()];
  for (let i = 0; i < entries.length; i += 50) {
    const chunk = entries.slice(i, i + 50);
    await db.batch(chunk.flatMap(([uuid, r]) => {
      const id     = `wz${uuid.replace(/-/g, '').slice(0, 22)}`;
      const histId = `wh${uuid.replace(/-/g, '').slice(0, 22)}`;
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
  return { upserted: seen.size, attempted: tiles.length };
}

// ─── Main export ─────────────────────────────────────────────────────────────

export async function scrapeAll(db: D1Database): Promise<{
  livetraffic: number; waze: number; waze_tiles: number;
}> {
  const now = Date.now();
  const [ltCount, wazeResult] = await Promise.all([
    scrapeLiveTraffic(db, now),
    scrapeWazeTiles(db, now),
  ]);
  return { livetraffic: ltCount, waze: wazeResult.upserted, waze_tiles: wazeResult.attempted };
}

// Keep old name as alias so nothing else breaks
export { scrapeAll as scrapeWaze };
