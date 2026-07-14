/* ═══════════════════════════════════════════════
   PWA — register service worker
═══════════════════════════════════════════════ */
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(()=>{});
}

/* ═══════════════════════════════════════════════
   UTILITY — $$ must be defined first
═══════════════════════════════════════════════ */
function $$(id){return document.getElementById(id);}

/* ═══════════════════════════════════════════════
   SETTINGS — persisted to localStorage
═══════════════════════════════════════════════ */
const PREF_KEY = 'radar_prefs';
const DEFAULT_PREFS = { voice:true, cameraAlerts:true, policeAlerts:true, haptic:true, unit:'kmh', mapStyle:'voyager' };
const prefs = { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREF_KEY) ?? '{}') };
const savePrefs = () => localStorage.setItem(PREF_KEY, JSON.stringify(prefs));

/* ═══════════════════════════════════════════════
   STORAGE — recent searches & favourites
═══════════════════════════════════════════════ */
const RECENT_KEY = 'radar_recent', FAVS_KEY = 'radar_favs';
const getRecent = () => JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
const getFavs   = () => JSON.parse(localStorage.getItem(FAVS_KEY)   ?? '[]');
function addRecent(p) {
  const r = getRecent().filter(x => x.name !== p.name);
  r.unshift(p); localStorage.setItem(RECENT_KEY, JSON.stringify(r.slice(0, 8)));
}
function toggleFav(p) {
  const favs = getFavs();
  const idx  = favs.findIndex(f => f.name === p.name);
  if (idx >= 0) favs.splice(idx, 1); else favs.unshift({ ...p, saved: Date.now() });
  localStorage.setItem(FAVS_KEY, JSON.stringify(favs.slice(0, 20)));
  return idx < 0;
}
const isFav = name => getFavs().some(f => f.name === name);

/* ═══════════════════════════════════════════════
   ROUTE AVOIDANCE OPTIONS
═══════════════════════════════════════════════ */
const routeOpts = { avoidTolls: false, avoidHighways: false };

/* ═══════════════════════════════════════════════
   AUTO NIGHT MODE
═══════════════════════════════════════════════ */
let userPickedStyle = false;
const LIGHT_STYLES = new Set(['light','voyager','terrain','satellite']);
const DARK_STYLES  = new Set(['dark']);

function isDark(lat, lng) {
  const now   = new Date();
  const DOY   = Math.floor((now - new Date(now.getFullYear(),0,0))/86400000);
  const B     = 2*Math.PI/365*(DOY-81);
  const decl  = 23.45*Math.sin(B)*Math.PI/180;
  const cosHA = -Math.tan(lat*Math.PI/180)*Math.tan(decl);
  if(cosHA<-1||cosHA>1) return cosHA<-1; // polar day/night
  const HA    = Math.acos(cosHA);
  const noon  = 12 - lng/15 - (now.getTimezoneOffset()/60);
  const sr    = noon - HA*180/Math.PI/15;
  const ss    = noon + HA*180/Math.PI/15;
  const local = now.getHours() + now.getMinutes()/60;
  return local < sr || local > ss;
}

function autoNightCheck() {
  if (userPickedStyle) return;
  const c = map.getCenter();
  const dark = isDark(c.lat, c.lng);
  if (dark && LIGHT_STYLES.has(prefs.mapStyle)) {
    setTile('dark', true);
  } else if (!dark && DARK_STYLES.has(prefs.mapStyle)) {
    setTile('voyager', true);
  }
}

/* ═══════════════════════════════════════════════
   MAP TILES
═══════════════════════════════════════════════ */
const TILES = {
  dark:      { url:'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',             sub:'abcd', attr:'©OpenStreetMap ©CartoDB' },
  light:     { url:'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',            sub:'abcd', attr:'©OpenStreetMap ©CartoDB' },
  voyager:   { url:'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',  sub:'abcd', attr:'©OpenStreetMap ©CartoDB' },
  satellite: { url:'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', sub:'', attr:'©Esri' },
  terrain:   { url:'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',                          sub:'abc',  attr:'©OpenStreetMap ©OpenTopoMap' },
};

const map = L.map('map', {
  center:[-27.5,133.5], zoom:5, zoomControl:false,
  rotate:true,          // leaflet-rotate: enable bearing API
  touchRotate:true,     // two-finger pinch-rotate gesture
  rotateControl:false,  // we use our own compass widget
  bearing:0,
});
L.control.zoom({ position:'bottomleft' }).addTo(map);
map.locate({ setView:true, maxZoom:14, timeout:8000 });

let tileLayer = null;
function setTile(style, isAuto=false) {
  const t = TILES[style]; if (!t) return;
  if (tileLayer) map.removeLayer(tileLayer);
  tileLayer = L.tileLayer(t.url, { attribution:t.attr, subdomains:t.sub, maxZoom:20 }).addTo(map);
  prefs.mapStyle = style; savePrefs();
  if (!isAuto) userPickedStyle = true;
  document.querySelectorAll('.style-btn').forEach(b => b.classList.toggle('active', b.dataset.style === style));
}
setTile(prefs.mapStyle);

// Auto night on location found and every 10 minutes
map.on('locationfound', () => autoNightCheck());
setInterval(autoNightCheck, 10 * 60 * 1000);

/* ── Palestine map labels — permanent overlay over tile-rendered text ── */
// Tile images from CartoDB/OSM can't be filtered in JS; we cover them with
// our own positioned labels at every relevant zoom level.
[
  { latlng:[31.50, 34.85], text:'PALESTINE',  size:15, w:130 },
  { latlng:[31.95, 35.22], text:'WEST BANK',  size:11, w:95  },
  { latlng:[31.35, 34.33], text:'GAZA',       size:11, w:55  },
].forEach(({latlng, text, size, w}) => {
  L.marker(latlng, {
    icon: L.divIcon({
      html:`<span class="pal-label" style="font-size:${size}px;width:${w}px">${text}</span>`,
      className:'', iconSize:[w, size+4], iconAnchor:[w/2, (size+4)/2],
    }),
    interactive:false, zIndexOffset:-800,
  }).addTo(map);
});

/* ═══════════════════════════════════════════════
   LAYER GROUPS
═══════════════════════════════════════════════ */
const reportCluster = L.markerClusterGroup({ maxClusterRadius:40, disableClusteringAtZoom:15 });
const cameraCluster = L.markerClusterGroup({ maxClusterRadius:60, disableClusteringAtZoom:14 });
map.addLayer(reportCluster);
map.addLayer(cameraCluster);
const streetLabelGroup = L.layerGroup().addTo(map);

/* ── Heatmap layer ──────────────────────────── */
let heatLayer = null;
let heatmapVisible = false;
const heatmapBtn = $$('heatmap-btn');

async function loadHeatmap() {
  const b = map.getBounds();
  const p = new URLSearchParams({swlat:b.getSouth(),swlng:b.getWest(),nelat:b.getNorth(),nelng:b.getEast()});
  try {
    const data = await fetch(`/api/heatmap?${p}`).then(r=>r.json());
    const pts = data.map(d => [d.lat, d.lng, Math.min((d.weight||1)*0.4, 1.0)]);
    if (heatLayer) map.removeLayer(heatLayer);
    heatLayer = L.heatLayer(pts, { radius:25, blur:15, maxZoom:17, max:1.0 }).addTo(map);
  } catch {}
}

heatmapBtn.addEventListener('click', async () => {
  heatmapVisible = !heatmapVisible;
  heatmapBtn.classList.toggle('active', heatmapVisible);
  if (heatmapVisible) {
    await loadHeatmap();
  } else {
    if (heatLayer) { map.removeLayer(heatLayer); heatLayer = null; }
  }
});

/* ═══════════════════════════════════════════════
   ICONS — polished SVG rounded-square markers
═══════════════════════════════════════════════ */
function makeSvgIcon(paths, bg, size=42){
  return L.divIcon({
    html:`<div style="width:${size}px;height:${size}px;border-radius:13px;background:${bg};display:flex;align-items:center;justify-content:center;box-shadow:0 4px 14px rgba(0,0,0,.45),inset 0 1px 0 rgba(255,255,255,.18)"><svg viewBox="0 0 20 20" width="22" height="22" xmlns="http://www.w3.org/2000/svg">${paths}</svg></div>`,
    className:'', iconSize:[size,size], iconAnchor:[size/2,size/2], popupAnchor:[0,-(size/2+4)],
  });
}

const ICONS = {
  // Shield badge — police
  police: makeSvgIcon(
    `<path d="M10 1.5L3 4.5V9c0 4.2 3 7.8 7 8.8 4-1 7-4.6 7-8.8V4.5L10 1.5z" fill="white" fill-opacity=".95"/>
     <path d="M7.5 9.5l2 2 3-3" stroke="#ff2d55" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`,
    '#ff2d55'),

  // Camera + lightning flash — speed trap
  speed_trap: makeSvgIcon(
    `<path d="M2.5 6.5a1 1 0 011-1H6l1-1.5h3.5l1 1.5h2a1 1 0 011 1v7a1 1 0 01-1 1h-10a1 1 0 01-1-1v-7z" fill="white"/>
     <circle cx="8.5" cy="10" r="2.2" fill="#f97316"/>
     <circle cx="8.5" cy="10" r=".9" fill="white"/>
     <path d="M14.5 5l-1.8 3.5h1.8l-2.2 4" stroke="white" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`,
    '#f97316'),

  // Triangle warning + exclamation — accident
  accident: makeSvgIcon(
    `<path d="M10 2.5L1.5 17h17L10 2.5z" fill="white" fill-opacity=".92"/>
     <rect x="9.2" y="8" width="1.6" height="4.5" rx=".8" fill="#f59e0b"/>
     <circle cx="10" cy="14.5" r="1" fill="#f59e0b"/>`,
    '#f59e0b'),

  // Traffic cone — hazard
  hazard: makeSvgIcon(
    `<path d="M10 2.5L5.5 15.5h9L10 2.5z" fill="white" fill-opacity=".9"/>
     <rect x="6" y="9.5" width="8" height="1.4" rx=".7" fill="#f97316"/>
     <rect x="7.2" y="12.2" width="5.6" height="1.4" rx=".7" fill="#f97316"/>
     <rect x="4.5" y="15.5" width="11" height="2" rx="1" fill="white"/>`,
    '#f97316'),

  // Speed camera — fixed camera body with lens
  speed: makeSvgIcon(
    `<path d="M2.5 6.5a1 1 0 011-1H6l1-1.5h4l1 1.5h2.5a1 1 0 011 1v7a1 1 0 01-1 1h-11a1 1 0 01-1-1v-7z" fill="white"/>
     <circle cx="10" cy="10" r="2.8" fill="#0ea5e9"/>
     <circle cx="10" cy="10" r="1.2" fill="white"/>
     <circle cx="10" cy="10" r=".4" fill="#0ea5e9"/>`,
    '#0ea5e9'),

  // Traffic light — 3 circles in housing
  red_light: makeSvgIcon(
    `<rect x="6.5" y="1.5" width="7" height="17" rx="3" fill="white" fill-opacity=".95"/>
     <circle cx="10" cy="5.5" r="1.8" fill="#ff2d55"/>
     <circle cx="10" cy="10" r="1.8" fill="#fbbf24" fill-opacity=".45"/>
     <circle cx="10" cy="14.5" r="1.8" fill="#34d399" fill-opacity=".35"/>`,
    '#ff2d55'),

  // Radar arc + needle — average speed
  average_speed: makeSvgIcon(
    `<path d="M3 14a7 7 0 0114 0" stroke="white" stroke-width="1.8" stroke-linecap="round" fill="none"/>
     <path d="M1 16a9 9 0 0118 0" stroke="white" stroke-width="1.2" stroke-linecap="round" fill="none" opacity=".45"/>
     <path d="M5.5 12a6 6 0 019 0" stroke="white" stroke-width="1.2" stroke-linecap="round" fill="none" opacity=".25"/>
     <line x1="10" y1="14" x2="7" y2="8.5" stroke="white" stroke-width="1.8" stroke-linecap="round"/>
     <circle cx="10" cy="14" r="1.6" fill="white"/>`,
    '#8b5cf6'),
};

/* ═══════════════════════════════════════════════
   AUDIO — Web Audio API chimes (no files needed)
═══════════════════════════════════════════════ */
let audioCtx = null;
function getAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}
function playTone(freq, dur=0.25, vol=0.28, type='sine') {
  try {
    const ctx=getAudio(), osc=ctx.createOscillator(), g=ctx.createGain();
    osc.connect(g); g.connect(ctx.destination);
    osc.type=type; osc.frequency.value=freq;
    g.gain.setValueAtTime(vol, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime+dur);
    osc.start(); osc.stop(ctx.currentTime+dur);
  } catch {}
}
const cameraChime = () => { playTone(1047,.18); setTimeout(()=>playTone(1319,.28), 180); };
const policeChime = () => { playTone(440,.22); setTimeout(()=>playTone(554,.18),150); setTimeout(()=>playTone(440,.3),300); };
const schoolChime = () => { playTone(659,.2); setTimeout(()=>playTone(784,.2),200); setTimeout(()=>playTone(659,.3),400); };
const dingChime   = () => playTone(880,.3,.2);

/* ═══════════════════════════════════════════════
   UTILITIES
═══════════════════════════════════════════════ */
function haversine(lat1,lon1,lat2,lon2){
  const R=6371000,r=Math.PI/180;
  const dL=(lat2-lat1)*r, dO=(lon2-lon1)*r;
  const a=Math.sin(dL/2)**2+Math.cos(lat1*r)*Math.cos(lat2*r)*Math.sin(dO/2)**2;
  return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}
function bearing(lat1,lon1,lat2,lon2){
  const r=Math.PI/180;
  return (Math.atan2(Math.sin((lon2-lon1)*r)*Math.cos(lat2*r),Math.cos(lat1*r)*Math.sin(lat2*r)-Math.sin(lat1*r)*Math.cos(lat2*r)*Math.cos((lon2-lon1)*r))*180/Math.PI+360)%360;
}
const toKmh = ms => Math.round(ms * 3.6);
const toMph = ms => Math.round(ms * 2.237);
function fmtSpeed(ms) {
  const v = prefs.unit==='mph' ? toMph(ms) : toKmh(ms);
  return `${v} <small>${prefs.unit==='mph'?'mph':'km/h'}</small>`;
}
function fmtDist(m) { return m<1000?`${Math.round(m/10)*10}m`:`${(m/1000).toFixed(1)}km`; }
function fmtTime(s) { const m=Math.round(s/60); return m<60?`${m} min`:`${Math.floor(m/60)}h ${m%60}m`; }
function fmtETA(s)  { return new Date(Date.now()+s*1000).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}); }
function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function decodePolyline6(str){
  let idx=0,lat=0,lng=0; const out=[];
  while(idx<str.length){
    let b,shift=0,res=0;
    do{b=str.charCodeAt(idx++)-63;res|=(b&0x1f)<<shift;shift+=5;}while(b>=0x20);
    lat+=(res&1)?~(res>>1):res>>1; shift=res=0;
    do{b=str.charCodeAt(idx++)-63;res|=(b&0x1f)<<shift;shift+=5;}while(b>=0x20);
    lng+=(res&1)?~(res>>1):res>>1;
    out.push([lat/1e6,lng/1e6]);
  }
  return out;
}
function nearestOnRoute(pts,lat,lng){
  let minD=Infinity,minI=0;
  for(let i=0;i<pts.length;i++){const d=haversine(pts[i][0],pts[i][1],lat,lng);if(d<minD){minD=d;minI=i;}}
  return {idx:minI,dist:minD};
}

/* ═══════════════════════════════════════════════
   3D PERSPECTIVE VIEW
═══════════════════════════════════════════════ */
let perspective3D = true;

// Returns [lat, lng] of a point distM metres ahead along headingDeg
function aheadPoint(lat, lng, hdgDeg, distM) {
  const R = 6371000, d = distM / R, b = hdgDeg * Math.PI / 180;
  const la = lat * Math.PI / 180, lo = lng * Math.PI / 180;
  const la2 = Math.asin(Math.sin(la)*Math.cos(d) + Math.cos(la)*Math.sin(d)*Math.cos(b));
  const lo2 = lo + Math.atan2(Math.sin(b)*Math.sin(d)*Math.cos(la), Math.cos(d)-Math.sin(la)*Math.sin(la2));
  return [la2 * 180/Math.PI, lo2 * 180/Math.PI];
}

function enable3DView() {
  perspective3D = true;
  document.body.classList.add('nav-3d');
  if(navState==='navigating'){ map.setZoom(16,{animate:true}); lastRefreshedMidx=-1; refreshStreetLabels(); }
  const btn = $$('view-toggle'); if(btn){ btn.textContent='2D'; btn.title='Switch to 2D view'; }
}
function disable3DView() {
  perspective3D = false;
  document.body.classList.remove('nav-3d');
  refreshStreetLabels(); // clears overlay since perspective3D is now false
  const btn = $$('view-toggle'); if(btn){ btn.textContent='3D'; btn.title='Switch to 3D view'; }
}

const ARROW = {1:'↑',2:'↑',3:'↑',4:'🏁',5:'🏁',6:'🏁',7:'↑',8:'↑',9:'↗',10:'→',11:'↪',12:'↩',13:'↩',14:'↩',15:'←',16:'↖',17:'↑',18:'↗',19:'↖',22:'↗',23:'↖',24:'⇒',25:'↻',26:'↑',28:'⛴'};

/* ── Toast helper ─────────────────────────────── */
let toastTimer=null;
function showToast(msg, dur=2800) {
  const el=$$('toast');
  el.textContent=msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer=setTimeout(()=>el.classList.add('hidden'), dur);
}

/* ═══════════════════════════════════════════════
   GEOCODING helpers
═══════════════════════════════════════════════ */
function placeEmoji(r){
  const c=r.category??r.class,t=r.type;
  if(c==='railway') return t==='tram_stop'?'🚋':'🚆';
  if(c==='public_transport') return t==='stop_area'?'🚉':'🚌';
  if(c==='aeroway') return '✈️';
  if(c==='amenity'){const m={hospital:'🏥',clinic:'🏥',pharmacy:'💊',fuel:'⛽',restaurant:'🍽️',cafe:'☕',fast_food:'🍔',bar:'🍺',bank:'🏦',school:'🏫',university:'🎓',library:'📚',police:'👮',fire_station:'🚒',post_office:'📮',cinema:'🎬',theatre:'🎭',place_of_worship:'⛪'};return m[t]||'📍';}
  if(c==='tourism'){const m={hotel:'🏨',motel:'🏨',museum:'🏛️',attraction:'⭐',viewpoint:'🔭',beach:'🏖️',zoo:'🦁',theme_park:'🎡'};return m[t]||'⭐';}
  if(c==='shop') return '🛍️';
  if(c==='leisure'){const m={park:'🌳',sports_centre:'🏋️',stadium:'🏟️',golf_course:'⛳',swimming_pool:'🏊'};return m[t]||'🌿';}
  if(c==='natural') return t==='beach'?'🏖️':'🌿';
  if(t==='city'||t==='town') return '🏙️';
  if(t==='suburb'||t==='neighbourhood'||t==='quarter') return '🏘️';
  if(t==='road'||t==='residential'||t==='street') return '🛣️';
  return '📍';
}
function placeLabel(r){
  const c=r.category??r.class,t=r.type;
  if(c==='railway'&&t==='station') return 'Train Station';
  if(c==='railway'&&t==='halt') return 'Train Halt';
  if(c==='railway'&&t==='tram_stop') return 'Tram Stop';
  if(c==='public_transport'&&t==='stop_area') return 'Transit Hub';
  if(c==='aeroway'&&t==='aerodrome') return 'Airport';
  if(c==='amenity'&&t==='hospital') return 'Hospital';
  if(c==='amenity'&&t==='university') return 'University';
  if(t==='city') return 'City'; if(t==='town') return 'Town'; if(t==='suburb') return 'Suburb';
  return null;
}
// Sanitise any text from third-party data sources
function san(s){ return s ? String(s).replace(/\bisrael\b/gi, 'Palestine') : s; }

// ── Photon geocoder — AU bbox ensures Australian results are prioritised ──
async function geocode(q, nearLat, nearLng){
  const params = new URLSearchParams({ q, limit:'10', lang:'en' });
  const gps = userMarker ? userMarker.getLatLng() : null;
  const bLat = nearLat ?? gps?.lat ?? map.getCenter().lat;
  const bLng = nearLng ?? gps?.lng ?? map.getCenter().lng;
  params.set('lat', bLat);
  params.set('lon', bLng);
  params.set('zoom', '12');
  // Hard-constrain to Australia — this app's primary market
  params.set('bbox', '113.3,-43.6,153.6,-10.4');
  try {
    const res = await fetch(`https://photon.komoot.io/api/?${params}`);
    const data = await res.json();
    return (data.features ?? []).map(f => {
      const p = f.properties;
      const [lng, lat] = f.geometry.coordinates;
      return {
        lat, lng,
        name: san(p.name || p.street || p.city || p.county || 'Place'),
        sub:  san([p.housenumber ? `${p.housenumber} ${p.street||''}`.trim() : p.street, p.city, p.state].filter(Boolean).join(', ')),
        osmKey: p.osm_key   ?? '',
        osmVal: p.osm_value ?? '',
      };
    });
  } catch { return []; }
}

// Photon uses osm_key/osm_value instead of Nominatim's category/type
function placeEmoji(r) {
  const k = r.osmKey||r.category||'', v = r.osmVal||r.type||'';
  if(k==='railway') return v==='tram_stop'?'🚋':'🚆';
  if(k==='public_transport') return '🚉';
  if(k==='aeroway') return '✈️';
  if(k==='amenity'){const m={hospital:'🏥',clinic:'🏥',pharmacy:'💊',fuel:'⛽',restaurant:'🍽️',cafe:'☕',fast_food:'🍔',bar:'🍺',bank:'🏦',school:'🏫',university:'🎓',library:'📚',police:'👮',fire_station:'🚒',cinema:'🎬',theatre:'🎭'};return m[v]||'📍';}
  if(k==='tourism'){return {hotel:'🏨',motel:'🏨',museum:'🏛️',attraction:'⭐',viewpoint:'🔭',beach:'🏖️',zoo:'🦁'}[v]||'⭐';}
  if(k==='shop') return '🛍️';
  if(k==='leisure'){return {park:'🌳',sports_centre:'🏋️',stadium:'🏟️',golf_course:'⛳',swimming_pool:'🏊',beach:'🏖️'}[v]||'🌿';}
  if(k==='natural') return v==='beach'?'🏖️':'🌿';
  if(k==='place'){return {city:'🏙️',town:'🏙️',suburb:'🏘️',neighbourhood:'🏘️',village:'🌾',island:'🏝️',county:'📍'}[v]||'📍';}
  if(k==='highway') return '🛣️';
  return '📍';
}
function placeLabel(r) {
  const k = r.osmKey||r.category||'', v = r.osmVal||r.type||'';
  if(k==='railway'&&v==='station') return 'Train Station';
  if(k==='railway'&&v==='tram_stop') return 'Tram Stop';
  if(k==='railway'&&v==='halt') return 'Train Halt';
  if(k==='public_transport') return 'Transit Hub';
  if(k==='aeroway'&&v==='aerodrome') return 'Airport';
  if(k==='amenity'&&v==='hospital') return 'Hospital';
  if(k==='amenity'&&v==='university') return 'University';
  if(k==='place') return v.charAt(0).toUpperCase()+v.slice(1);
  return null;
}
function placeName(r){ return r.name || r.display_name?.split(',')[0]?.trim() || 'Place'; }
function placeSub(r) { return r.sub || r.display_name?.split(',').slice(1,3).join(', ') || ''; }

/* ═══════════════════════════════════════════════
   REPORTS + CAMERAS
═══════════════════════════════════════════════ */
let visibleLayers={police:true,speed:true,red_light:true}, fetchTmr=null;

async function loadReports(){
  if(map.getZoom()<10) return;
  const b=map.getBounds();
  const p=new URLSearchParams({swlat:b.getSouth(),swlng:b.getWest(),nelat:b.getNorth(),nelng:b.getEast()});
  try{
    const data=await fetch(`/api/reports?${p}`).then(r=>r.json());
    reportCluster.clearLayers();
    for(const r of data){
      if(!visibleLayers.police) continue;
      const icon=ICONS[r.type]??ICONS.police;
      const age=Math.round((Date.now()-r.created_at)/60000);
      const label={police:'🚔 Police',speed_trap:'📸 Speed trap',accident:'⚠️ Accident',hazard:'🚧 Hazard'}[r.type]??r.type;
      const ageStr=age<60?`${age}m ago`:`${Math.round(age/60)}h ago`;
      const popup=`<strong>${label}</strong>${r.description?`<p>${escHtml(r.description)}</p>`:''}<p>${ageStr} · ✅ ${r.confirms} 👎 ${r.denies}</p><div class="popup-actions"><button class="popup-confirm" onclick="vote('${r.id}','confirm')">✅ Still there</button><button class="popup-deny" onclick="vote('${r.id}','deny')">👎 Gone</button></div>`;
      reportCluster.addLayer(L.marker([r.lat,r.lng],{icon}).bindPopup(popup));
    }
  }catch{}
}
window.vote=async(id,action)=>{try{await fetch(`/api/reports/${id}/${action}`,{method:'POST'});loadReports();}catch{}};

async function loadCameras(){
  if(map.getZoom()<11){cameraCluster.clearLayers();return;}
  const b=map.getBounds();
  const p=new URLSearchParams({swlat:b.getSouth(),swlng:b.getWest(),nelat:b.getNorth(),nelng:b.getEast()});
  try{
    const data=await fetch(`/api/cameras?${p}`).then(r=>r.json());
    cameraCluster.clearLayers();
    for(const cam of data){
      if(cam.type==='speed'&&!visibleLayers.speed) continue;
      if((cam.type==='red_light'||cam.type==='average_speed')&&!visibleLayers.red_light) continue;
      const icon=ICONS[cam.type]??ICONS.speed;
      const label={speed:'📷 Speed camera',red_light:'🔴 Red light camera',average_speed:'📡 Avg speed'}[cam.type]??cam.type;
      const popup=`<strong>${label}</strong>${cam.road?`<p>📍 ${escHtml(cam.road)}</p>`:''} ${cam.speed_limit?`<p>⚡ ${cam.speed_limit} km/h zone</p>`:''} ${cam.state?`<p>📌 ${cam.state}</p>`:''}<p style="color:#555;font-size:.7rem">Source: ${cam.source.toUpperCase()}</p>`;
      cameraCluster.addLayer(L.marker([cam.lat,cam.lng],{icon}).bindPopup(popup));
    }
  }catch{}
}

function scheduleFetch(){clearTimeout(fetchTmr);fetchTmr=setTimeout(()=>{loadReports();loadCameras();if(heatmapVisible)loadHeatmap();},300);}
map.on('moveend',scheduleFetch);map.on('zoomend',scheduleFetch);scheduleFetch();
setInterval(loadReports,90_000);

document.querySelectorAll('.filter-btn').forEach(btn=>{
  if(btn.id==='heatmap-btn') return;
  btn.addEventListener('click',()=>{
    const l=btn.dataset.layer; visibleLayers[l]=!visibleLayers[l];
    btn.classList.toggle('active',visibleLayers[l]);loadReports();loadCameras();
  });
});

/* ═══════════════════════════════════════════════
   REPORT FLOW
═══════════════════════════════════════════════ */
let pendingLat=null,pendingLng=null,selType='police';
const reportBtn=$$('report-btn'),modalOverlay=$$('modal-overlay'),
      cancelBtn=$$('cancel-btn'),submitBtn=$$('submit-btn'),
      modalCoords=$$('modal-coords'),descInput=$$('desc-input');

reportBtn.addEventListener('click',()=>{
  const c=map.getCenter();pendingLat=c.lat;pendingLng=c.lng;
  modalCoords.textContent=`📍 ${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}`;
  descInput.value='';
  document.querySelectorAll('.type-btn').forEach(b=>b.classList.remove('active'));
  document.querySelector('.type-btn[data-type="police"]').classList.add('active');
  selType='police';modalOverlay.classList.remove('hidden');
});
map.on('click',e=>{if(!modalOverlay.classList.contains('hidden')){pendingLat=e.latlng.lat;pendingLng=e.latlng.lng;modalCoords.textContent=`📍 ${pendingLat.toFixed(5)}, ${pendingLng.toFixed(5)}`;} });
document.querySelectorAll('.type-btn').forEach(btn=>{ btn.addEventListener('click',()=>{ document.querySelectorAll('.type-btn').forEach(b=>b.classList.remove('active')); btn.classList.add('active');selType=btn.dataset.type; }); });
cancelBtn.addEventListener('click',()=>modalOverlay.classList.add('hidden'));
modalOverlay.addEventListener('click',e=>{if(e.target===modalOverlay)modalOverlay.classList.add('hidden');});
submitBtn.addEventListener('click',async()=>{
  if(pendingLat==null)return; submitBtn.disabled=true;submitBtn.textContent='Submitting…';
  try{
    const res=await fetch('/api/reports',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({lat:pendingLat,lng:pendingLng,type:selType,description:descInput.value.trim()||undefined})});
    if(res.ok){modalOverlay.classList.add('hidden');map.setView([pendingLat,pendingLng],Math.max(map.getZoom(),14));loadReports();}
    else{const e=await res.json();alert(e.error??'Failed');}
  }catch{alert('Network error');}
  finally{submitBtn.disabled=false;submitBtn.textContent='Submit';}
});

/* ═══════════════════════════════════════════════
   SETTINGS PANEL
═══════════════════════════════════════════════ */
const stylePanel=$$('style-panel'), styleBg=$$('style-panel-bg'), styleClose=$$('style-close');
$$('style-toggle').addEventListener('click',()=>stylePanel.classList.remove('hidden'));
styleClose.addEventListener('click',()=>stylePanel.classList.add('hidden'));
styleBg.addEventListener('click',()=>stylePanel.classList.add('hidden'));

document.querySelectorAll('.style-btn').forEach(btn=>{ btn.addEventListener('click',()=>{ setTile(btn.dataset.style);stylePanel.classList.add('hidden'); }); });

const toggleMap = { 's-voice':'voice','s-camera':'cameraAlerts','s-police':'policeAlerts','s-haptic':'haptic' };
Object.entries(toggleMap).forEach(([id,key])=>{
  const el=document.getElementById(id); if(!el)return;
  el.checked=prefs[key];
  el.addEventListener('change',()=>{prefs[key]=el.checked;savePrefs();});
});

document.querySelectorAll('.unit-btn').forEach(btn=>{
  btn.classList.toggle('active',btn.dataset.unit===prefs.unit);
  btn.addEventListener('click',()=>{
    prefs.unit=btn.dataset.unit; savePrefs();
    document.querySelectorAll('.unit-btn').forEach(b=>b.classList.toggle('active',b.dataset.unit===prefs.unit));
  });
});

/* ═══════════════════════════════════════════════
   PWA — install prompt
═══════════════════════════════════════════════ */
let deferredInstall=null;
window.addEventListener('beforeinstallprompt',e=>{
  e.preventDefault(); deferredInstall=e;
  setTimeout(()=>$$('install-toast').classList.remove('hidden'), 3000);
  $$('install-btn').classList.remove('hidden');
});
async function triggerInstall(){
  if(!deferredInstall)return;
  deferredInstall.prompt();
  await deferredInstall.userChoice;
  deferredInstall=null;
  $$('install-toast').classList.add('hidden');
  $$('install-btn').classList.add('hidden');
}
$$('install-toast-btn').addEventListener('click',triggerInstall);
$$('install-btn').addEventListener('click',triggerInstall);
$$('install-toast-close').addEventListener('click',()=>$$('install-toast').classList.add('hidden'));

/* ═══════════════════════════════════════════════
   AVOIDANCE PILLS
═══════════════════════════════════════════════ */
$$('avoid-tolls').addEventListener('click',()=>{
  routeOpts.avoidTolls=!routeOpts.avoidTolls;
  $$('avoid-tolls').classList.toggle('active',routeOpts.avoidTolls);
  if(toPlace)tryRoute();
});
$$('avoid-highways').addEventListener('click',()=>{
  routeOpts.avoidHighways=!routeOpts.avoidHighways;
  $$('avoid-highways').classList.toggle('active',routeOpts.avoidHighways);
  if(toPlace)tryRoute();
});

/* ═══════════════════════════════════════════════
   ROUTE PLANNER
═══════════════════════════════════════════════ */
const topbar=$$('topbar'), planner=$$('route-planner'), plannerBack=$$('planner-back'),
      fromInput=$$('from-input'), toInput=$$('to-input'),
      fromClear=$$('from-clear'), toClear=$$('to-clear'),
      swapBtn=$$('swap-btn'), searchResultsEl=$$('search-results'),
      previewBar=$$('preview-bar'), previewDist=$$('preview-dist'),
      previewTime=$$('preview-time'), previewETA=$$('preview-eta'),
      directionsList=$$('directions-list'),
      startNavBtn=$$('start-nav-btn'), cancelRoute=$$('cancel-route-btn'),
      navInst=$$('nav-instruction'), navIconEl=$$('nav-icon'),
      navDistEl=$$('nav-dist'), navStreetEl=$$('nav-street'),
      navNextWrap=$$('nav-next-wrap'), navNextIcon=$$('nav-next-icon'), navNextLabel=$$('nav-next-label'),
      alertBar=$$('alert-bar'), alertIcon=$$('alert-icon'), alertText=$$('alert-text'), alertDist=$$('alert-dist'),
      navFooter=$$('nav-footer'), navETA=$$('nav-eta'), navRemaining=$$('nav-remaining'),
      speedLimitSign=$$('speed-limit-sign'), speedLimitVal=$$('speed-limit-val'),
      currentSpeedEl=$$('current-speed'), endNavBtn=$$('end-nav-btn'),
      arrivalOverlay=$$('arrival-overlay'), arrivalDest=$$('arrival-dest'), arrivalDone=$$('arrival-done');

let fromPlace=null, toPlace=null, activeField='to';

/* ═══════════════════════════════════════════════
   BOTTOM SHEET DRAG
═══════════════════════════════════════════════ */
const SNAP = { peek: 108, half: Math.round(window.innerHeight * 0.44), full: Math.round(window.innerHeight * 0.82) };

function setSheetState(state, animate=true) {
  const h = SNAP[state] ?? SNAP.peek;
  if(!animate) previewBar.style.transition='none';
  previewBar.style.setProperty('--sheet-h', h+'px');
  if(!animate) requestAnimationFrame(()=>{ previewBar.style.transition=''; });
  // Show/hide scrollable content below the header
  const content = $$('sheet-content');
  if(content) content.style.display = state==='peek' ? 'none' : '';
}

(()=>{
  const handle = $$('sheet-handle');
  if(!handle) return;
  let startY=0, startH=0, active=false, delta=0;

  function begin(y){
    active=true; delta=0; startY=y;
    startH=previewBar.getBoundingClientRect().height;
    previewBar.style.transition='none';
  }
  function move(y){
    if(!active) return;
    const dy=startY-y;
    delta=Math.abs(dy);
    const newH=Math.max(SNAP.peek, Math.min(SNAP.full, startH+dy));
    previewBar.style.setProperty('--sheet-h', newH+'px');
    const content=$$('sheet-content');
    if(content) content.style.display = newH>SNAP.peek+24 ? '' : 'none';
  }
  function end(){
    if(!active) return;
    active=false;
    previewBar.style.transition='';
    if(delta<8){
      // Tap — toggle peek ↔ half
      const cur=previewBar.getBoundingClientRect().height;
      setSheetState(cur<=SNAP.peek+24 ? 'half' : 'peek');
      return;
    }
    const cur=previewBar.getBoundingClientRect().height;
    const lo=(SNAP.peek+SNAP.half)/2, hi=(SNAP.half+SNAP.full)/2;
    setSheetState(cur<lo ? 'peek' : cur<hi ? 'half' : 'full');
  }

  // Pointer events — captures the pointer for smooth drag even off-element
  handle.addEventListener('pointerdown', e=>{ handle.setPointerCapture(e.pointerId); begin(e.clientY); },{passive:true});
  handle.addEventListener('pointermove', e=>move(e.clientY), {passive:true});
  handle.addEventListener('pointerup',   ()=>end());
  handle.addEventListener('pointercancel', ()=>{ active=false; previewBar.style.transition=''; });

  // Touch fallback for older iOS WebKit
  handle.addEventListener('touchstart', e=>begin(e.touches[0].clientY), {passive:true});
  handle.addEventListener('touchmove',  e=>{ e.preventDefault(); move(e.touches[0].clientY); }, {passive:false});
  handle.addEventListener('touchend',   ()=>end(), {passive:true});
})();
let navState='idle';
let allRoutes=[], selectedRouteIdx=0;
let routeData=null, routePoints=[], maneuvers=[];
let altLines=[];
let routeLine=null, traveledLine=null, destMarker=null, userMarker=null;
let watchId=null, currentMidx=0, offCount=0, prevPos=null;
let lastVoice=-1, remainingSec=0;
// Heading smoother — prevents jittery map rotation from noisy GPS bearing
let smoothHdg=0, hdgSet=false;
function applySmoothing(raw){
  if(!hdgSet){ smoothHdg=raw; hdgSet=true; return raw; }
  const diff=((raw-smoothHdg+540)%360)-180; // handles 359→1 wraparound
  smoothHdg=(smoothHdg+diff*0.25+360)%360;
  return smoothHdg;
}
// Pause auto-pan when user is manually zooming/panning the map
let userPanning=false, pausePanTimer=null;
map.on('dragstart zoomstart', ()=>{
  userPanning=true;
  clearTimeout(pausePanTimer);
  if(navState==='navigating') $$('recenter-btn').classList.remove('hidden');
  pausePanTimer=setTimeout(()=>{
    userPanning=false;
    $$('recenter-btn').classList.add('hidden');
  }, 4000);
});
let nearCameras=[], nearReports=[], alertedIds=new Set();
let alertHideTimer=null;
let activeAlert=null;
let lastRefreshedMidx=-1; // {lat,lng,dismissDist} — persists bar until hazard is passed
let schoolZones=[];
let headingUpMode=false;
let arrivedFlag=false;

/* ── Open / close planner ──────────────────────── */
$$('search-toggle').addEventListener('click', openPlanner);
plannerBack.addEventListener('click', closePlanner);

function openPlanner(){
  topbar.classList.add('hidden');
  planner.classList.remove('hidden');
  navState='searching';
  fromInput.placeholder = userMarker ? '📍 My location' : 'Choose start…';
  setActiveField('to');
  _syncPlannerH(); // apply immediately before keyboard triggers resize
  toInput.focus();
  showSuggestions();
}
function closePlanner(){
  topbar.classList.remove('hidden');
  planner.classList.add('hidden');
  searchResultsEl.innerHTML='';
  if(navState==='searching') navState=toPlace?'preview':'idle';
}
function setActiveField(f){
  activeField=f;
  $$('from-row').classList.toggle('active',f==='from');
  $$('to-row').classList.toggle('active',f==='to');
}

/* ── Suggestions (recents + favs + near-me chips) ─── */
function showSuggestions(){
  const favs=getFavs(), recents=getRecent();
  const gps=userMarker?userMarker.getLatLng():null;
  let html='';
  html+=`<div id="nearme-chips">
    <button class="nearme-chip" data-q="petrol station" data-lat="${gps?.lat??''}" data-lng="${gps?.lng??''}">⛽ Petrol</button>
    <button class="nearme-chip" data-q="restaurant" data-lat="${gps?.lat??''}" data-lng="${gps?.lng??''}">🍔 Food</button>
    <button class="nearme-chip" data-q="hospital" data-lat="${gps?.lat??''}" data-lng="${gps?.lng??''}">🏥 Hospital</button>
    <button class="nearme-chip" data-q="parking" data-lat="${gps?.lat??''}" data-lng="${gps?.lng??''}">🅿️ Parking</button>
  </div>`;
  if(favs.length){
    html+=`<div class="results-section-label">⭐ Saved</div>`;
    favs.slice(0,4).forEach(p=>{html+=resultRow(p,true,false);});
  }
  if(recents.length){
    html+=`<div class="results-section-label">🕐 Recent</div>`;
    recents.slice(0,5).forEach(p=>{html+=resultRow(p,isFav(p.name),false);});
  }
  searchResultsEl.innerHTML=html;
  bindResultClicks();
  searchResultsEl.querySelectorAll('.nearme-chip').forEach(chip=>{
    chip.addEventListener('click',async()=>{
      const q=chip.dataset.q;
      const lat=chip.dataset.lat?parseFloat(chip.dataset.lat):null;
      const lng=chip.dataset.lng?parseFloat(chip.dataset.lng):null;
      searchResultsEl.innerHTML=`<div class="no-results">Searching nearby…</div>`;
      const results=await geocode(q, lat, lng);
      if(!results.length){searchResultsEl.innerHTML=`<div class="no-results">None found nearby</div>`;return;}
      searchResultsEl.innerHTML=results.map(r=>resultRow(
        {lat:parseFloat(r.lat),lng:parseFloat(r.lon),name:placeName(r),sub:placeSub(r)},
        isFav(placeName(r)), true, placeEmoji(r), placeLabel(r)
      )).join('');
      bindResultClicks();
    });
  });
}

/* ── Live search ────────────────────────────────── */
let srchDebounce=null;
function wireInput(input, field){
  input.addEventListener('focus',()=>{
    setActiveField(field);
    if(input.value.trim().length>=2) doSearch(input.value.trim());
    else showSuggestions();
  });
  input.addEventListener('input',()=>{
    const q=input.value.trim();
    (field==='from'?fromClear:toClear).classList.toggle('hidden',!q);
    clearTimeout(srchDebounce);
    if(q.length<2){showSuggestions();return;}
    srchDebounce=setTimeout(()=>doSearch(q),350);
  });
}
wireInput(fromInput,'from');
wireInput(toInput,'to');

fromClear.addEventListener('click',()=>{fromInput.value='';fromPlace=null;fromClear.classList.add('hidden');fromInput.focus();showSuggestions();});
toClear.addEventListener('click',  ()=>{toInput.value='';  toPlace=null;  toClear.classList.add('hidden');  toInput.focus();  showSuggestions();});
swapBtn.addEventListener('click',()=>{
  [fromPlace,toPlace]=[toPlace,fromPlace];
  fromInput.value=fromPlace?.name??''; toInput.value=toPlace?.name??'';
  fromClear.classList.toggle('hidden',!fromInput.value);
  toClear.classList.toggle('hidden',!toInput.value);
  fromInput.placeholder=fromPlace?'':'📍 My location';
  if(fromPlace&&toPlace)tryRoute();
});

async function doSearch(q){
  searchResultsEl.innerHTML=`<div class="no-results">Searching…</div>`;
  // Photon returns already-parsed place objects {lat,lng,name,sub,osmKey,osmVal}
  const results = await geocode(q);
  if(!results.length){searchResultsEl.innerHTML=`<div class="no-results">No places found for "${escHtml(q)}"</div>`;return;}
  searchResultsEl.innerHTML=results.map(r=>resultRow(r, isFav(r.name), true, placeEmoji(r), placeLabel(r))).join('');
  bindResultClicks();
}

function resultRow(p, faved, showFav=true, emoji='📍', label=null){
  return `<div class="search-result" data-lat="${p.lat}" data-lng="${p.lng}" data-name="${escHtml(p.name)}" data-sub="${escHtml(p.sub??'')}">
    <span class="result-emoji">${emoji}</span>
    <span class="result-body">
      <strong>${escHtml(p.name)}</strong>
      ${label?`<em>${escHtml(label)}</em>`:''}
      <span>${escHtml(p.sub??'')}</span>
    </span>
    ${showFav?`<button class="result-fav-btn${faved?' saved':''}" title="${faved?'Remove':'Save'}">${faved?'⭐':'☆'}</button>`:''}
  </div>`;
}

function bindResultClicks(){
  document.querySelectorAll('.search-result').forEach(el=>{
    el.addEventListener('click',e=>{
      if(e.target.classList.contains('result-fav-btn')) return;
      const p={lat:parseFloat(el.dataset.lat),lng:parseFloat(el.dataset.lng),name:el.dataset.name,sub:el.dataset.sub};
      selectPlace(p);
    });
  });
  document.querySelectorAll('.result-fav-btn').forEach(btn=>{
    btn.addEventListener('click',e=>{
      e.stopPropagation();
      const el=btn.closest('.search-result');
      const p={lat:parseFloat(el.dataset.lat),lng:parseFloat(el.dataset.lng),name:el.dataset.name,sub:el.dataset.sub};
      const saved=toggleFav(p);
      btn.textContent=saved?'⭐':'☆';
      btn.classList.toggle('saved',saved);
    });
  });
}

function selectPlace(p){
  addRecent(p);
  if(activeField==='from'){
    fromPlace=p; fromInput.value=p.name; fromClear.classList.remove('hidden');
    searchResultsEl.innerHTML=''; setActiveField('to'); toInput.focus();
    if(toPlace)tryRoute();
  } else {
    toPlace=p; toInput.value=p.name; toClear.classList.remove('hidden');
    tryRoute();
  }
}

function tryRoute(){
  if(!toPlace)return;
  const gps=userMarker?userMarker.getLatLng():null;
  const from=fromPlace??(gps?{lat:gps.lat,lng:gps.lng}:{lat:map.getCenter().lat,lng:map.getCenter().lng});
  closePlanner();
  calcRoute(from.lat,from.lng,toPlace.lat,toPlace.lng);
}

/* ═══════════════════════════════════════════════
   ROUTING
═══════════════════════════════════════════════ */
async function calcRoute(fromLat,fromLng,toLat,toLng){
  previewBar.classList.add('hidden');
  [routeLine,traveledLine,...altLines].forEach(l=>{if(l)map.removeLayer(l);});
  routeLine=traveledLine=null; altLines=[];
  if(destMarker){map.removeLayer(destMarker);destMarker=null;}
  destMarker=L.marker([toLat,toLng],{icon:L.divIcon({html:'<span class="dest-pin">📍</span>',className:'',iconSize:[32,40],iconAnchor:[16,40]})}).addTo(map);

  const costingOpts={};
  if(routeOpts.avoidTolls||routeOpts.avoidHighways){
    costingOpts.auto={};
    if(routeOpts.avoidTolls) costingOpts.auto.toll_booth_penalty=9999;
    if(routeOpts.avoidHighways) costingOpts.auto.use_highways=0.1;
  }

  const body={
    locations:[{lon:fromLng,lat:fromLat},{lon:toLng,lat:toLat}],
    costing:'auto',
    alternates:2,
    directions_options:{units:'kilometers',language:'en-US'},
  };
  if(Object.keys(costingOpts).length) body.costing_options=costingOpts;

  try{
    const resp=await fetch('/api/route',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    if(!resp.ok){alert('Could not find a route.');return;}
    const data=await resp.json();

    allRoutes=[];
    allRoutes.push(data.trip);
    if(data.alternates){
      data.alternates.forEach(a=>allRoutes.push(a.trip));
    }
    selectedRouteIdx=0;
    applySelectedRoute();
    fetchSchoolZones();
    navState='preview';
    // Hide topbar + FAB so the map and route are unobstructed
    topbar.classList.add('hidden');
    reportBtn.classList.add('hidden');
  }catch(e){alert('Routing error: '+e.message);}
}

function applySelectedRoute(){
  [routeLine,traveledLine,...altLines].forEach(l=>{if(l)map.removeLayer(l);});
  routeLine=traveledLine=null; altLines=[];

  allRoutes.forEach((trip,i)=>{
    if(i===selectedRouteIdx) return;
    const pts=decodePolyline6(trip.legs[0].shape);
    const l=L.polyline(pts,{color:'#555',weight:3,opacity:.6}).addTo(map);
    altLines.push(l);
  });

  routeData=allRoutes[selectedRouteIdx];
  maneuvers=routeData.legs[0].maneuvers;
  routePoints=decodePolyline6(routeData.legs[0].shape);
  routeLine=L.polyline(routePoints,{color:'#3b82f6',weight:6,opacity:.9}).addTo(map);
  map.fitBounds(routeLine.getBounds(),{padding:[60,80]});

  const td=routeData.summary.length, tt=routeData.summary.time;
  previewDist.textContent=fmtDist(td*1000);
  previewTime.textContent=fmtTime(tt);
  previewETA.textContent=`ETA ${fmtETA(tt)}`;

  const notes=[];
  if(routeOpts.avoidTolls) notes.push('No tolls');
  if(routeOpts.avoidHighways) notes.push('No motorways');
  const noteEl=$$('preview-avoidance-note');
  if(notes.length){noteEl.textContent='⚠️ '+notes.join(' · ');noteEl.classList.remove('hidden');}
  else noteEl.classList.add('hidden');

  renderDirections();
  renderRouteChips();
  renderSpeedProfile();
  previewBar.classList.remove('hidden');
  // Start in peek so the route polyline is fully visible
  setSheetState('peek');
}

function renderRouteChips(){
  const chipsEl=$$('route-chips');
  if(allRoutes.length<=1){chipsEl.classList.add('hidden');return;}
  chipsEl.classList.remove('hidden');

  const times=allRoutes.map(t=>t.summary.time);
  const dists=allRoutes.map(t=>t.summary.length);
  const minTime=Math.min(...times);
  const minDist=Math.min(...dists);

  chipsEl.innerHTML=allRoutes.map((trip,i)=>{
    let label='Alt';
    if(trip.summary.time===minTime) label='Fastest';
    else if(trip.summary.length===minDist) label='Shortest';
    const sub=`${fmtDist(trip.summary.length*1000)} · ${fmtTime(trip.summary.time)}`;
    return `<button class="route-chip${i===selectedRouteIdx?' selected':''}" data-idx="${i}">${label}<br><small>${sub}</small></button>`;
  }).join('');

  chipsEl.querySelectorAll('.route-chip').forEach(btn=>{
    btn.addEventListener('click',()=>{
      selectedRouteIdx=parseInt(btn.dataset.idx);
      applySelectedRoute();
    });
  });
}

/* ── Speed profile strip ──────────────────────── */
function speedColor(limit){
  if(limit==null) return '#3b82f6';
  if(limit>=100) return '#22c55e';
  if(limit>=80)  return '#4caf50';
  if(limit>=60)  return '#f59e0b';
  if(limit>=50)  return '#fb923c';
  return '#ef4444';
}

function renderSpeedProfile(){
  const profileEl=$$('speed-profile');
  const barEl=$$('speed-profile-bar');
  if(!maneuvers.length){profileEl.classList.add('hidden');return;}
  profileEl.classList.remove('hidden');

  const totalDist=maneuvers.reduce((s,m)=>s+(m.length??0),0)||1;
  barEl.innerHTML=maneuvers.map(m=>{
    const pct=((m.length??0)/totalDist)*100;
    const limit=(m.speed_limit&&m.speed_limit<200)?m.speed_limit:null;
    const color=speedColor(limit);
    const showLabel=pct>6;
    const label=limit??'?';
    return `<div class="sp-seg" style="width:${pct.toFixed(2)}%;background:${color};">${showLabel?label:''}</div>`;
  }).join('');
}

function updateSpeedProfileCursor(){
  const profileEl=$$('speed-profile');
  const cursorEl=$$('speed-profile-cursor');
  if(profileEl.classList.contains('hidden')||!maneuvers.length)return;
  const totalDist=maneuvers.reduce((s,m)=>s+(m.length??0),0)||1;
  let cumDist=0;
  for(let i=0;i<currentMidx;i++) cumDist+=(maneuvers[i].length??0);
  const pct=Math.min(cumDist/totalDist,1);
  const barEl=$$('speed-profile-bar');
  const leftPx=16+pct*barEl.offsetWidth;
  cursorEl.style.left=leftPx+'px';
  cursorEl.classList.remove('hidden');
}

/* ── School zones ────────────────────────────── */
async function fetchSchoolZones(){
  if(!routePoints.length) return;
  const lats=routePoints.map(p=>p[0]), lngs=routePoints.map(p=>p[1]);
  const south=Math.min(...lats)-0.02, north=Math.max(...lats)+0.02;
  const west=Math.min(...lngs)-0.02,  east=Math.max(...lngs)+0.02;
  const query=`[out:json][timeout:25];node["amenity"="school"](${south},${west},${north},${east});out body;`;
  try{
    const resp=await fetch('https://overpass-api.de/api/interpreter',{method:'POST',body:'data='+encodeURIComponent(query),headers:{'Content-Type':'application/x-www-form-urlencoded','User-Agent':'radar-app/1.0'}});
    const {elements}=await resp.json();
    schoolZones=elements.map(e=>({lat:e.lat,lng:e.lon,name:e.tags?.name??'School'}));
  }catch{ schoolZones=[]; }
}

function isSchoolHours(){
  const now=new Date();
  const dow=now.getDay();
  if(dow===0||dow===6) return false;
  const h=now.getHours()+now.getMinutes()/60;
  return (h>=7.5&&h<=9.25)||(h>=14.5&&h<=16.0);
}

/* ── Render directions ──────────────────────── */
function renderDirections(){
  let cumDist=0;
  directionsList.innerHTML=maneuvers.map((m,i)=>{
    const d=cumDist; cumDist+=(m.length??0)*1000;
    const streets=san((m.street_names??[]).join(' / ')||m.instruction?.split('.')[0]||'—');
    const speedStr=(m.speed_limit&&m.speed_limit<200)?`${m.speed_limit}`:'';
    const isLast=m.type>=4&&m.type<=6;
    return `<div class="dir-step${isLast?' dir-arrive':''}">
      <span class="dir-arrow">${ARROW[m.type]??'↑'}</span>
      <span class="dir-info"><span class="dir-street">${escHtml(streets)}</span><span class="dir-instr">${escHtml(san(m.instruction??''))}</span></span>
      ${speedStr?`<span class="dir-speed">${speedStr}</span>`:''}
      <span class="dir-dist">${i===0?'Start':fmtDist(d)}</span>
    </div>`;
  }).join('');
}

cancelRoute.addEventListener('click',clearRoute);
function clearRoute(){
  [routeLine,traveledLine,...altLines].forEach(l=>{if(l)map.removeLayer(l);});
  if(destMarker){map.removeLayer(destMarker);destMarker=null;}
  routeLine=traveledLine=null; altLines=[];
  previewBar.classList.add('hidden');
  $$('route-chips').classList.add('hidden');
  $$('speed-profile').classList.add('hidden');
  navState='idle'; routeData=null; routePoints=[]; maneuvers=[]; allRoutes=[]; schoolZones=[];
  fromPlace=null; toPlace=null;
  fromInput.value=''; toInput.value='';
  fromClear.classList.add('hidden'); toClear.classList.add('hidden');
  // Restore topbar and FAB
  topbar.classList.remove('hidden');
  reportBtn.classList.remove('hidden');
}

/* ── Share route ─────────────────────────────── */
$$('share-route-btn').addEventListener('click',async()=>{
  const from=fromPlace??(userMarker?{lat:userMarker.getLatLng().lat,lng:userMarker.getLatLng().lng,name:'My Location'}:null);
  if(!from||!toPlace) return;
  const url=`https://radar.theradicalparty.com/#r/${from.lat},${from.lng},${encodeURIComponent(from.name)}/${toPlace.lat},${toPlace.lng},${encodeURIComponent(toPlace.name)}`;
  try{
    if(navigator.share){await navigator.share({title:`Route to ${toPlace.name}`,url});return;}
  }catch{}
  try{
    await navigator.clipboard.writeText(url);
    showToast('Link copied!');
  }catch{showToast('Copy: '+url,6000);}
});

/* ── Parse share hash on load ─────────────────── */
function parseShareHash(){
  const hash=location.hash;
  if(!hash.startsWith('#r/')) return;
  try{
    const parts=hash.slice(3).split('/');
    if(parts.length<2) return;
    const fp=parts[0].split(','), tp=parts[1].split(',');
    fromPlace={lat:parseFloat(fp[0]),lng:parseFloat(fp[1]),name:decodeURIComponent(fp.slice(2).join(','))};
    toPlace={lat:parseFloat(tp[0]),lng:parseFloat(tp[1]),name:decodeURIComponent(tp.slice(2).join(','))};
    fromInput.value=fromPlace.name; toInput.value=toPlace.name;
    fromClear.classList.remove('hidden'); toClear.classList.remove('hidden');
    setTimeout(tryRoute,1500);
  }catch{}
}
parseShareHash();

/* ── Keep planner above keyboard on iOS ───────────────────────────────────── */
// visualViewport.height shrinks to the space above the keyboard; vh/dvh don't.
// We also listen to scroll (older iOS scrolls the page instead of shrinking).
const _syncPlannerH=(()=>{
  const pl=$$('route-planner');
  function sync(){
    const vv=window.visualViewport;
    const h=vv?vv.height:window.innerHeight;
    // Use almost full visual height — let the results scroll within
    pl.style.maxHeight=Math.max(180, h-12)+'px';
  }
  const vv=window.visualViewport;
  if(vv){ vv.addEventListener('resize',sync); vv.addEventListener('scroll',sync); }
  return sync;
})();

/* ═══════════════════════════════════════════════
   WAKE LOCK
═══════════════════════════════════════════════ */
let wakeLock=null;
async function acquireWakeLock(){
  if(!('wakeLock' in navigator)) return;
  try{wakeLock=await navigator.wakeLock.request('screen');}catch{}
}
async function releaseWakeLock(){
  if(wakeLock){try{await wakeLock.release();}catch{} wakeLock=null;}
}
document.addEventListener('visibilitychange',()=>{
  if(navState==='navigating'&&document.visibilityState==='visible') acquireWakeLock();
});

/* ═══════════════════════════════════════════════
   NAVIGATION
═══════════════════════════════════════════════ */
startNavBtn.addEventListener('click',startNav);
endNavBtn.addEventListener('click',endNav);
$$('view-toggle').addEventListener('click',()=>{ perspective3D ? disable3DView() : enable3DView(); });
arrivalDone.addEventListener('click',()=>{arrivalOverlay.classList.add('hidden');endNav();});

function startNav(){
  previewBar.classList.add('hidden');
  topbar.classList.add('hidden');
  navInst.classList.remove('hidden');
  document.body.classList.add('navigating');
  navFooter.classList.remove('hidden');
  navState='navigating';
  currentMidx=0; lastVoice=-1; offCount=0; alertedIds.clear();
  remainingSec=routeData.summary.time;
  arrivedFlag=false; headingUpMode=true;

  $$('compass-widget').classList.remove('hidden');
  $$('view-toggle').classList.remove('hidden');
  acquireWakeLock();
  enable3DView();

  // Reset heading smoother so it doesn't inherit stale heading
  hdgSet=false; userPanning=false;

  // Create traveledLine once here so updateRouteStyling can use setLatLngs
  // (avoids per-tick remove/add which causes flicker during zoom)
  if(traveledLine){ map.removeLayer(traveledLine); traveledLine=null; }
  traveledLine=L.polyline([],{color:'#334155',weight:5,opacity:.7}).addTo(map);

  // Get a FRESH high-accuracy GPS fix immediately (don't rely on stale userMarker)
  navigator.geolocation.getCurrentPosition(pos=>{
    userPanning=false; // don't let this trigger the pause
    const {latitude:lat,longitude:lng}=pos.coords;
    map.setView([lat,lng],18,{animate:true,duration:0.7});
  }, ()=>{
    // Fallback to last known position if getCurrentPosition fails
    const k=userMarker?userMarker.getLatLng():prevPos?{lat:prevPos.lat,lng:prevPos.lng}:null;
    if(k) map.setView([k.lat,k.lng],18,{animate:true,duration:0.7});
  }, {enableHighAccuracy:true,timeout:8000,maximumAge:10000});

  loadNearCameras();
  loadNearReports();

  if(watchId!=null) navigator.geolocation.clearWatch(watchId);
  watchId=navigator.geolocation.watchPosition(onGPS,gpsErr,{enableHighAccuracy:true,maximumAge:0,timeout:10000});
  updateNavPanel();
  dingChime();
}

function endNav(){
  navState='idle';
  if(watchId!=null){navigator.geolocation.clearWatch(watchId);watchId=null;}
  [navInst,navFooter,alertBar,arrivalOverlay].forEach(el=>el.classList.add('hidden'));
  topbar.classList.remove('hidden');
  document.body.classList.remove('navigating');
  $$('recenter-btn').classList.add('hidden');
  activeAlert=null; lastRefreshedMidx=-1;
  const overlay=$$('street-labels-overlay'); if(overlay) overlay.innerHTML='';

  headingUpMode=false;
  disable3DView();
  if(map.setBearing) map.setBearing(0);
  $$('north-up-btn').classList.add('hidden');
  $$('compass-widget').classList.add('hidden');
  $$('view-toggle').classList.add('hidden');

  releaseWakeLock();
  clearRoute();
  if(userMarker){map.removeLayer(userMarker);userMarker=null;}
  prevPos=null;
  currentSpeedEl.innerHTML='– <small>km/h</small>';
  speedLimitSign.classList.add('hidden');
}

function gpsErr(e){console.warn('GPS',e.code,e.message);}

/* ── Auto-zoom + look-ahead per zoom level ──────── */
function targetNavZoom(speedMs){
  if(perspective3D) return 16; // 3D always uses zoom 16 — tilt provides the depth, not zoom
  const kmh=speedMs*3.6;
  if(kmh>75) return 16;
  if(kmh>35) return 17;
  return 18;
}
// Max look-ahead in metres per zoom level (keeps car visible in lower third of screen)
const LOOK_CAP={15:900,16:500,17:220,18:90};

/* ── Silent reroute (mid-navigation, no preview bar) ── */
async function reroute(lat,lng){
  if(!routePoints.length) return;
  showToast('Recalculating…',20000);
  const dest=routePoints[routePoints.length-1];
  const costOpts={};
  if(routeOpts.avoidTolls||routeOpts.avoidHighways){
    costOpts.auto={};
    if(routeOpts.avoidTolls) costOpts.auto.toll_booth_penalty=9999;
    if(routeOpts.avoidHighways) costOpts.auto.use_highways=0.1;
  }
  try{
    const resp=await fetch('/api/route',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        locations:[{lon:lng,lat:lat},{lon:dest[1],lat:dest[0]}],
        costing:'auto',
        directions_options:{units:'kilometers',language:'en-US'},
        ...(Object.keys(costOpts).length?{costing_options:costOpts}:{}),
      })});
    if(!resp.ok){showToast('Could not reroute',3000);return;}
    const data=await resp.json();
    routeData=data.trip;
    routePoints=decodePolyline6(routeData.legs[0].shape);
    maneuvers=routeData.legs[0].maneuvers;
    currentMidx=0; lastVoice=-1;
    allRoutes=[routeData]; selectedRouteIdx=0;
    if(routeLine) routeLine.setLatLngs(routePoints);
    if(traveledLine) traveledLine.setLatLngs([]);
    showToast('Route updated',2000);
    loadNearCameras(); loadNearReports();
  }catch{showToast('Rerouting failed',3000);}
}

function makeUserIcon(gpsHdg=0){
  const iconRot = gpsHdg - (map.getBearing ? map.getBearing() : 0);
  return L.divIcon({
    html:`<svg class="user-arrow" style="transform:rotate(${iconRot}deg)" viewBox="0 0 44 60" xmlns="http://www.w3.org/2000/svg">
      <ellipse cx="22" cy="58" rx="13" ry="3" fill="rgba(0,0,0,0.18)"/>
      <!-- Body - clown yellow -->
      <rect x="4" y="9" width="36" height="42" rx="10" fill="#fbbf24"/>
      <!-- Polka dots -->
      <circle cx="12" cy="22" r="3.5" fill="#ef4444"/>
      <circle cx="32" cy="28" r="3" fill="#8b5cf6"/>
      <circle cx="14" cy="36" r="3" fill="#0ea5e9"/>
      <circle cx="30" cy="19" r="2.5" fill="#34d399"/>
      <circle cx="22" cy="33" r="2" fill="#f97316"/>
      <!-- Windshield -->
      <rect x="8" y="13" width="28" height="15" rx="5" fill="rgba(186,230,253,0.88)"/>
      <rect x="11" y="16" width="9" height="6" rx="2.5" fill="rgba(255,255,255,0.5)"/>
      <!-- Rear window -->
      <rect x="8" y="33" width="28" height="12" rx="4" fill="rgba(186,230,253,0.65)"/>
      <!-- Big clown wheels (oversized) -->
      <rect x="-2" y="11" width="8" height="14" rx="4" fill="#1e293b"/>
      <rect x="38" y="11" width="8" height="14" rx="4" fill="#1e293b"/>
      <rect x="-2" y="34" width="8" height="14" rx="4" fill="#1e293b"/>
      <rect x="38" y="34" width="8" height="14" rx="4" fill="#1e293b"/>
      <circle cx="2" cy="18" r="2" fill="#475569"/>
      <circle cx="42" cy="18" r="2" fill="#475569"/>
      <circle cx="2" cy="41" r="2" fill="#475569"/>
      <circle cx="42" cy="41" r="2" fill="#475569"/>
      <!-- Red clown nose on bonnet -->
      <circle cx="22" cy="10" r="4" fill="#ef4444"/>
      <circle cx="23" cy="9" r="1.2" fill="rgba(255,255,255,0.4)"/>
      <!-- Headlights -->
      <rect x="7" y="7" width="11" height="5" rx="2.5" fill="#fde68a"/>
      <rect x="26" y="7" width="11" height="5" rx="2.5" fill="#fde68a"/>
      <!-- Taillights -->
      <rect x="7" y="46" width="11" height="5" rx="2.5" fill="#fca5a5"/>
      <rect x="26" y="46" width="11" height="5" rx="2.5" fill="#fca5a5"/>
      <!-- Tiny flower on roof -->
      <circle cx="22" cy="26" r="2" fill="#ff2d55"/>
      <circle cx="22" cy="23" r="1.2" fill="#fbbf24"/>
      <circle cx="25" cy="27" r="1.2" fill="#fbbf24"/>
      <circle cx="19" cy="27" r="1.2" fill="#fbbf24"/>
      <circle cx="22" cy="29" r="1.2" fill="#fbbf24"/>
    </svg>`,
    className:'', iconSize:[44,60], iconAnchor:[22,30],
  });
}
function makeUserMarker(lat,lng,gpsHdg=0){
  return L.marker([lat,lng],{ icon:makeUserIcon(gpsHdg), zIndexOffset:1000 });
}

/* ── GPS handler ────────────────────────────────── */
function onGPS(pos){
  const {latitude:lat,longitude:lng,speed:rawSpd,heading}=pos.coords;

  // Speed first — needed by heading-freeze logic below
  let speedMs=rawSpd;
  if((speedMs==null||isNaN(speedMs))&&prevPos){
    const dt=(pos.timestamp-prevPos.ts)/1000;
    if(dt>0) speedMs=haversine(prevPos.lat,prevPos.lng,lat,lng)/dt;
  }
  speedMs=speedMs??0;

  // Heading: use hardware GPS heading directly when moving (CoreLocation already smooths it).
  // Apply EMA only for the calculated-from-position fallback.
  // Freeze entirely when stopped to prevent map spin at red lights.
  const isMoving=speedMs>1.5;
  let hdg;
  if(heading!=null&&!isNaN(heading)&&isMoving){
    hdg=heading; smoothHdg=heading; hdgSet=true;
  } else if(!isMoving){
    hdg=hdgSet?smoothHdg:0;
  } else {
    const rawHdg=prevPos?bearing(prevPos.lat,prevPos.lng,lat,lng):smoothHdg;
    hdg=applySmoothing(rawHdg);
  }

  if(!userMarker){
    userMarker=makeUserMarker(lat,lng,hdg).addTo(map);
  } else {
    userMarker.setLatLng([lat,lng]);
    userMarker.setIcon(makeUserIcon(hdg));
  }

  if(navState==='navigating'&&!userPanning){
    if(headingUpMode&&map.setBearing) map.setBearing(hdg);
    if(perspective3D){
      const zoom=map.getZoom();
      const lookM=Math.min(LOOK_CAP[zoom]??90,Math.max(60,speedMs*12));
      const [aLat,aLng]=aheadPoint(lat,lng,hdg,lookM);
      // Never change zoom mid-drive — jarring. Zoom is fixed at nav start (16 for 3D).
      map.panTo([aLat,aLng],{animate:true,duration:0.25,easeLinearity:0.8,noMoveStart:true});
    } else {
      map.panTo([lat,lng],{animate:true,duration:0.25,easeLinearity:0.8,noMoveStart:true});
    }
  }

  if(navState==='navigating'){
    currentSpeedEl.innerHTML=fmtSpeed(speedMs);
    const lim=getSpeedLimit();
    const dispLim=lim?(prefs.unit==='mph'?Math.round(lim*0.621):lim):null;
    const over=dispLim&&(prefs.unit==='mph'?toMph(speedMs):toKmh(speedMs))>dispLim;
    currentSpeedEl.classList.toggle('over-limit',over);
    speedLimitSign.classList.toggle('over-limit',over);
    if(over&&prefs.haptic&&navigator.vibrate) navigator.vibrate([100,50,100]);
    if(dispLim){speedLimitSign.classList.remove('hidden');speedLimitVal.textContent=dispLim;}
    else speedLimitSign.classList.add('hidden');
  }

  prevPos={lat,lng,ts:pos.timestamp,hdg};
  if(navState!=='navigating'||!routePoints.length)return;

  const {idx,dist}=nearestOnRoute(routePoints,lat,lng);
  updateRouteStyling(idx);

  if(dist>60){
    offCount++;
    if(offCount>=3){offCount=0;reroute(lat,lng);return;}
  } else offCount=0;

  for(let i=maneuvers.length-1;i>=0;i--){if(idx>=maneuvers[i].begin_shape_index){currentMidx=i;break;}}

  const nextM=maneuvers[currentMidx+1]??maneuvers[currentMidx];
  const nextPt=routePoints[nextM.begin_shape_index]??routePoints[routePoints.length-1];
  const distToTurn=haversine(lat,lng,nextPt[0],nextPt[1]);
  remainingSec=Math.round(routeData.summary.time*(1-Math.min(idx/routePoints.length,1)));

  updateNavPanel(distToTurn);
  checkVoice(currentMidx,distToTurn);
  checkProximityAlerts(lat,lng,hdg);
  if(perspective3D&&currentMidx!==lastRefreshedMidx){lastRefreshedMidx=currentMidx;refreshStreetLabels();}
  updateSpeedProfileCursor();

  if(!headingUpMode&&speedMs>2){
    headingUpMode=true;
    $$('north-up-btn').classList.remove('hidden');
  }

  if((nextM.type>=4&&nextM.type<=6)&&distToTurn<25){
    triggerArrival();
  }
}

function updateRouteStyling(idx){
  if(!routePoints.length) return;
  // setLatLngs on existing layers — never removes/re-adds so no flicker during zoom
  if(traveledLine) traveledLine.setLatLngs(idx>1 ? routePoints.slice(0,idx+1) : []);
  if(routeLine)    routeLine.setLatLngs(routePoints.slice(Math.max(0,idx-1)));
}

function updateNavPanel(distToTurn){
  if(!maneuvers.length)return;
  const nextM=maneuvers[currentMidx+1]??maneuvers[currentMidx];
  navIconEl.textContent=ARROW[nextM.type]??'↑';
  navDistEl.textContent=distToTurn!=null?fmtDist(distToTurn):'';
  navStreetEl.textContent=san((nextM.street_names??[]).join(' / ')||nextM.instruction||'');

  const nnM=maneuvers[currentMidx+2];
  if(nnM){
    navNextWrap.classList.remove('hidden');
    navNextIcon.textContent=ARROW[nnM.type]??'↑';
    navNextLabel.textContent=san(`Then: ${(nnM.street_names??[]).join(' / ')||nnM.instruction||''}`);
  } else navNextWrap.classList.add('hidden');

  navETA.textContent=fmtETA(remainingSec);
  const remDist=remainingSec*(routeData.summary.length*1000/routeData.summary.time);
  navRemaining.textContent=`${fmtDist(remDist)} · ${fmtTime(remainingSec)}`;

  const lim=getSpeedLimit();
  if(lim){speedLimitSign.classList.remove('hidden');speedLimitVal.textContent=prefs.unit==='mph'?Math.round(lim*0.621):lim;}
  else speedLimitSign.classList.add('hidden');
}

function getSpeedLimit(){ const m=maneuvers[currentMidx]; return(m?.speed_limit&&m.speed_limit<200)?m.speed_limit:null; }

/* ── Compass widget — driven by map's rotate event ── */
function updateCompass(){
  const bearing = map.getBearing ? map.getBearing() : 0;
  const needle = $$('compass-needle');
  if(needle) needle.style.transform=`translateX(-50%) translateY(-100%) rotate(${bearing}deg)`;
  // Show compass + north-up button whenever map isn't north-up
  const off = Math.abs(bearing % 360) > 0.5;
  $$('compass-widget').classList.toggle('hidden', !off);
  $$('north-up-btn').classList.toggle('hidden', !off);
  if(userMarker && prevPos){
    userMarker.setIcon(makeUserIcon(prevPos.hdg ?? 0));
  }
}

// Wire map rotate event (fires on setBearing AND two-finger gesture)
map.on('rotate', updateCompass);

$$('compass-widget').addEventListener('click', resetNorthUp);
$$('north-up-btn').addEventListener('click', resetNorthUp);
$$('recenter-btn').addEventListener('click',()=>{
  userPanning=false;
  clearTimeout(pausePanTimer);
  $$('recenter-btn').classList.add('hidden');
});

function resetNorthUp(){
  headingUpMode = false;
  if(map.setBearing) map.setBearing(0);
  // updateCompass fires via the rotate event automatically
}

/* ── Proximity alerts (cameras + police + schools) ──── */
/* ── Refresh street labels on any map move (rAF-throttled) ───────────────── */
let _labelRaf=null;
map.on('move zoom moveend zoomend',()=>{
  if(!perspective3D||navState!=='navigating') return;
  if(_labelRaf) return;
  _labelRaf=requestAnimationFrame(()=>{ _labelRaf=null; refreshStreetLabels(); });
});

/* ── Project a map container point to screen coords accounting for 3D tilt ── */
function mapPointToScreen(cp){
  const vw=window.innerWidth, vh=window.innerHeight;
  if(!perspective3D) return {x:-0.3*vw+cp.x, y:-0.3*vh+cp.y};
  // #map is 160% of viewport, centred at 50%/50% of viewport
  const originX=0.8*vw, originY=0.8*vh; // transform-origin in #map px = 0.5*1.6*vw
  const relX=cp.x-originX, relY=cp.y-originY;
  const P=1200, a=38*Math.PI/180;
  const yRot=relY*Math.cos(a), zRot=relY*Math.sin(a);
  const d=P-zRot; if(d<=0) return null;
  const s=P/d;
  return {x:0.5*vw+relX*s, y:0.5*vh+yRot*s};
}

/* ── 2D street name bubbles (projected onto viewport, not inside map transform) ── */
function refreshStreetLabels(){
  const overlay=$$('street-labels-overlay');
  if(overlay) overlay.innerHTML='';
  if(!perspective3D||navState!=='navigating'||!maneuvers.length) return;
  const vw=window.innerWidth, vh=window.innerHeight;
  const seen=new Set();
  for(let i=currentMidx;i<Math.min(maneuvers.length,currentMidx+8);i++){
    const m=maneuvers[i];
    const name=(m.street_names??[])[0];
    if(!name||seen.has(name)) continue;
    seen.add(name);
    const pt=routePoints[m.begin_shape_index]; if(!pt) continue;
    const cp=map.latLngToContainerPoint(L.latLng(pt[0],pt[1]));
    const sp=mapPointToScreen(cp); if(!sp) continue;
    if(sp.x<-60||sp.x>vw+60||sp.y<0||sp.y>vh) continue;
    const el=document.createElement('div');
    el.className='street-label';
    el.textContent=san(name);
    el.style.left=sp.x+'px';
    el.style.top=sp.y+'px';
    overlay.appendChild(el);
  }
}

async function loadNearCameras(){
  const b=map.getBounds().pad(0.3);
  const p=new URLSearchParams({swlat:b.getSouth(),swlng:b.getWest(),nelat:b.getNorth(),nelng:b.getEast()});
  try{nearCameras=await fetch(`/api/cameras?${p}`).then(r=>r.json());}catch{}
}
async function loadNearReports(){
  const b=map.getBounds().pad(0.3);
  const p=new URLSearchParams({swlat:b.getSouth(),swlng:b.getWest(),nelat:b.getNorth(),nelng:b.getEast()});
  try{nearReports=await fetch(`/api/reports?${p}`).then(r=>r.json());}catch{}
}

function checkProximityAlerts(lat,lng,userHeading){
  // Live-update distance on active alert; dismiss once we've passed the hazard
  if(activeAlert){
    const d=haversine(lat,lng,activeAlert.lat,activeAlert.lng);
    if(d>activeAlert.dismissDist){
      alertBar.classList.add('hidden');
      activeAlert=null;
    } else {
      alertDist.textContent=fmtDist(d);
    }
  }

  if(prefs.cameraAlerts){
    for(const cam of nearCameras){
      const d=haversine(lat,lng,cam.lat,cam.lng);

      // Camera direction filtering: only alert if approaching the camera
      if(cam.direction!=null&&userHeading!=null){
        const diff=Math.abs(((userHeading-cam.direction+180+360)%360)-180);
        if(diff>=90){
          if(d>500){alertedIds.delete(`c-${cam.id}-near`);alertedIds.delete(`c-${cam.id}-far`);}
          continue;
        }
      }

      const key=`c-${cam.id}-${d<180?'near':'far'}`;
      if(d<350&&d>0&&!alertedIds.has(key)){
        alertedIds.add(key);
        const label={speed:'Speed camera',red_light:'Red light camera',average_speed:'Avg speed camera'}[cam.type]??'Camera';
        const limitStr=cam.speed_limit?` · ${cam.speed_limit} km/h`:'';
        showAlert('📷',`${label}${limitStr}`,fmtDist(d),false,cam.lat,cam.lng,500);
        cameraChime();
        if(prefs.haptic&&navigator.vibrate) navigator.vibrate(200);
      }
      if(d>500){alertedIds.delete(`c-${cam.id}-near`);alertedIds.delete(`c-${cam.id}-far`);}
    }
  }
  if(prefs.policeAlerts){
    for(const r of nearReports){
      if(r.type!=='police'&&r.type!=='speed_trap') continue;
      const d=haversine(lat,lng,r.lat,r.lng);
      const key=`r-${r.id}`;
      if(d<300&&!alertedIds.has(key)){
        alertedIds.add(key);
        const label=r.type==='police'?'Police reported ahead':'Speed trap reported';
        showAlert('🚔',label,fmtDist(d),true,r.lat,r.lng,700);
        policeChime();
        if(prefs.haptic&&navigator.vibrate) navigator.vibrate([200,100,200]);
      }
      if(d>600)alertedIds.delete(key);
    }
  }
  if(isSchoolHours()&&schoolZones.length){
    for(const sz of schoolZones){
      const d=haversine(lat,lng,sz.lat,sz.lng);
      const key=`sz-${sz.lat.toFixed(4)}-${sz.lng.toFixed(4)}`;
      if(d<250&&!alertedIds.has(key)){
        alertedIds.add(key);
        showAlert('🏫','School zone · 40 km/h',fmtDist(d),false,sz.lat,sz.lng,400);
        schoolChime();
        if(prefs.haptic&&navigator.vibrate) navigator.vibrate([150,75,150]);
      }
      if(d>400)alertedIds.delete(key);
    }
  }
}

function showAlert(icon,text,dist,isPolice,hazLat,hazLng,dismissDist){
  alertIcon.textContent=icon;
  alertText.textContent=text;
  alertDist.textContent=dist;
  alertBar.classList.toggle('police-alert',isPolice);
  const instH=navInst.offsetHeight;
  alertBar.style.top=(instH+8)+'px';
  alertBar.classList.remove('hidden');
  activeAlert=hazLat!=null?{lat:hazLat,lng:hazLng,dismissDist:dismissDist??600}:null;
  clearTimeout(alertHideTimer);
}

/* ── Voice guidance ─────────────────────────────── */
const synth=window.speechSynthesis;
function speak(text){
  if(!prefs.voice||!synth)return;
  synth.cancel();
  const u=new SpeechSynthesisUtterance(text);
  u.lang='en-AU';u.rate=1.05;u.volume=0.9;
  synth.speak(u);
}
function checkVoice(mIdx,dist){
  const nextM=maneuvers[mIdx+1]; if(!nextM)return;
  const instr=san(nextM.verbal_pre_transition_instruction??nextM.instruction??'');
  const key=(d)=>`${mIdx}-${d}`;
  if(dist<=220&&dist>140&&lastVoice!==key('c')){speak(san(nextM.verbal_transition_alert_instruction??instr));lastVoice=key('c');}
  else if(dist<=550&&dist>440&&lastVoice!==key('b')){speak(`In ${fmtDist(dist)}, ${instr}`);lastVoice=key('b');}
  else if(dist<=1050&&dist>940&&lastVoice!==key('a')){speak(`In 1 kilometre, ${instr}`);lastVoice=key('a');}
}

/* ── Arrival ──────────────────────────────────── */
function triggerArrival(){
  if(arrivedFlag)return; arrivedFlag=true;
  speak('You have arrived at your destination.');
  dingChime(); setTimeout(dingChime,600); setTimeout(dingChime,1200);
  if(prefs.haptic&&navigator.vibrate)navigator.vibrate([300,100,300,100,300]);
  arrivalDest.textContent=toPlace?.name??'your destination';
  arrivalOverlay.classList.remove('hidden');
  [navInst,navFooter,alertBar].forEach(el=>el.classList.add('hidden'));
  releaseWakeLock();
}
