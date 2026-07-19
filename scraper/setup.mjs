/**
 * Waze cookie setup — opens a Chromium window for login, saves cookies.
 * Detection: watches for Waze auth cookies (_web_session, _csrf_token).
 * Does NOT require georss to work (that may be blocked by IP regardless of login).
 *
 * Run: node setup.mjs
 */

import { chromium } from 'playwright';
import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const DIR          = dirname(fileURLToPath(import.meta.url));
const COOKIES_FILE = join(DIR, 'waze-cookies.json');

// Auth cookies that only exist when logged into Waze
const AUTH_COOKIES = ['_web_session', 'csrf_token', '_csrf_token', 'waze_session'];

async function getWazeCookies(context) {
  return context.cookies(['https://www.waze.com', 'https://waze.com']);
}

function isLoggedIn(cookies) {
  const names = cookies.map(c => c.name);
  return AUTH_COOKIES.some(n => names.includes(n));
}

console.log('\n══════════════════════════════════════════════════');
console.log('  RADAR — Waze login setup');
console.log('══════════════════════════════════════════════════\n');
console.log('A browser window will open at waze.com/login.');
console.log('Log in via Google (or email), then come back here.\n');

const browser = await chromium.launch({
  headless: false,
  args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
});

const context = await browser.newContext({
  userAgent:   'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  viewport:    { width: 1280, height: 800 },
  locale:      'en-AU',
  timezoneId:  'Australia/Sydney',
  geolocation: { latitude: -33.8688, longitude: 151.2093 },
  permissions: ['geolocation'],
});

await context.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  window.chrome = { runtime: {} };
});

const page = await context.newPage();
await page.goto('https://www.waze.com/en-GB/login', { waitUntil: 'domcontentloaded', timeout: 60_000 });

console.log('Browser open — log into Waze now.');
console.log('(Checking for auth cookies every 3 seconds...)\n');

let loggedIn = false;
for (let i = 0; i < 200; i++) { // wait up to ~10 min
  await new Promise(r => setTimeout(r, 3_000));
  const cookies = await getWazeCookies(context);
  if (isLoggedIn(cookies)) {
    loggedIn = true;
    console.log(`\n✓ Auth cookies detected: ${cookies.filter(c => AUTH_COOKIES.includes(c.name)).map(c => c.name).join(', ')}`);
    break;
  }
  if (i > 0 && i % 10 === 0) {
    const names = cookies.map(c => c.name);
    console.log(`Still waiting... (${Math.round((i+1)*3)}s) — cookies so far: ${names.slice(0,5).join(', ')}`);
  }
}

if (!loggedIn) {
  // Save whatever we have anyway and let the scraper try
  const cookies = await getWazeCookies(context);
  console.warn('\n⚠ No auth cookies detected after 10 min — saving what we have and continuing.');
  writeFileSync(COOKIES_FILE, JSON.stringify(cookies, null, 2));
  console.log(`Saved ${cookies.length} cookies.`);
  await browser.close();
  process.exit(0);
}

// Wait a moment for any additional cookies to settle after login
await new Promise(r => setTimeout(r, 3_000));

// Navigate to live-map to get all session cookies
await page.goto('https://www.waze.com/en-GB/live-map', { waitUntil: 'domcontentloaded', timeout: 30_000 });
await new Promise(r => setTimeout(r, 4_000));

const cookies = await context.cookies();
writeFileSync(COOKIES_FILE, JSON.stringify(cookies, null, 2));
console.log(`✓ Saved ${cookies.length} cookies → ${COOKIES_FILE}`);

// Quick georss test (informational only — 403 doesn't mean failure)
try {
  const georss = await page.evaluate(async () => {
    try {
      const r = await fetch('https://www.waze.com/live-map/api/georss?top=-33.5&bottom=-34.2&left=150.5&right=151.5&env=row&types=alerts&ma=1',
        { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
      return r.status;
    } catch { return 0; }
  });
  if (georss === 200) {
    console.log('✓ Georss API works! Police data will flow.');
  } else {
    console.log(`ℹ Georss returned ${georss} — IP may be restricted, but scraper will keep retrying.`);
  }
} catch {}

await browser.close();

console.log('\nStart the scraper:');
console.log('  pm2 start /Users/maverick/radar/scraper/ecosystem.config.cjs\n');
process.exit(0);
