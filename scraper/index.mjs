/**
 * Waze live-map scraper — runs on your Mac via PM2
 *
 * Opens a real Chromium browser session, loads waze.com/live-map so the
 * reCAPTCHA + session cookies are established, then uses page.evaluate()
 * to fire all the NSW tile requests from *inside* the browser (same-origin,
 * same cookies → no bot detection).  Results are POSTed to Radar every 5 min.
 */

import { chromium } from 'playwright';

// ─── Config ──────────────────────────────────────────────────────────────────

const RADAR_INGEST  = 'https://radar.theradicalparty.com/api/admin/waze-ingest';
const ADMIN_KEY     = 'boob';
const SCRAPE_MS     = 5 * 60 * 1000;   // scrape every 5 minutes
const REFRESH_MS    = 20 * 60 * 1000;  // reload page every 20 min (keep cookies fresh)
const WAZE_LIVE_MAP = 'https://www.waze.com/en-GB/live-map'; // /en-GB avoids redirect

// NSW bounding box — 3 rows × 4 cols = 12 tiles
const NSW   = { n: -28.15, s: -37.51, w: 140.99, e: 153.64 };
const ROWS  = 3;
const COLS  = 4;

// ─── Type mapping ─────────────────────────────────────────────────────────────

function mapAlert(type, sub = '') {
  switch (type) {
    case 'POLICE':
      if (sub === 'POLICE_HIDING')      return { type: 'police',  label: 'Hidden police' };
      if (sub === 'POLICE_CAR_STOPPED') return { type: 'police',  label: 'Police stopped' };
      return                                   { type: 'police',  label: 'Police' };

    case 'ACCIDENT':
      return { type: 'accident', label: sub === 'ACCIDENT_MAJOR' ? 'Major accident' : 'Accident' };

    case 'HAZARD':
      if (sub.includes('WEATHER_FOG'))    return { type: 'weather',      label: 'Fog' };
      if (sub.includes('WEATHER_RAIN'))   return { type: 'weather',      label: 'Heavy rain' };
      if (sub.includes('WEATHER_FLOOD'))  return { type: 'weather',      label: 'Flooding' };
      if (sub.includes('WEATHER_HAIL'))   return { type: 'weather',      label: 'Hail' };
      if (sub.includes('WEATHER'))        return { type: 'weather',      label: 'Weather hazard' };
      if (sub.includes('CONSTRUCTION') || sub.includes('ROAD_WORK'))
                                          return { type: 'roadwork',     label: 'Road works' };
      if (sub === 'HAZARD_ON_ROAD_LANE_CLOSED')          return { type: 'blocked_lane', label: 'Lane closed' };
      if (sub === 'HAZARD_ON_ROAD_OBJECT')               return { type: 'hazard',       label: 'Object on road' };
      if (sub === 'HAZARD_ON_ROAD_POT_HOLE')             return { type: 'hazard',       label: 'Pothole' };
      if (sub === 'HAZARD_ON_ROAD_TRAFFIC_LIGHT_FAULT')  return { type: 'hazard',       label: 'Traffic light fault' };
      if (sub === 'HAZARD_ON_ROAD_CAR_STOPPED')          return { type: 'hazard',       label: 'Broken down vehicle' };
      if (sub === 'HAZARD_ON_SHOULDER_ANIMALS')          return { type: 'hazard',       label: 'Animals on road' };
      if (sub === 'HAZARD_ON_ROAD_ICE')                  return { type: 'weather',      label: 'Ice on road' };
      return                                             { type: 'hazard',       label: 'Road hazard' };

    case 'ROAD_CLOSED':
      return {
        type: sub === 'ROAD_CLOSED_CONSTRUCTION' ? 'roadwork' : 'closure',
        label: 'Road closed',
      };

    default:
      return null;
  }
}

// ─── Single tile fetch (runs inside the browser page context) ─────────────────

async function fetchTile(page, left, bottom, right, top) {
  const url = `https://www.waze.com/live-map/api/georss?top=${top}&bottom=${bottom}&left=${left}&right=${right}&env=row&types=alerts,traffic&ma=500&mj=300`;
  try {
    const result = await page.evaluate(async (fetchUrl) => {
      try {
        const res = await fetch(fetchUrl, {
          headers: {
            'Accept': 'application/json, text/javascript, */*; q=0.01',
            'X-Requested-With': 'XMLHttpRequest',
          },
        });
        if (!res.ok) return { _err: res.status };
        return await res.json();
      } catch (e) {
        return { _err: e.message };
      }
    }, url);
    return result;
  } catch (e) {
    return { _err: e.message };
  }
}

// ─── Scrape all NSW tiles ─────────────────────────────────────────────────────

async function scrapeNSW(page) {
  const latStep = (NSW.n - NSW.s) / ROWS;
  const lngStep = (NSW.e - NSW.w) / COLS;

  const seen    = new Map();
  let tilesOk   = 0;
  let tilesErr  = 0;

  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const bottom = NSW.s + r * latStep;
      const top    = bottom + latStep;
      const left   = NSW.w + c * lngStep;
      const right  = left + lngStep;

      const data = await fetchTile(page, left, bottom, right, top);

      if (data._err) {
        tilesErr++;
        continue;
      }
      tilesOk++;

      for (const alert of data.alerts ?? []) {
        if (seen.has(alert.uuid)) continue;
        const mapped = mapAlert(alert.type, alert.subtype ?? '');
        if (!mapped) continue;

        const street = alert.street ? ` on ${alert.street}` : '';
        const city   = alert.city   ? `, ${alert.city}`     : '';
        seen.set(alert.uuid, {
          uuid:        alert.uuid,
          lat:         alert.location.y,
          lng:         alert.location.x,
          type:        mapped.type,
          description: `${mapped.label}${street}${city}`,
        });
      }

      for (const jam of data.jams ?? []) {
        if (seen.has(jam.uuid)) continue;
        if ((jam.level ?? 0) < 3 || !jam.line?.length) continue;
        const mid    = jam.line[Math.floor(jam.line.length / 2)];
        const street = jam.street ? ` on ${jam.street}` : '';
        const sev    = jam.level >= 5 ? 'Road blocked'
                     : jam.level === 4 ? 'Standstill'
                     : 'Heavy traffic';
        const spd    = jam.speedKMH != null ? ` (${Math.round(jam.speedKMH)} km/h)` : '';
        seen.set(jam.uuid, {
          uuid: jam.uuid, lat: mid.y, lng: mid.x,
          type: 'traffic', description: `${sev}${spd}${street}`,
        });
      }
    }
  }

  return { reports: [...seen.values()], tilesOk, tilesErr };
}

// ─── POST results to Radar ────────────────────────────────────────────────────

async function ingest(reports) {
  if (!reports.length) return 0;
  try {
    const res = await fetch(RADAR_INGEST, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-key': ADMIN_KEY },
      body: JSON.stringify({ reports }),
    });
    const d = await res.json();
    return d.upserted ?? 0;
  } catch (e) {
    console.error('Ingest error:', e.message);
    return 0;
  }
}

// ─── Main loop ────────────────────────────────────────────────────────────────

async function main() {
  console.log('Starting Waze scraper — loading browser...');

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins',
      '--disable-site-isolation-trials',
    ],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport:     { width: 1440, height: 900 },
    locale:       'en-AU',
    timezoneId:   'Australia/Sydney',
    geolocation:  { latitude: -33.8688, longitude: 151.2093 }, // Sydney CBD
    permissions:  ['geolocation'],
  });

  // Mask automation signals
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {} };
  });

  const page = await context.newPage();

  const loadWaze = async () => {
    console.log('Loading waze.com/live-map...');
    await page.goto(WAZE_LIVE_MAP, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    // Give reCAPTCHA and the SPA time to fully initialise
    await new Promise(r => setTimeout(r, 10_000));
    console.log('Waze loaded.');
  };

  await loadWaze();
  let lastRefresh = Date.now();

  const tick = async () => {
    // Refresh the Waze page periodically to keep cookies alive
    if (Date.now() - lastRefresh > REFRESH_MS) {
      try {
        console.log('Refreshing Waze page...');
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
        await new Promise(r => setTimeout(r, 5_000));
        lastRefresh = Date.now();
      } catch (e) {
        console.error('Page refresh failed, reloading:', e.message);
        await loadWaze();
        lastRefresh = Date.now();
      }
    }

    try {
      const { reports, tilesOk, tilesErr } = await scrapeNSW(page);
      const upserted = await ingest(reports);
      const now = new Date().toLocaleTimeString('en-AU', { timeZone: 'Australia/Sydney' });
      const policeCount = reports.filter(r => r.type === 'police').length;
      console.log(`[${now}] tiles ${tilesOk}ok/${tilesErr}err — ${reports.length} alerts (${policeCount} police) — ${upserted} upserted`);
    } catch (e) {
      console.error('Scrape error:', e.message);
      // If page is broken, try a full reload next tick
      lastRefresh = 0;
    }
  };

  // Run immediately then on interval
  await tick();
  setInterval(tick, SCRAPE_MS);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
