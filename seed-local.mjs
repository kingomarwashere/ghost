#!/usr/bin/env node
/**
 * Local seeder — runs from Mac, fetches Overpass data, generates SQL,
 * then inserts into the remote D1 database via wrangler.
 * Usage: node seed-local.mjs [osm|gov|all]
 */
import { execSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const DB = 'radar-db';
const nanoid = () => randomUUID().replace(/-/g,'').slice(0,16);
const now = Date.now();

function runSQL(sql) {
  const tmp = `/tmp/radar-seed-${Date.now()}.sql`;
  writeFileSync(tmp, sql);
  try {
    const out = execSync(
      `~/.local/bin/npx wrangler d1 execute ${DB} --file=${tmp} --remote 2>&1`,
      { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 }
    );
    console.log(out.trim().split('\n').slice(-3).join('\n'));
  } finally {
    try { unlinkSync(tmp); } catch {}
  }
}

function chunkSQL(rows, tableCols, valuesFn) {
  const CHUNK = 200;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const vals = slice.map(valuesFn).filter(Boolean).join(',\n');
    if (!vals) continue;
    const sql = `INSERT OR IGNORE INTO cameras (${tableCols}) VALUES\n${vals};`;
    runSQL(sql);
    console.log(`  inserted chunk ${i}–${Math.min(i+CHUNK, rows.length)} of ${rows.length}`);
  }
}

/* ── OSM seed ──────────────────────────────────── */
async function seedOSM() {
  console.log('Fetching AU camera data from Overpass API…');
  const query = '[out:json][timeout:90];(node["highway"="speed_camera"](-44,112,-10,154);node["enforcement"="speed_camera"](-44,112,-10,154);node["enforcement"="traffic_signals"]["traffic_signals"="speed_camera"](-44,112,-10,154);way["highway"="speed_camera"](-44,112,-10,154););out center;';

  const resp = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    body: 'data=' + encodeURIComponent(query),
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'radar-app/1.0 (radar.theradicalparty.com)',
    },
  });
  if (!resp.ok) throw new Error(`Overpass ${resp.status}`);
  const { elements } = await resp.json();
  console.log(`Got ${elements.length} OSM elements`);

  const cols = 'id,lat,lng,type,source,description,state,road,speed_limit,external_id,created_at';
  chunkSQL(elements, cols, el => {
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (!lat || !lon) return null;
    const tags = el.tags ?? {};
    const enforcement = tags.enforcement ?? tags.highway ?? '';
    const type = enforcement === 'traffic_signals' ? 'red_light' : 'speed';
    const road = tags.name ?? tags['addr:street'] ?? null;
    const sl = tags['maxspeed'] ? parseInt(tags['maxspeed']) : null;
    const desc = tags['name'] ?? null;
    const esc = s => s == null ? 'NULL' : `'${String(s).replace(/'/g,"''")}'`;
    return `(${esc(nanoid())},${lat},${lon},${esc(type)},'osm',${esc(desc)},NULL,${esc(road)},${sl ?? 'NULL'},${esc(String(el.id))},${now})`;
  });
  console.log('OSM seed done.');
}

/* ── Gov seed (NSW Transport open data) ────────── */
async function seedGov() {
  // NSW Fixed Speed Cameras — has Lat(1)/Long(1) columns with real GPS coords
  const nswDatasets = [
    { id: 'bcf2f6f4-ecfb-40e1-a807-0d5eb5f51507', type: 'speed',     label: 'NSW Fixed Speed' },
    { id: 'debd70a9-f9f4-471c-81ae-c84098576ea6', type: 'red_light',  label: 'NSW Red Light'   },
  ];

  const BASE = 'https://opendata.transport.nsw.gov.au/api/3/action/datastore_search';
  const esc = s => s == null ? 'NULL' : `'${String(s).replace(/'/g,"''")}'`;
  const cols = 'id,lat,lng,type,source,description,state,road,speed_limit,external_id,created_at';

  for (const ds of nswDatasets) {
    console.log(`Fetching ${ds.label}…`);
    let offset = 0, total = 0;
    while (true) {
      let json;
      try {
        const resp = await fetch(`${BASE}?resource_id=${ds.id}&limit=1000&offset=${offset}`, {
          headers: { 'User-Agent': 'radar-app/1.0' }
        });
        if (!resp.ok) { console.log(`  HTTP ${resp.status}, stopping`); break; }
        json = await resp.json();
      } catch (e) { console.log(`  fetch error: ${e.message}`); break; }

      const records = json?.result?.records ?? [];
      if (!records.length) break;

      // Each record can have up to 3 camera positions (Lat(1)/Long(1) etc)
      const rows = [];
      for (const r of records) {
        for (const n of ['1', '2', '3']) {
          const lat = parseFloat(r[`Lat(${n})`]);
          const lng = parseFloat(r[`Long(${n})`]);
          if (isNaN(lat) || isNaN(lng) || lat === 0) continue;
          const road = r['ROAD/S'] ?? null;
          const suburb = r['SUBURB/TOWN'] ?? null;
          rows.push(`(${esc(nanoid())},${lat},${lng},${esc(ds.type)},'gov',${esc(suburb)},${esc('NSW')},${esc(road)},NULL,${esc(`nsw-${r._id}-${n}`)},${now})`);
        }
      }

      if (rows.length) {
        const sql = `INSERT OR IGNORE INTO cameras (${cols}) VALUES\n${rows.join(',\n')};`;
        runSQL(sql);
      }

      total += rows.length;
      offset += records.length;
      console.log(`  …${total} cameras inserted so far`);
      if (records.length < 1000) break;
    }
    console.log(`${ds.label} done — ${total} cameras`);
  }
}

const mode = process.argv[2] ?? 'all';
if (mode === 'osm' || mode === 'all') await seedOSM();
if (mode === 'gov' || mode === 'all') await seedGov();

// Print stats
const stats = execSync(
  `~/.local/bin/npx wrangler d1 execute ${DB} --command="SELECT type, source, COUNT(*) as n FROM cameras GROUP BY type, source ORDER BY source, type" --remote 2>&1`,
  { encoding: 'utf8' }
);
console.log('\nCamera DB stats:');
console.log(stats.split('\n').filter(l => l.includes('|') || l.includes('─')).join('\n'));
