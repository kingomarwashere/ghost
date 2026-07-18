import type { D1Database } from '@cloudflare/workers-types';

const WAZE_BASE = 'https://www.waze.com/row-rtserver/web/TGeoRSS';
const WAZE_TTL_MS = 90 * 60 * 1000; // reports stay alive 90 min; refreshed each poll

// NSW bounding box
const NSW = { n: -28.15, s: -37.51, w: 140.99, e: 153.64 };
const ROWS = 3;
const COLS = 4; // wider than tall

interface WazeAlert {
  uuid: string;
  type: string;
  subtype: string;
  street?: string;
  city?: string;
  location: { x: number; y: number };
  pubMillis: number;
  nThumbsUp?: number;
}

interface WazeJam {
  uuid: string;
  level: number; // 1=light 2=moderate 3=heavy 4=standstill 5=blocked
  speedKMH: number;
  street?: string;
  city?: string;
  line: Array<{ x: number; y: number }>;
  pubMillis: number;
}

interface WazeResponse {
  alerts?: WazeAlert[];
  jams?: WazeJam[];
}

type ReportType = 'police' | 'speed_trap' | 'accident' | 'hazard' | 'traffic' | 'closure' | 'roadwork' | 'weather' | 'blocked_lane';

function mapAlert(type: string, subtype: string): { type: ReportType; label: string } | null {
  switch (type) {
    case 'POLICE':
      if (subtype === 'POLICE_HIDING') return { type: 'police', label: 'Hidden police' };
      if (subtype === 'POLICE_CAR_STOPPED') return { type: 'police', label: 'Police vehicle stopped' };
      return { type: 'police', label: 'Police' };

    case 'ACCIDENT':
      if (subtype === 'ACCIDENT_MAJOR') return { type: 'accident', label: 'Major accident' };
      return { type: 'accident', label: 'Accident' };

    case 'HAZARD':
      if (subtype.includes('WEATHER_FOG'))   return { type: 'weather', label: 'Fog' };
      if (subtype.includes('WEATHER_RAIN'))  return { type: 'weather', label: 'Heavy rain' };
      if (subtype.includes('WEATHER_FLOOD')) return { type: 'weather', label: 'Flooding' };
      if (subtype.includes('WEATHER_HAIL'))  return { type: 'weather', label: 'Hail' };
      if (subtype.includes('WEATHER'))       return { type: 'weather', label: 'Weather hazard' };
      if (subtype.includes('CONSTRUCTION') || subtype.includes('ROAD_WORK')) return { type: 'roadwork', label: 'Road works' };
      if (subtype === 'HAZARD_ON_ROAD_LANE_CLOSED')         return { type: 'blocked_lane', label: 'Lane closed' };
      if (subtype === 'HAZARD_ON_ROAD_OBJECT')              return { type: 'hazard', label: 'Object on road' };
      if (subtype === 'HAZARD_ON_ROAD_POT_HOLE')            return { type: 'hazard', label: 'Pothole' };
      if (subtype === 'HAZARD_ON_ROAD_TRAFFIC_LIGHT_FAULT') return { type: 'hazard', label: 'Traffic light fault' };
      if (subtype === 'HAZARD_ON_ROAD_CAR_STOPPED')         return { type: 'hazard', label: 'Broken down vehicle' };
      if (subtype === 'HAZARD_ON_SHOULDER_ANIMALS')         return { type: 'hazard', label: 'Animals on road' };
      if (subtype === 'HAZARD_ON_SHOULDER_CAR_STOPPED')     return { type: 'hazard', label: 'Broken down vehicle' };
      if (subtype === 'HAZARD_ON_ROAD_ICE')                 return { type: 'weather', label: 'Ice on road' };
      return { type: 'hazard', label: 'Road hazard' };

    case 'ROAD_CLOSED':
      if (subtype === 'ROAD_CLOSED_EVENT')        return { type: 'closure', label: 'Road closed (event)' };
      if (subtype === 'ROAD_CLOSED_CONSTRUCTION') return { type: 'roadwork', label: 'Road closed (construction)' };
      if (subtype === 'ROAD_CLOSED_HAZARD')       return { type: 'closure', label: 'Road closed (hazard)' };
      return { type: 'closure', label: 'Road closed' };

    default:
      return null;
  }
}

function midpoint(line: Array<{ x: number; y: number }>): { lat: number; lng: number } {
  const m = line[Math.floor(line.length / 2)];
  return { lat: m.y, lng: m.x };
}

async function fetchTile(left: number, bottom: number, right: number, top: number): Promise<WazeResponse> {
  const url = `${WAZE_BASE}?tk=community&format=JSON&types=alerts,traffic&left=${left}&bottom=${bottom}&right=${right}&top=${top}&ma=500&mj=300`;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/javascript, */*',
        'Referer': 'https://www.waze.com/live-map',
        'X-Requested-With': 'XMLHttpRequest',
      },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return {};
    return await res.json() as WazeResponse;
  } catch {
    return {};
  }
}

export async function scrapeWaze(db: D1Database): Promise<{ upserted: number; tiles: number }> {
  const latStep = (NSW.n - NSW.s) / ROWS;
  const lngStep = (NSW.e - NSW.w) / COLS;

  // Fire all tile requests concurrently
  const fetches: Promise<WazeResponse>[] = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const bottom = NSW.s + r * latStep;
      const top    = bottom + latStep;
      const left   = NSW.w + c * lngStep;
      const right  = left + lngStep;
      fetches.push(fetchTile(left, bottom, right, top));
    }
  }

  const results = await Promise.allSettled(fetches);

  // Deduplicate across tile boundaries by Waze UUID
  const seen = new Map<string, { lat: number; lng: number; type: ReportType; desc: string; pubMillis: number }>();

  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    const data = r.value;

    for (const alert of data.alerts ?? []) {
      if (seen.has(alert.uuid)) continue;
      const mapped = mapAlert(alert.type, alert.subtype ?? '');
      if (!mapped) continue;

      const street = alert.street ? ` on ${alert.street}` : '';
      const city   = alert.city   ? `, ${alert.city}`     : '';
      seen.set(alert.uuid, {
        lat: alert.location.y,
        lng: alert.location.x,
        type: mapped.type,
        desc: `${mapped.label}${street}${city}`,
        pubMillis: alert.pubMillis,
      });
    }

    for (const jam of data.jams ?? []) {
      if (seen.has(jam.uuid)) continue;
      if ((jam.level ?? 0) < 3) continue; // skip light jams
      if (!jam.line?.length) continue;

      const { lat, lng } = midpoint(jam.line);
      const street   = jam.street ? ` on ${jam.street}` : '';
      const severity = jam.level >= 5 ? 'Road blocked'
                     : jam.level === 4 ? 'Standstill traffic'
                     : 'Heavy traffic';
      const speed = jam.speedKMH != null ? ` (${Math.round(jam.speedKMH)} km/h)` : '';
      seen.set(jam.uuid, {
        lat, lng,
        type: 'traffic',
        desc: `${severity}${speed}${street}`,
        pubMillis: jam.pubMillis,
      });
    }
  }

  if (seen.size === 0) return { upserted: 0, tiles: results.length };

  const now       = Date.now();
  const expiresAt = now + WAZE_TTL_MS;
  const entries   = [...seen.entries()];

  // Batch in chunks of 50 (D1 batch limit safety)
  for (let i = 0; i < entries.length; i += 50) {
    const chunk = entries.slice(i, i + 50);
    const stmts = chunk.flatMap(([uuid, r]) => {
      // Stable IDs derived from Waze UUID — collisions impossible
      const id    = `wz${uuid.replace(/-/g, '').slice(0, 22)}`;
      const histId= `wh${uuid.replace(/-/g, '').slice(0, 22)}`;
      return [
        db.prepare(`
          INSERT INTO reports (id, lat, lng, type, description, confirms, denies, created_at, expires_at, reporter_hash)
          VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, 'waze')
          ON CONFLICT(id) DO UPDATE SET
            expires_at  = excluded.expires_at,
            description = excluded.description
        `).bind(id, r.lat, r.lng, r.type, r.desc, r.pubMillis, expiresAt),

        // Only write history once per UUID (IGNORE if already exists)
        db.prepare(`
          INSERT OR IGNORE INTO report_history (id, lat, lng, type, created_at)
          VALUES (?, ?, ?, ?, ?)
        `).bind(histId, r.lat, r.lng, r.type, r.pubMillis),
      ];
    });
    await db.batch(stmts);
  }

  return { upserted: seen.size, tiles: results.length };
}
