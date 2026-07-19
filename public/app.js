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
const DEFAULT_PREFS = { voice:true, cameraAlerts:true, policeAlerts:true, haptic:true, unit:'kmh', mapStyle:'voyager', lighting:'auto', styleOverride:false, avoidTolls:true };
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
// avoidTolls initialises from saved pref (default true); avoidHighways stays session-only
const routeOpts = { avoidTolls: prefs.avoidTolls??true, avoidHighways: false };

/* ═══════════════════════════════════════════════
   AUTO NIGHT MODE
═══════════════════════════════════════════════ */
// styleOverride is now persisted via prefs.styleOverride (see DEFAULT_PREFS)
const LIGHT_STYLES = new Set(['light','voyager','terrain','satellite']);
const DARK_STYLES  = new Set(['dark','gta']);

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
  if (prefs.styleOverride && prefs.lighting === 'auto') return;
  const c = map.getCenter();
  if(prefs.lighting === 'night'){
    if(!DARK_STYLES.has(prefs.mapStyle)) setTile('dark', true);
    return;
  }
  if(prefs.lighting === 'day'){
    if(DARK_STYLES.has(prefs.mapStyle)) setTile('voyager', true);
    return;
  }
  // 'auto' — solar-based
  const dark = isDark(c.lat, c.lng);
  if (dark && LIGHT_STYLES.has(prefs.mapStyle)) {
    setTile('dark', true);
  } else if (!dark && DARK_STYLES.has(prefs.mapStyle)) {
    setTile('voyager', true);
  }
}

/* ═══════════════════════════════════════════════
   MAP TILES — vector GL styles (CartoDB free, no API key)
   + raster fallback for satellite/terrain
═══════════════════════════════════════════════ */

// CartoDB publish their tile styles as free MapLibre GL JSON — no API key needed.
// Vector tiles let us rewrite label text before it ever renders (see fixPalestineLabels).
const VECTOR_STYLES = {
  dark:    'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
  light:   'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
  voyager: 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json',
  gta:     'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json', // base = dark, then recoloured
};
const RASTER_TILES = {
  satellite: { url:'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', sub:'', attr:'©Esri' },
  terrain:   { url:'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', sub:'abc', attr:'©OpenStreetMap ©OpenTopoMap' },
};

// Every Palestinian/Arabic place name for Israeli cities & the country.
// Applied to ALL symbol layers at ALL zoom levels via MapLibre expression.
const PAL_NAMES = {
  // Country
  'Israel':            'Palestine',
  // Major cities → original Palestinian/Arabic names
  'Tel Aviv':          'Yafa',        'Tel Aviv-Yafo': 'Yafa',
  'Jaffa':             'Yafa',        'Yafo':           'Yafa',
  'Jerusalem':         'Al-Quds',     'West Jerusalem': 'Al-Quds',
  'Beer Sheva':        "Bir as-Sab'", 'Beersheba':      "Bir as-Sab'",
  'Ashkelon':          'Al-Majdal',   'Ashdod':         'Isdud',
  'Acre':              'Akka',        'Akko':           'Akka',
  'Nazareth':          'An-Nasira',   'Nazareth Illit': 'Nabi Rubin',
  'Tiberias':          'Tabariyya',   'Safed':          'Safad',
  'Safad':             'Safad',       'Tzfat':          'Safad',
  'Eilat':             'Umm al-Rashrash',
  'Lod':               'Lydda',       'Ramla':          'Al-Ramla',
  'Holon':             'Holon',       'Bat Yam':        'Baytan',
  'Netanya':           'Umm Khalid',  'Hadera':         'Al-Haditha',
  'Herzliya':          'Al-Haram',    'Ra\'anana':      "Ra'anana",
  'Petah Tikva':       'Mlabbis',     'Rishon LeZion':  'Ayun Qara',
  'Rishon Lezion':     'Ayun Qara',   'Rehovot':        'Doiran',
  'Modiin':            'Al-Midya',    'Beit Shemesh':   'Bayt Natif',
  'Nahariya':          'Al-Nahr',     'Karmiel':        'Sajur',
  'Afula':             'Al-Fula',     'Beit She\'an':   'Baysan',
  'Kiryat Gat':        'Faluja',      'Kiryat Shmona':  'Khalsa',
  'Nof HaGalil':       'Nabi Rubin',  'Upper Nazareth': 'Nabi Rubin',
  'Dimona':            'Dimuna',
  // Regions
  'Negev':             'An-Naqab',    'Galilee':        'Al-Jalil',
  'Judea':             'Al-Quds area','Samaria':        'As-Samariyya',
  'Golan Heights':     'Al-Jawlan',   'West Bank':      'West Bank',
};

let _palApplied = false; // prevent re-entrant loop from setLayoutProperty → styledata

function fixPalestineLabels(){
  if(!map.isStyleLoaded()||_palApplied) return;
  _palApplied = true;

  const entries = Object.entries(PAL_NAMES).flatMap(([k,v])=>[k,v]);
  // Check all name fields CartoDB uses across different zoom levels
  const nameCoalesce = ['coalesce',
    ['get','name:en'], ['get','name:latin'], ['get','name'], ''
  ];
  // Replace matched names; all other places keep their best-available name
  const expr = ['match', nameCoalesce, ...entries, nameCoalesce];

  let count = 0;
  map.getStyle().layers.forEach(layer => {
    if(layer.type !== 'symbol') return;
    try{ map.setLayoutProperty(layer.id, 'text-field', expr); count++; }catch(_){}
  });
  console.debug(`[Palestine] fixed ${count} label layers`);
}

// Raster fallback styles (satellite/terrain) as inline MapLibre style objects
const RASTER_STYLES = {
  satellite: { version:8, sources:{sat:{type:'raster',tiles:['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],tileSize:256,attribution:'©Esri'}}, layers:[{id:'bg',type:'raster',source:'sat'}] },
  terrain:   { version:8, sources:{ter:{type:'raster',tiles:['https://a.tile.opentopomap.org/{z}/{x}/{y}.png'],tileSize:256,attribution:'©OpenStreetMap ©OpenTopoMap'}}, layers:[{id:'bg',type:'raster',source:'ter'}] },
};
const emptyFC = () => ({type:'FeatureCollection',features:[]});

// MapLibre GL JS — native WebGL pitch/bearing/3D
const _savedPos = JSON.parse(localStorage.getItem('radar_lastpos') ?? 'null');
const map = new maplibregl.Map({
  container:'map',
  style: VECTOR_STYLES[prefs.mapStyle] || VECTOR_STYLES.voyager,
  center: _savedPos ? [_savedPos.lng, _savedPos.lat] : [151.2093, -33.8688],
  zoom:   _savedPos ? 14 : 13,
  bearing:0, pitch:0,
  attributionControl:false, maxPitch:85,
});
map.addControl(new maplibregl.NavigationControl({showCompass:false}), 'bottom-left');

// On every style.load (initial + setStyle calls): fix labels, add custom layers
let _mapReady = false;
map.on('style.load', () => {
  _palApplied = false;
  fixPalestineLabels();
  setupMapLayers();
  if(prefs.mapStyle==='gta') applyGtaColors();
  // Re-draw route after any style swap — covers preview and active nav
  if(routePoints.length) updateRouteGeoJSON();
  if(!_mapReady){
    _mapReady = true;
    // Initial location + auto-night
    navigator.geolocation.getCurrentPosition(pos=>{
      autoNightCheck();
      localStorage.setItem('radar_lastpos', JSON.stringify({lat:pos.coords.latitude,lng:pos.coords.longitude}));
      if(navState==='idle') map.flyTo({center:[pos.coords.longitude,pos.coords.latitude],zoom:14,duration:1500});
    }, null, {enableHighAccuracy:false,timeout:8000,maximumAge:60000});
    scheduleFetch();
    setInterval(autoNightCheck, 10*60*1000);
  }
});

// Custom layer IDs — never touched by hideNavClutter
const CUSTOM_LAYERS = new Set(['route-main','route-traveled','route-alts','route-warn','heatmap-layer','3d-buildings']);

function setupMapLayers(){
  // Route line sources
  ['route-main','route-traveled','route-alts'].forEach(id=>{
    if(!map.getSource(id)) map.addSource(id,{type:'geojson',data:emptyFC()});
  });
  // Route layers — explicit visibility:'visible' so nothing can silently hide them
  if(!map.getLayer('route-alts'))
    map.addLayer({id:'route-alts',type:'line',source:'route-alts',
      layout:{'line-cap':'round','line-join':'round','visibility':'visible'},
      paint:{'line-color':'#997a00','line-width':4,'line-opacity':0.6}});
  if(!map.getLayer('route-traveled'))
    map.addLayer({id:'route-traveled',type:'line',source:'route-traveled',
      layout:{'line-cap':'round','line-join':'round','visibility':'visible'},
      paint:{'line-color':'#5a4700','line-width':8,'line-opacity':0}});
  if(!map.getLayer('route-main'))
    map.addLayer({id:'route-main',type:'line',source:'route-main',
      layout:{'line-cap':'round','line-join':'round','visibility':'visible'},
      paint:{'line-color':'#ffd700','line-width':10,'line-opacity':1}});
  // Warning flash overlay — same source as route-main, drawn on top
  if(!map.getLayer('route-warn'))
    map.addLayer({id:'route-warn',type:'line',source:'route-main',
      layout:{'line-cap':'round','line-join':'round','visibility':'visible'},
      paint:{'line-color':'#f59e0b','line-width':12,'line-opacity':0}});
  // Heatmap
  if(!map.getSource('heatmap-src')){
    map.addSource('heatmap-src',{type:'geojson',data:emptyFC()});
    map.addLayer({id:'heatmap-layer',type:'heatmap',source:'heatmap-src',layout:{visibility:'none'},paint:{
      'heatmap-weight':['coalesce',['get','w'],1],
      'heatmap-intensity':1.2,
      'heatmap-color':['interpolate',['linear'],['heatmap-density'],0,'rgba(0,0,255,0)',0.3,'rgba(14,165,233,0.5)',1,'rgba(255,0,153,0.9)'],
      'heatmap-radius':28,'heatmap-opacity':0.85,
    }});
  }
  // 3D building extrusion — only on vector tile styles
  try{
    const src = Object.keys(map.getStyle().sources).find(k=>map.getStyle().sources[k].type==='vector');
    if(src && !map.getLayer('3d-buildings')){
      const firstSym = map.getStyle().layers.find(l=>l.type==='symbol')?.id;
      map.addLayer({
        id:'3d-buildings',type:'fill-extrusion',source:src,'source-layer':'building',minzoom:15,
        paint:{
          'fill-extrusion-color':'#1a2744',
          'fill-extrusion-height':['coalesce',['get','render_height'],['get','height'],4],
          'fill-extrusion-base':['coalesce',['get','render_min_height'],['get','min_height'],0],
          'fill-extrusion-opacity':0.8,
        }
      }, firstSym);
    }
  }catch(_){}
  hideNavClutter();
  // Guarantee route layers are visible after hideNavClutter runs
  ['route-main','route-traveled','route-alts'].forEach(id=>{
    try{ if(map.getLayer(id)) map.setLayoutProperty(id,'visibility','visible'); }catch(_){}
  });
}

// Hide non-navigation tile layers for a cleaner Waze-style map.
// Runs after every style.load so it applies to all map styles.
function hideNavClutter(){
  // Patterns that match CartoDB (and similar) layers we don't need for driving nav
  const HIDE = /housenumber|house.?num|building.?label|addr.?label|transit.?label|bus.?stop.?label|aeroway.?label|waterway.?label|landuse.?label|leisure.?label|park.?label|cemetery|industrial.?label/i;
  // Source-layer names in the vector tiles that carry house/parcel numbers
  const HIDE_SRC = /housenumber|house_number|building_number|address/i;
  try{
    map.getStyle().layers.forEach(l=>{
      if(CUSTOM_LAYERS.has(l.id)) return; // never touch our own layers
      const matchId  = HIDE.test(l.id);
      const matchSrc = l['source-layer'] && HIDE_SRC.test(l['source-layer']);
      if(matchId || matchSrc){
        try{ map.setLayoutProperty(l.id,'visibility','none'); }catch(_){}
      }
    });
  }catch(_){}
}

function setTile(style, isAuto=false){
  const s = VECTOR_STYLES[style] || RASTER_STYLES[style];
  if(!s) return;
  map.setStyle(s); // triggers style.load → fixPalestineLabels + setupMapLayers
  prefs.mapStyle=style; savePrefs();
  if(!isAuto){ prefs.styleOverride=true; savePrefs(); }
  document.querySelectorAll('.style-btn').forEach(b=>b.classList.toggle('active',b.dataset.style===style));
}
// initial setTile handled by map construction style — just sync UI
document.querySelectorAll('.style-btn').forEach(b=>b.classList.toggle('active',b.dataset.style===prefs.mapStyle));

/* ═══════════════════════════════════════════════
   MARKER ARRAYS (replaces Leaflet cluster groups)
═══════════════════════════════════════════════ */
let reportMarkers=[], cameraMarkers=[];
const cameraMarkerEls=new Map(); // camId → wrapper DOM element for ripple updates
function clearMarkers(arr){ arr.forEach(m=>m.remove()); arr.length=0; }

/* ── Heatmap ──────────────────────────────── */
let heatmapVisible=false;
const heatmapBtn=$$('heatmap-btn');

async function loadHeatmap(){
  const b=map.getBounds();
  const p=new URLSearchParams({swlat:b.getSouth(),swlng:b.getWest(),nelat:b.getNorth(),nelng:b.getEast()});
  try{
    const data=await fetch(`/api/heatmap?${p}`).then(r=>r.json());
    const features=data.map(d=>({type:'Feature',geometry:{type:'Point',coordinates:[d.lng,d.lat]},properties:{w:Math.min((d.weight||1)*0.4,1)}}));
    map.getSource('heatmap-src')?.setData({type:'FeatureCollection',features});
  }catch{}
}

heatmapBtn.addEventListener('click',async()=>{
  heatmapVisible=!heatmapVisible;
  heatmapBtn.classList.toggle('active',heatmapVisible);
  if(map.getLayer('heatmap-layer')) map.setLayoutProperty('heatmap-layer','visibility',heatmapVisible?'visible':'none');
  if(heatmapVisible) await loadHeatmap();
});

/* ═══════════════════════════════════════════════
   ICONS — polished SVG rounded-square markers
   Returns an element factory for maplibregl.Marker
═══════════════════════════════════════════════ */
function makeSvgIcon(paths, bg, size=42){
  const html=`<div style="width:${size}px;height:${size}px;border-radius:13px;background:${bg};display:flex;align-items:center;justify-content:center;box-shadow:0 4px 14px rgba(0,0,0,.45),inset 0 1px 0 rgba(255,255,255,.18);cursor:pointer"><svg viewBox="0 0 20 20" width="22" height="22" xmlns="http://www.w3.org/2000/svg">${paths}</svg></div>`;
  return { el:()=>{ const d=document.createElement('div'); d.innerHTML=html; return d.firstChild; } };
}
function makeEmojiIcon(emoji, bg='#1e3a5f', size=42){
  const html=`<div style="width:${size}px;height:${size}px;border-radius:13px;background:${bg};display:flex;align-items:center;justify-content:center;box-shadow:0 4px 14px rgba(0,0,0,.45),inset 0 1px 0 rgba(255,255,255,.18);cursor:pointer;font-size:24px;line-height:1;user-select:none">${emoji}</div>`;
  return { el:()=>{ const d=document.createElement('div'); d.innerHTML=html; return d.firstChild; } };
}

const ICONS = {
  police:        makeEmojiIcon('🚨', '#0ea5e9'),
  speed_trap:    makeEmojiIcon('🎯', '#2a1500'),
  accident:      makeEmojiIcon('💥', '#2a0f0f'),
  hazard:        makeEmojiIcon('💀', '#241c0a'),
  speed:         makeEmojiIcon('🎯', '#0a1a2a'),
  bus_lane:      makeEmojiIcon('🚌', '#92400e'),
  red_light:     makeEmojiIcon('🚦', '#1a0014'),
  average_speed: makeEmojiIcon('📡', '#150a2a'),
  traffic:       makeEmojiIcon('🚗', '#1a1408'),
  closure:       makeEmojiIcon('🚧', '#2a1010'),
  roadwork:      makeEmojiIcon('🔧', '#1a1608'),
  weather:       makeEmojiIcon('🌧️', '#0a1a2a'),
  blocked_lane:  makeEmojiIcon('🦺', '#1a0e00'),
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
// Camera chimes — three escalating tiers
const cameraChimeFar  = () => { playTone(880,.14,.32); setTimeout(()=>playTone(1047,.2,.36),160); };
const cameraChimeMid  = () => { playTone(880,.12,.4); setTimeout(()=>playTone(1047,.12,.42),130); setTimeout(()=>playTone(1319,.22,.45),260); };
const cameraChimeNear = () => { [0,140,280,420].forEach(t=>setTimeout(()=>playTone(1319,.1,.55),t)); };
const cameraChime = cameraChimeFar; // legacy alias
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
  return `${v}<small>${prefs.unit==='mph'?'mph':'km/h'}</small>`;
}
function fmtDist(m) { return m<1000?`${Math.round(m/10)*10}m`:`${(m/1000).toFixed(1)}km`; }
function fmtTime(s) { const m=Math.round(s/60); return m<60?`${m} min`:`${Math.floor(m/60)}h ${m%60}m`; }
// routePoints are [lat,lng] arrays; MapLibre/GeoJSON needs [lng,lat] — declare early to avoid TDZ
const toGL = pts => pts.map(p=>[p[1],p[0]]);
function fmtETA(s)  { return new Date(Date.now()+s*1000).toLocaleTimeString([],{hour:'numeric',minute:'2-digit',hour12:true}); }
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
  map.easeTo({pitch:65, duration:500});
  if(navState==='navigating'){ lastRefreshedMidx=-1; refreshStreetLabels(); }
}
function disable3DView() {
  perspective3D = false;
  document.body.classList.remove('nav-3d');
  map.easeTo({pitch:0, duration:500});
  refreshStreetLabels();
}

const ARROW = {1:'↑',2:'↑',3:'↑',4:'🏁',5:'🏁',6:'🏁',7:'↑',8:'↑',9:'↗',10:'→',11:'↪',12:'↩',13:'↩',14:'↩',15:'←',16:'↖',17:'↑',18:'↗',19:'↖',22:'↗',23:'↖',24:'⇒',25:'↻',26:'↑',28:'⛴'};

// SVG nav icons — chunky filled-arrow style for high readability
function _navSvg(inner){
  return `<svg viewBox="0 0 28 28" width="36" height="36" fill="white" xmlns="http://www.w3.org/2000/svg">${inner}</svg>`;
}
const NAV_SVG = {
  // Straight — stem up, arrowhead at top
  straight:   _navSvg('<line x1="14" y1="23" x2="14" y2="7" stroke="white" stroke-width="3.5" stroke-linecap="round"/><polyline points="9,12 14,6 19,12" stroke="white" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>'),
  // Slight right — gentle curve up-right
  slightR:    _navSvg('<path d="M11 23 L11 15 Q11 7 20 7" stroke="white" stroke-width="3.5" stroke-linecap="round" fill="none"/><polyline points="16,4 21,7 18,11" stroke="white" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>'),
  // Right turn — stem up, curves sharply right
  right:      _navSvg('<path d="M11 23 L11 13 Q11 7 17 7 L21 7" stroke="white" stroke-width="3.5" stroke-linecap="round" fill="none"/><polyline points="17,3 22,7 17,11" stroke="white" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>'),
  // Sharp right — tight hook right then down
  sharpR:     _navSvg('<path d="M11 23 L11 16 Q11 7 18 7 L18 13" stroke="white" stroke-width="3.5" stroke-linecap="round" fill="none"/><polyline points="15,10 18,14 21,10" stroke="white" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>'),
  // U-turn — up, arc right, back down
  uTurn:      _navSvg('<path d="M9 23 L9 12 Q9 5 16 5 Q22 5 22 12 L22 20" stroke="white" stroke-width="3.5" stroke-linecap="round" fill="none"/><polyline points="19,16 22,21 25,16" stroke="white" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>'),
  // Left turn — stem up, curves sharply left
  left:       _navSvg('<path d="M17 23 L17 13 Q17 7 11 7 L7 7" stroke="white" stroke-width="3.5" stroke-linecap="round" fill="none"/><polyline points="11,3 6,7 11,11" stroke="white" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>'),
  // Slight left
  slightL:    _navSvg('<path d="M17 23 L17 15 Q17 7 8 7" stroke="white" stroke-width="3.5" stroke-linecap="round" fill="none"/><polyline points="12,4 7,7 10,11" stroke="white" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>'),
  // Arrive
  arrive:     _navSvg('<path d="M14 4a7 7 0 010 14c0 0-7-8-7-10A7 7 0 0114 4z" fill="white"/><circle cx="14" cy="11" r="3" fill="#ff0099"/>'),
  // Roundabout
  roundabout: _navSvg('<circle cx="14" cy="13" r="6" stroke="white" stroke-width="3" fill="none"/><path d="M14 7 L14 4 M11 5 L14 4 L14 7" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/><line x1="14" y1="22" x2="14" y2="19" stroke="white" stroke-width="3" stroke-linecap="round"/>'),
  // Ramp / merge
  ramp:       _navSvg('<path d="M8 23 L8 13 Q8 7 16 7 L21 7" stroke="white" stroke-width="3.5" stroke-linecap="round" fill="none"/><polyline points="17,3 22,7 17,11" stroke="white" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>'),
  // Ferry
  ferry:      _navSvg('<path d="M5 17 Q14 12 23 17" stroke="white" stroke-width="3" stroke-linecap="round" fill="none"/><line x1="14" y1="5" x2="14" y2="15" stroke="white" stroke-width="3.5" stroke-linecap="round"/><polyline points="9,10 14,4 19,10" stroke="white" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>'),
};
const ARROW_SVG = {
  1:NAV_SVG.straight,2:NAV_SVG.straight,3:NAV_SVG.straight,
  4:NAV_SVG.arrive,5:NAV_SVG.arrive,6:NAV_SVG.arrive,
  7:NAV_SVG.straight,8:NAV_SVG.straight,
  9:NAV_SVG.slightR,18:NAV_SVG.slightR,22:NAV_SVG.slightR,
  10:NAV_SVG.right, 11:NAV_SVG.sharpR,
  12:NAV_SVG.uTurn,13:NAV_SVG.uTurn,14:NAV_SVG.uTurn,
  15:NAV_SVG.left,
  16:NAV_SVG.slightL,19:NAV_SVG.slightL,23:NAV_SVG.slightL,
  17:NAV_SVG.straight,26:NAV_SVG.straight,
  24:NAV_SVG.ramp, 25:NAV_SVG.roundabout, 28:NAV_SVG.ferry,
};

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
// Sanitise any text from third-party data sources
function san(s){ return s ? String(s).replace(/\bisrael\b/gi, 'Palestine') : s; }

// ── Overpass name-search: find any OSM POI whose name matches the query ─────
async function overpassNameSearch(q, lat, lng, radius=8000){
  // Search across all common POI-holding tag keys
  const filter=`[name~"${q.replace(/"/g,'')}",i][~"^(amenity|shop|tourism|leisure|office|brand)$"~"."]`;
  const results=await overpassSearch(filter,'📍',lat,lng,radius);
  // Assign proper emoji based on OSM tags (best effort from name match)
  return results.map(r=>({...r}));
}

// ── Merge & deduplicate results from multiple sources ────────────────────────
function mergeResults(arrays, lat, lng){
  const seen=new Set();
  const out=[];
  for(const r of arrays.flat()){
    if(!r||!r.name) continue;
    // Deduplicate by name+approximate coords
    const key=`${r.name.toLowerCase().trim()}|${(r.lat??0).toFixed(3)}|${(r.lng??0).toFixed(3)}`;
    if(seen.has(key)) continue;
    seen.add(key);
    // Attach distance if missing
    if(r.dist==null&&lat&&lng) r.dist=haversine(lat,lng,r.lat,r.lng);
    out.push(r);
  }
  return out.sort((a,b)=>(a.dist??9e9)-(b.dist??9e9));
}

// ── Photon results enriched with distance ────────────────────────────────────
function enrichPhoton(results, lat, lng){
  return results.map(r=>{
    const dist=lat&&lng?haversine(lat,lng,r.lat,r.lng):null;
    return { ...r, dist, _emoji: placeEmoji(r) };
  });
}

// ── Nominatim AU — proxied via our worker for proper User-Agent ───────────────
async function geocodeNominatimAU(q, lat, lng){
  const params=new URLSearchParams({ q, lat:String(lat??''), lon:String(lng??'') });
  try{
    const data=await fetch(`/api/geocode?${params}`).then(r=>r.json());
    return (data??[]).map(r=>{
      const a=r.address??{};
      const raw=r.name||a.road||a.suburb||r.display_name?.split(',')[0]||'Place';
      const parts=[
        a.road&&!raw.includes(a.road)?a.road:null,
        a.suburb||a.quarter||a.village||a.town||a.city_district,
        a.state_district||a.state,
      ].filter(Boolean);
      return {
        lat:parseFloat(r.lat), lng:parseFloat(r.lon),
        name:san(raw), sub:san(parts.join(', ')),
        osmKey:r.category||'', osmVal:r.type||'',
        importance:r.importance??0.5,
      };
    });
  }catch{return [];}
}

// ── Coordinate paste ("−33.86, 151.21") ──────────────────────────────────────
function parseCoords(q){
  const m=q.match(/^(-?\d{1,3}\.?\d*)[,\s]+(-?\d{1,3}\.?\d*)$/);
  if(!m) return null;
  const lat=parseFloat(m[1]), lng=parseFloat(m[2]);
  if(lat<-90||lat>90||lng<-180||lng>180) return null;
  return {lat,lng,name:`${lat.toFixed(5)}, ${lng.toFixed(5)}`,sub:'Custom location',dist:0};
}

// ── Highlight query term inside a string (returns safe HTML) ─────────────────
function highlightQuery(text, q){
  if(!text||!q) return escHtml(text||'');
  const idx=text.toLowerCase().indexOf(q.toLowerCase());
  if(idx<0) return escHtml(text);
  return escHtml(text.slice(0,idx))
    +`<mark>${escHtml(text.slice(idx,idx+q.length))}</mark>`
    +escHtml(text.slice(idx+q.length));
}

// ── Relevance score (higher = better) ────────────────────────────────────────
function scoreResult(r, q, lat, lng){
  const ql=q.toLowerCase().trim();
  const nl=(r.name??'').toLowerCase();
  const sl=(r.sub??'').toLowerCase();
  // Text match
  let txt=0;
  if(nl===ql)                                         txt=1.00;
  else if(nl.startsWith(ql))                          txt=0.90;
  else if(nl.includes(' '+ql)||nl.includes(ql+' '))   txt=0.80;
  else if(nl.includes(ql))                             txt=0.68;
  else if(sl.includes(ql))                             txt=0.42;
  else{
    const toks=ql.split(/\s+/).filter(t=>t.length>1);
    const hits=toks.filter(t=>nl.includes(t)||sl.includes(t)).length;
    txt=hits?hits/toks.length*0.55:0;
  }
  // Proximity (log decay, full score inside 200 m)
  const dist=r.dist??(lat&&lng?haversine(lat,lng,r.lat,r.lng):50000);
  const prox=dist<200?1:Math.max(0,1-Math.log10(dist/200)/3.2);
  // Place importance
  const imp=Math.min(1,r.importance??0.5);
  // History boost
  const hist=isFav(r.name)?0.25:(getRecent().some(x=>x.name===r.name)?0.12:0);
  return txt*0.48+prox*0.24+imp*0.18+hist*0.10;
}

// ── Format distance string ────────────────────────────────────────────────────
function fmtDist(m){ return m==null?'':(m<1000?`${Math.round(m)}m`:`${(m/1000).toFixed(1)}km`); }

// ── POI category → Overpass filter + emoji ──────────────────────────────────
const OVERPASS_CAT = {
  // Fuel / Petrol
  petrol:              ['[amenity=fuel]','⛽'],
  fuel:                ['[amenity=fuel]','⛽'],
  servo:               ['[amenity=fuel]','⛽'],
  'service station':   ['[amenity=fuel]','⛽'],
  'gas station':       ['[amenity=fuel]','⛽'],
  'petrol station':    ['[amenity=fuel]','⛽'],
  bp:                  ['[amenity=fuel][name~"BP",i]','⛽'],
  shell:               ['[amenity=fuel][name~"Shell",i]','⛽'],
  caltex:              ['[amenity=fuel][name~"Caltex|Ampol",i]','⛽'],
  ampol:               ['[amenity=fuel][name~"Ampol",i]','⛽'],
  united:              ['[amenity=fuel][name~"United",i]','⛽'],
  'seven eleven':      ['[amenity=fuel][name~"7-Eleven",i]','⛽'],
  '7-eleven':          ['[amenity=fuel][name~"7-Eleven",i]','⛽'],
  '7eleven':           ['[amenity=fuel][name~"7-Eleven",i]','⛽'],
  metro:               ['[amenity=fuel][name~"Metro",i]','⛽'],
  // Food / Drink
  food:                ['[amenity~"restaurant|fast_food|cafe|food_court"]','🍽️'],
  eat:                 ['[amenity~"restaurant|fast_food|cafe"]','🍽️'],
  restaurant:          ['[amenity=restaurant]','🍽️'],
  cafe:                ['[amenity=cafe]','☕'],
  coffee:              ['[amenity=cafe]','☕'],
  'flat white':        ['[amenity=cafe]','☕'],
  'fast food':         ['[amenity=fast_food]','🍔'],
  takeaway:            ['[amenity=fast_food]','🍔'],
  takeout:             ['[amenity=fast_food]','🍔'],
  mcdonalds:           ['[amenity=fast_food][name~"McDonald",i]','🍔'],
  "mcdonald's":        ['[amenity=fast_food][name~"McDonald",i]','🍔'],
  maccas:              ['[amenity=fast_food][name~"McDonald",i]','🍔'],
  macca:               ['[amenity=fast_food][name~"McDonald",i]','🍔'],
  kfc:                 ['[amenity=fast_food][name~"KFC|Kentucky",i]','🍗'],
  subway:              ['[amenity=fast_food][name~"Subway",i]','🥖'],
  'hungry jacks':      ['[amenity=fast_food][name~"Hungry",i]','🍔'],
  'hungry jack':       ['[amenity=fast_food][name~"Hungry",i]','🍔'],
  hj:                  ['[amenity=fast_food][name~"Hungry",i]','🍔'],
  pizza:               ['[amenity~"restaurant|fast_food"][name~"Pizza|Domino|Pizzeria",i]','🍕'],
  dominos:             ['[amenity~"restaurant|fast_food"][name~"Domino",i]','🍕'],
  "domino's":          ['[amenity~"restaurant|fast_food"][name~"Domino",i]','🍕'],
  "pizza hut":         ['[amenity~"restaurant|fast_food"][name~"Pizza Hut",i]','🍕'],
  chippies:            ['[amenity~"restaurant|fast_food"][name~"fish|chip|chippery",i]','🐟'],
  'fish and chips':    ['[amenity~"restaurant|fast_food"][name~"fish|chip",i]','🐟'],
  sushi:               ['[amenity~"restaurant|fast_food"][name~"sushi|japanese",i]','🍣'],
  thai:                ['[amenity=restaurant][cuisine=thai]','🍜'],
  chinese:             ['[amenity=restaurant][cuisine~"chinese|asian",i]','🥢'],
  indian:              ['[amenity=restaurant][cuisine=indian]','🍛'],
  pub:                 ['[amenity~"pub|bar"]','🍺'],
  bar:                 ['[amenity~"pub|bar"]','🍺'],
  'bottle shop':       ['[amenity~"bar|pub"][shop~"alcohol|wine",i]|[shop=alcohol]','🍾'],
  'bottle-o':          ['[shop=alcohol]','🍾'],
  bottlo:              ['[shop=alcohol]','🍾'],
  'dan murphys':       ['[shop=alcohol][name~"Dan Murphy",i]','🍾'],
  'bws':               ['[shop=alcohol][name~"BWS",i]','🍾'],
  // Medical
  hospital:            ['[amenity=hospital]','🏥'],
  pharmacy:            ['[amenity=pharmacy]','💊'],
  chemist:             ['[amenity=pharmacy]','💊'],
  'chemist warehouse': ['[amenity=pharmacy][name~"Chemist Warehouse",i]','💊'],
  priceline:           ['[amenity=pharmacy][name~"Priceline",i]','💊'],
  medical:             ['[amenity~"hospital|clinic|doctors|pharmacy"]','🏥'],
  doctor:              ['[amenity~"clinic|doctors"]','🩺'],
  gp:                  ['[amenity~"clinic|doctors"]','🩺'],
  clinic:              ['[amenity~"clinic|doctors"]','🩺'],
  dentist:             ['[amenity=dentist]','🦷'],
  // Parking
  parking:             ['[amenity=parking]','🅿️'],
  'car park':          ['[amenity=parking]','🅿️'],
  carpark:             ['[amenity=parking]','🅿️'],
  // Supermarkets / Shops
  supermarket:         ['[shop=supermarket]','🛒'],
  groceries:           ['[shop=supermarket]','🛒'],
  woolworths:          ['[shop=supermarket][name~"Woolworths",i]','🛒'],
  woolies:             ['[shop=supermarket][name~"Woolworths",i]','🛒'],
  coles:               ['[shop=supermarket][name~"Coles",i]','🛒'],
  aldi:                ['[shop~"supermarket|discount"][name~"ALDI",i]','🛒'],
  iga:                 ['[shop=supermarket][name~"IGA",i]','🛒'],
  harris:              ['[shop=supermarket][name~"Harris Farm",i]','🥦'],
  newsagent:           ['[shop=newsagent]','📰'],
  // Banking
  atm:                 ['[amenity=atm]','🏧'],
  bank:                ['[amenity=bank]','🏦'],
  commonwealth:        ['[amenity=bank][name~"Commonwealth|CBA",i]','🏦'],
  westpac:             ['[amenity=bank][name~"Westpac",i]','🏦'],
  anz:                 ['[amenity=bank][name~"ANZ",i]','🏦'],
  nab:                 ['[amenity=bank][name~"NAB",i]','🏦'],
  // Other
  police:              ['[amenity=police]','🚨'],
  gym:                 ['[leisure~"fitness_centre|gym"]','🏋️'],
  fitness:             ['[leisure~"fitness_centre|gym"]','🏋️'],
  'anytime fitness':   ['[leisure=fitness_centre][name~"Anytime",i]','🏋️'],
  'f45':               ['[leisure=fitness_centre][name~"F45",i]','🏋️'],
  hotel:               ['[tourism~"hotel|motel|guest_house"]','🏨'],
  motel:               ['[tourism~"hotel|motel"]','🏨'],
  accommodation:       ['[tourism~"hotel|motel|guest_house|hostel"]','🏨'],
  park:                ['[leisure=park]','🌳'],
  playground:          ['[leisure=playground]','🛝'],
  school:              ['[amenity~"school|primary|secondary"]','🏫'],
  library:             ['[amenity=library]','📚'],
  airport:             ['[aeroway=aerodrome]','✈️'],
  mechanic:            ['[shop~"car_repair|tyres|tyre"]','🔧'],
  'car wash':          ['[amenity=car_wash]','🚿'],
  carwash:             ['[amenity=car_wash]','🚿'],
  pool:                ['[leisure~"swimming_pool|water_park"]','🏊'],
  'swimming pool':     ['[leisure=swimming_pool]','🏊'],
  toilet:              ['[amenity=toilets]','🚻'],
  toilets:             ['[amenity=toilets]','🚻'],
  'public toilet':     ['[amenity=toilets]','🚻'],
  ev:                  ['[amenity=charging_station]','⚡'],
  'ev charger':        ['[amenity=charging_station]','⚡'],
  'charging station':  ['[amenity=charging_station]','⚡'],
  tesla:               ['[amenity=charging_station][name~"Tesla|Supercharger",i]','⚡'],
};

// Detect if a query is a known POI category (returns [filter, emoji] or null)
function detectCategory(q){
  const ql = q.toLowerCase().trim();
  // exact match first, then prefix match
  if(OVERPASS_CAT[ql]) return OVERPASS_CAT[ql];
  for(const [k,v] of Object.entries(OVERPASS_CAT)){
    if(ql.startsWith(k+' ')||ql.endsWith(' '+k)) return v;
  }
  return null;
}

// ── Overpass API — comprehensive OSM POI search ──────────────────────────────
async function overpassSearch(filter, emoji, lat, lng, radius=6000){
  const q=`[out:json][timeout:10];(node${filter}(around:${radius},${lat},${lng});way${filter}(around:${radius},${lat},${lng}););out center 25;`;
  try{
    const resp=await fetch('https://overpass-api.de/api/interpreter',{method:'POST',body:'data='+encodeURIComponent(q)});
    if(!resp.ok) return [];
    const data=await resp.json();
    return (data.elements??[]).map(el=>{
      const t=el.tags??{};
      const elLat=el.lat??el.center?.lat;
      const elLng=el.lon??el.center?.lon;
      if(!elLat||!elLng) return null;
      const name=san(t.name||t.brand||t['name:en']||t.operator||'Unknown');
      const dist=haversine(lat,lng,elLat,elLng);
      const distStr=dist<1000?`${Math.round(dist)}m`:`${(dist/1000).toFixed(1)}km`;
      const addrParts=[
        t['addr:housenumber']?`${t['addr:housenumber']} ${t['addr:street']||''}`.trim():t['addr:street'],
        t['addr:suburb']||t['addr:city'],
      ].filter(Boolean);
      const sub=san(addrParts.length?addrParts.join(', ')+' · '+distStr:distStr);
      return {lat:elLat,lng:elLng,name,sub,dist,_emoji:emoji};
    }).filter(Boolean).sort((a,b)=>a.dist-b.dist);
  }catch{return [];}
}

// ── Photon geocoder — address / place-name search ────────────────────────────
async function geocode(q, nearLat, nearLng){
  const params = new URLSearchParams({ q, limit:'10', lang:'en' });
  const gps = userMarker ? userMarker.getLngLat() : null;
  const bLat = nearLat ?? gps?.lat ?? map.getCenter().lat;
  const bLng = nearLng ?? gps?.lng ?? map.getCenter().lng;
  params.set('lat', bLat);
  params.set('lon', bLng);
  params.set('zoom', '12');
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
        sub:  san([p.housenumber ? `${p.housenumber} ${p.street||''}`.trim() : p.street,
                   p.suburb || p.district || p.town || p.village || p.city,
                   p.state].filter(Boolean).join(', ')),
        osmKey: p.osm_key ?? '',
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
  if(k==='amenity'){const m={hospital:'🏥',clinic:'🏥',pharmacy:'💊',fuel:'⛽',restaurant:'🍽️',cafe:'☕',fast_food:'🍔',bar:'🍺',bank:'🏦',school:'🏫',university:'🎓',library:'📚',police:'🚨',fire_station:'🚒',cinema:'🎬',theatre:'🎭'};return m[v]||'📍';}
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
  if(map.getZoom()<14){clearMarkers(reportMarkers);return;}
  const b=map.getBounds();
  const p=new URLSearchParams({swlat:b.getSouth(),swlng:b.getWest(),nelat:b.getNorth(),nelng:b.getEast()});
  try{
    const data=await fetch(`/api/reports?${p}`).then(r=>r.json());
    clearMarkers(reportMarkers);
    for(const r of data){
      // speed_trap uses speed layer filter; police/all others use police filter
      if(r.type==='speed_trap'&&!visibleLayers.speed) continue;
      if(r.type!=='speed_trap'&&!visibleLayers.police) continue;
      const icon=ICONS[r.type]??ICONS.hazard;
      const age=Math.round((Date.now()-r.created_at)/60000);
      const label={police:'🚨 5-0',speed_trap:'🎯 Speed trap',accident:'💥 Crash',hazard:'💀 Hazard',traffic:'🚗 Traffic',closure:'🚧 Closure',roadwork:'🔧 Roadwork',weather:'🌧️ Weather',blocked_lane:'🦺 Blocked lane'}[r.type]??r.type;
      const ageStr=age<60?`${age}m ago`:`${Math.round(age/60)}h ago`;
      const popupHtml=`<strong>${label}</strong>${r.description?`<p>${escHtml(r.description)}</p>`:''}<p>${ageStr} · ✅ ${r.confirms} 👎 ${r.denies}</p><div class="popup-actions"><button class="popup-confirm" onclick="vote('${r.id}','confirm')">✅ Still there</button><button class="popup-deny" onclick="vote('${r.id}','deny')">👎 Gone</button></div>`;
      const popup=new maplibregl.Popup({offset:24,maxWidth:'260px'}).setHTML(popupHtml);
      reportMarkers.push(new maplibregl.Marker({element:icon.el(),anchor:'center'}).setLngLat([r.lng,r.lat]).setPopup(popup).addTo(map));
    }
  }catch{}
}
window.vote=async(id,action)=>{try{await fetch(`/api/reports/${id}/${action}`,{method:'POST'});loadReports();}catch{}};

async function loadCameras(){
  if(map.getZoom()<11){clearMarkers(cameraMarkers);return;}
  const b=map.getBounds();
  const p=new URLSearchParams({swlat:b.getSouth(),swlng:b.getWest(),nelat:b.getNorth(),nelng:b.getEast()});
  try{
    const data=await fetch(`/api/cameras?${p}`).then(r=>r.json());
    clearMarkers(cameraMarkers);
    cameraMarkerEls.clear();
    for(const cam of data){
      if(cam.type==='speed'&&!visibleLayers.speed) continue;
      if((cam.type==='red_light'||cam.type==='average_speed'||cam.type==='bus_lane')&&!visibleLayers.red_light) continue;
      const icon=ICONS[cam.type]??ICONS.speed;
      const label={speed:'🎯 Speed camera',red_light:'🔴 Red light camera',average_speed:'📡 Avg speed',bus_lane:'🚌 Bus lane camera'}[cam.type]??cam.type;
      const popupHtml=`<strong>${label}</strong>${cam.road?`<p>📍 ${escHtml(cam.road)}</p>`:''} ${cam.speed_limit?`<p>⚡ ${cam.speed_limit} km/h zone</p>`:''} ${cam.state?`<p>📌 ${cam.state}</p>`:''}<p style="color:#555;font-size:.7rem">Source: ${cam.source.toUpperCase()}</p>`;
      const popup=new maplibregl.Popup({offset:24,maxWidth:'260px'}).setHTML(popupHtml);
      // Wrap in a ripple container so we can add CSS classes as user approaches
      const wrap=document.createElement('div');
      wrap.className='cam-marker-wrap';
      wrap.appendChild(icon.el());
      cameraMarkerEls.set(String(cam.id),wrap);
      cameraMarkers.push(new maplibregl.Marker({element:wrap,anchor:'center'}).setLngLat([cam.lng,cam.lat]).setPopup(popup).addTo(map));
    }
  }catch{}
}

function scheduleFetch(){clearTimeout(fetchTmr);fetchTmr=setTimeout(()=>{loadReports();loadCameras();if(heatmapVisible)loadHeatmap();},300);}
map.on('moveend',scheduleFetch);map.on('zoomend',scheduleFetch);
setInterval(loadReports,90_000);

document.querySelectorAll('.filter-btn').forEach(btn=>{
  if(btn.id==='heatmap-btn') return;
  btn.addEventListener('click',()=>{
    const l=btn.dataset.layer; visibleLayers[l]=!visibleLayers[l];
    btn.classList.toggle('active',visibleLayers[l]);loadReports();loadCameras();
  });
});

/* ═══════════════════════════════════════════════
   REPORT FLOW — Waze-style two-step bottom sheet
═══════════════════════════════════════════════ */
const REPORT_CATS = {
  police: {
    label:'5-0', emoji:'🚨', title:'Report police',
    subtypes:[
      {key:'police',     label:'Police',        emoji:'🚨', bg:'#1a2540'},
      {key:'hidden',     label:'Hidden',        emoji:'👁️', bg:'#1e2030'},
      {key:'other_side', label:'Other side',    emoji:'↩️', bg:'#222'},
    ]
  },
  speed_trap: {
    label:'Speed trap', emoji:'🎯', title:'Report speed trap',
    subtypes:[
      {key:'speed_trap',   label:'Mobile camera', emoji:'🎯', bg:'#1e1a2e'},
      {key:'fixed_camera', label:'Fixed camera',  emoji:'🔴', bg:'#2a1414'},
    ]
  },
  accident: {
    label:'Crash', emoji:'💥', title:'Report a crash',
    subtypes:[
      {key:'accident',   label:'Crash',        emoji:'💥', bg:'#2a1414'},
      {key:'pileup',     label:'Pile-up',      emoji:'💥', bg:'#2a1010'},
      {key:'other_side', label:'Other side',   emoji:'↩️', bg:'#222'},
    ]
  },
  traffic: {
    label:'Traffic', emoji:'🚗', title:'Report traffic',
    subtypes:[
      {key:'traffic',     label:'Heavy traffic', emoji:'🚗', bg:'#1a1408'},
      {key:'standstill',  label:'Standstill',    emoji:'☠️', bg:'#2a1010'},
      {key:'moderate',    label:'Moderate',      emoji:'🟡', bg:'#241c0a'},
    ]
  },
  hazard: {
    label:'Hazard', emoji:'💀', title:'Report a hazard',
    subtypes:[
      {key:'hazard',   label:'Hazard',          emoji:'💀', bg:'#241c0a'},
      {key:'pothole',  label:'Pothole',          emoji:'🕳️', bg:'#1a1a1a'},
      {key:'object',   label:'Object on road',   emoji:'💣', bg:'#1a1818'},
      {key:'animal',   label:'Animal on road',   emoji:'🐄', bg:'#1a1a10'},
    ]
  },
  closure: {
    label:'Closure', emoji:'🚧', title:'Report road closure',
    subtypes:[
      {key:'closure',      label:'Road closed',   emoji:'🚧', bg:'#2a1010'},
      {key:'detour',       label:'Detour',         emoji:'↪️', bg:'#241c0a'},
    ]
  },
  roadwork: {
    label:'Roadwork', emoji:'🔧', title:'Report roadwork',
    subtypes:[
      {key:'roadwork',     label:'Roadwork',       emoji:'🔧', bg:'#1a1608'},
      {key:'lane_closed',  label:'Lane closed',    emoji:'🚧', bg:'#2a1010'},
      {key:'slow_zone',    label:'Slow zone',      emoji:'🔽', bg:'#1a1408'},
    ]
  },
  weather: {
    label:'Bad weather', emoji:'🌧️', title:'Report bad weather',
    subtypes:[
      {key:'weather_rain',  label:'Heavy rain',  emoji:'🌧️', bg:'#0a1a2a'},
      {key:'weather_fog',   label:'Fog',         emoji:'🌫️', bg:'#1a1a1a'},
      {key:'weather_flood', label:'Flooding',    emoji:'🌊', bg:'#0a1020'},
      {key:'weather_wind',  label:'High winds',  emoji:'💨', bg:'#0a1424'},
    ]
  },
  blocked_lane: {
    label:'Blocked lane', emoji:'🦺', title:'Report blocked lane',
    subtypes:[
      {key:'blocked_lane',  label:'Lane blocked',  emoji:'🦺', bg:'#1a1020'},
      {key:'shoulder',      label:'Shoulder only', emoji:'➡️', bg:'#1a1818'},
      {key:'breakdown',     label:'Breakdown',     emoji:'🚘', bg:'#2a1010'},
    ]
  },
};

let pendingLat=null, pendingLng=null, selCat=null, selSubKey=null;
const reportSheet=$$('report-sheet'), reportBtn=$$('report-btn');
const rptStep1=$$('rpt-step1'), rptStep2=$$('rpt-step2');

function openReportSheet(){
  const c=map.getCenter();
  // During nav prefer actual GPS position
  if(navState==='navigating'&&prevPos){ pendingLat=prevPos.lat; pendingLng=prevPos.lng; }
  else { pendingLat=c.lat; pendingLng=c.lng; }
  rptStep1.classList.remove('hidden');
  rptStep2.classList.add('hidden');
  reportSheet.classList.remove('hidden');
}
function closeReportSheet(){ reportSheet.classList.add('hidden'); selCat=null; selSubKey=null; }

reportBtn.addEventListener('click', openReportSheet);
$$('rpt-close1').addEventListener('click', closeReportSheet);
$$('rpt-back').addEventListener('click', ()=>{
  rptStep1.classList.remove('hidden');
  rptStep2.classList.add('hidden');
});

document.querySelectorAll('.rpt-cat').forEach(btn=>{
  btn.addEventListener('click',()=>{
    selCat = btn.dataset.cat;
    const cat = REPORT_CATS[selCat];
    $$('rpt-step2-title').textContent = cat.title;
    // Build sub-type buttons
    $$('rpt-subtypes').innerHTML = cat.subtypes.map((s,i)=>`
      <button class="rpt-sub${i===0?' selected':''}" data-key="${s.key}">
        <div class="rpt-sub-icon" style="background:${s.bg}">${s.emoji}</div>
        <span>${s.label}</span>
      </button>`).join('');
    selSubKey = cat.subtypes[0].key;
    $$('rpt-subtypes').querySelectorAll('.rpt-sub').forEach(b=>{
      b.addEventListener('click',()=>{
        $$('rpt-subtypes').querySelectorAll('.rpt-sub').forEach(x=>x.classList.remove('selected'));
        b.classList.add('selected');
        selSubKey=b.dataset.key;
      });
    });
    rptStep1.classList.add('hidden');
    rptStep2.classList.remove('hidden');
  });
});

$$('rpt-cancel').addEventListener('click', closeReportSheet);
$$('rpt-submit').addEventListener('click', async()=>{
  if(!pendingLat||!selCat||!selSubKey) return;
  const btn=$$('rpt-submit'); btn.disabled=true; btn.textContent='Reporting…';
  // Map sub-key back to a DB-valid type for the API
  const apiType = selCat; // police|speed_trap|accident|hazard
  const cat=REPORT_CATS[selCat];
  const sub=cat.subtypes.find(s=>s.key===selSubKey);
  const desc=sub?sub.label:undefined;
  try{
    const res=await fetch('/api/reports',{method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({lat:pendingLat,lng:pendingLng,type:apiType,description:desc})});
    if(res.ok){
      closeReportSheet();
      map.easeTo({center:[pendingLng,pendingLat],zoom:Math.max(map.getZoom(),14)});
      loadReports();
      showToast(`${cat.emoji} ${desc} reported!`);
    } else { const e=await res.json(); alert(e.error??'Failed'); }
  }catch{ alert('Network error'); }
  finally{ btn.disabled=false; btn.textContent='Report'; }
});

/* ═══════════════════════════════════════════════
   SETTINGS PANEL
═══════════════════════════════════════════════ */
const stylePanel=$$('style-panel'), styleBg=$$('style-panel-bg'), styleClose=$$('style-close');
styleClose.addEventListener('click',()=>stylePanel.classList.add('hidden'));
styleBg.addEventListener('click',()=>stylePanel.classList.add('hidden'));

/* ── Idle bar buttons ──────────────────────────── */
$$('idle-search-btn').addEventListener('click', openPlanner);
$$('idle-settings-btn').addEventListener('click', ()=>stylePanel.classList.remove('hidden'));

/* ── Idle bar drag-up to open planner ─────────── */
(()=>{
  const bar = $$('idle-bar');
  if(!bar) return;
  let startY=0, startT=0, active=false;
  bar.addEventListener('touchstart', e=>{
    if(e.target.closest('button')) return;
    startY=e.touches[0].clientY; startT=Date.now(); active=true;
  }, {passive:true});
  bar.addEventListener('touchmove', e=>{
    if(!active) return;
    const dy=startY-e.touches[0].clientY;
    if(dy>0) bar.style.transform=`translateY(${-dy}px)`;
  }, {passive:true});
  bar.addEventListener('touchend', e=>{
    if(!active) return;
    active=false; bar.style.transform='';
    const dy=startY-e.changedTouches[0].clientY, vel=dy/(Date.now()-startT);
    if(dy>60||vel>0.4) openPlanner();
  }, {passive:true});
  bar.addEventListener('touchcancel', ()=>{ active=false; bar.style.transform=''; }, {passive:true});
})();

document.querySelectorAll('.style-btn').forEach(btn=>{ btn.addEventListener('click',()=>{ setTile(btn.dataset.style);stylePanel.classList.add('hidden'); }); });

const toggleMap = { 's-voice':'voice','s-camera':'cameraAlerts','s-police':'policeAlerts','s-haptic':'haptic','s-tolls':'avoidTolls' };
Object.entries(toggleMap).forEach(([id,key])=>{
  const el=document.getElementById(id); if(!el)return;
  el.checked=prefs[key]??true;
  el.addEventListener('change',()=>{
    prefs[key]=el.checked; savePrefs();
    if(key==='avoidTolls') routeOpts.avoidTolls=el.checked;
  });
});

// Choose start toggle — not in prefs (defaults off); controls body class + from-row visibility
(()=>{
  const el=$$('s-choosestart'); if(!el) return;
  const saved=localStorage.getItem('showStart')==='1';
  el.checked=saved;
  document.body.classList.toggle('show-start',saved);
  el.addEventListener('change',()=>{
    document.body.classList.toggle('show-start',el.checked);
    localStorage.setItem('showStart',el.checked?'1':'0');
  });
})();

document.querySelectorAll('.unit-btn').forEach(btn=>{
  btn.classList.toggle('active',btn.dataset.unit===prefs.unit);
  btn.addEventListener('click',()=>{
    prefs.unit=btn.dataset.unit; savePrefs();
    document.querySelectorAll('.unit-btn').forEach(b=>b.classList.toggle('active',b.dataset.unit===prefs.unit));
  });
});

document.querySelectorAll('.lighting-btn').forEach(btn=>{
  btn.classList.toggle('active',btn.dataset.lighting===(prefs.lighting??'auto'));
  btn.addEventListener('click',()=>{
    prefs.lighting=btn.dataset.lighting; savePrefs();
    prefs.styleOverride=false; savePrefs(); // allow auto-night to override style now
    document.querySelectorAll('.lighting-btn').forEach(b=>b.classList.toggle('active',b.dataset.lighting===prefs.lighting));
    autoNightCheck();
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
// peek must fit: handle(22) + time(42) + via(18) + gap(12) + buttons(52) + bottom-pad(16) + safe-area(≤40) ≈ 200
const SNAP = { peek: 240, half: Math.round(window.innerHeight * 0.44), full: Math.round(window.innerHeight * 0.82) };
window.addEventListener('resize', () => {
  SNAP.half = Math.round(window.innerHeight * 0.44);
  SNAP.full = Math.round(window.innerHeight * 0.82);
});

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
let destMarker=null, userMarker=null;
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
function onUserPan(){
  userPanning=true;
  clearTimeout(pausePanTimer);
  pausePanTimer=setTimeout(()=>{
    userPanning=false;
    // recenter-btn stays visible during nav — don't hide it here
  }, 6000);
}
map.on('dragstart',e=>{ if(e.originalEvent) onUserPan(); });
map.on('zoomstart',e=>{ if(e.originalEvent) onUserPan(); });

/* ── Long-press on map → "Drive here" ──────────────────────────────────────
   600 ms hold on the map canvas opens a popup at the tapped location with
   a reverse-geocoded name and a one-tap "Drive here" button.
   Right-click (desktop) triggers the same flow.
─────────────────────────────────────────────────────────────────────────── */
let _lpTimer=null, _lpFired=false, _tapPopup=null, _tapMarker=null;

function _clearLongPress(){ clearTimeout(_lpTimer); _lpTimer=null; }

async function _openTapPopup(lngLat){
  if(_tapMarker){ _tapMarker.remove(); _tapMarker=null; }
  if(_tapPopup){ _tapPopup.remove(); _tapPopup=null; }

  const el=document.createElement('div');
  el.innerHTML='<span class="dest-pin">📍</span>';
  _tapMarker=new maplibregl.Marker({element:el,anchor:'bottom'}).setLngLat(lngLat).addTo(map);

  let name='Selected location';
  try{
    const r=await fetch(`https://photon.komoot.io/reverse?lon=${lngLat.lng}&lat=${lngLat.lat}&lang=en`);
    const d=await r.json();
    if(d.features?.length){
      const p=d.features[0].properties;
      name=san(p.name||p.street||p.city||name);
    }
  }catch{}

  _tapPopup=new maplibregl.Popup({offset:44,closeButton:true,maxWidth:'200px'})
    .setHTML(`<strong style="display:block;font-size:.9rem;margin-bottom:8px">${escHtml(name)}</strong><button id="tap-drive-btn" style="width:100%;padding:11px;background:#00cfff;border:none;border-radius:10px;color:#000;font-weight:900;font-size:.9rem;cursor:pointer">Drive here</button>`)
    .setLngLat(lngLat)
    .addTo(map);

  // Wire button after popup is in DOM
  requestAnimationFrame(()=>{
    const btn=document.getElementById('tap-drive-btn');
    if(!btn) return;
    btn.addEventListener('click',()=>{
      _tapPopup.remove(); _tapPopup=null;
      if(_tapMarker){ _tapMarker.remove(); _tapMarker=null; }
      toPlace={lat:lngLat.lat,lng:lngLat.lng,name};
      toInput.value=name; toClear.classList.remove('hidden');
      tryRoute();
    });
  });
}

(()=>{
  const canvas=map.getCanvas();
  canvas.addEventListener('touchstart',e=>{
    if(e.touches.length!==1||navState==='navigating') return;
    _lpFired=false;
    const t=e.touches[0];
    const rect=canvas.getBoundingClientRect();
    const pt=map.unproject([t.clientX-rect.left,t.clientY-rect.top]);
    _lpTimer=setTimeout(()=>{
      _lpFired=true;
      if(navigator.vibrate) navigator.vibrate(40);
      _openTapPopup(pt);
    },620);
  },{passive:true});
  canvas.addEventListener('touchmove',_clearLongPress,{passive:true});
  canvas.addEventListener('touchend',_clearLongPress,{passive:true});
  canvas.addEventListener('touchcancel',_clearLongPress,{passive:true});
})();
// Desktop: right-click
map.on('contextmenu',e=>{
  if(navState==='navigating') return;
  e.preventDefault?.();
  _openTapPopup(e.lngLat);
});

let nearCameras=[], nearReports=[], alertedIds=new Set();
let speedLimitWays=[]; // [{coords:[[lat,lng],...], limit:number}] — from Overpass
let alertHideTimer=null;
let activeAlert=null;
let lastRefreshedMidx=-1; // {lat,lng,dismissDist} — persists bar until hazard is passed
let schoolZones=[];
let headingUpMode=false;
let arrivedFlag=false;

/* ── Open / close planner ──────────────────────── */
plannerBack.addEventListener('click', closePlanner);

/* ═══════════════════════════════════════════════
   SMOOTH MARKER ANIMATION — interpolates between GPS fixes
   so the car doesn't teleport between 1-2 second position updates.
═══════════════════════════════════════════════ */
let _mFrom=null, _mTo=null, _mHdgFrom=0, _mHdgTo=0;
let _mStart=0, _mDur=1000, _mRaf=null, _mCurHdg=0, _mLastSpeedMs=0;
const _easeIO=t=>t<0.5?2*t*t:-1+(4-2*t)*t;
const _arc=(a,b)=>((b-a)%360+540)%360-180;

function animateMarkerTo(lat,lng,hdg,dur){
  const cur=userMarker?userMarker.getLngLat():{lat,lng};
  if(_mRaf){cancelAnimationFrame(_mRaf);_mRaf=null;}
  _mFrom={lat:cur.lat,lng:cur.lng};
  _mHdgFrom=_mCurHdg;
  _mTo={lat,lng};
  _mHdgTo=hdg;
  _mDur=Math.max(dur,300);
  _mStart=performance.now();
  _mRaf=requestAnimationFrame(_stepMarker);
}

function _stepMarker(ts){
  const t=_easeIO(Math.min((ts-_mStart)/_mDur,1));
  const lat=_mFrom.lat+(_mTo.lat-_mFrom.lat)*t;
  const lng=_mFrom.lng+(_mTo.lng-_mFrom.lng)*t;
  _mCurHdg=_mHdgFrom+_arc(_mHdgFrom,_mHdgTo)*t;
  if(userMarker){
    userMarker.setLngLat([lng,lat]);
    const arrow=userMarker.getElement()?.querySelector('.user-arrow');
    if(arrow) arrow.style.transform=`rotate(${_mCurHdg-map.getBearing()}deg)`;
  }
  // Drive the map camera at 60fps from the same loop — silky bearing-up following
  if(navState==='navigating' && !userPanning){
    if(perspective3D){
      const navZ=targetNavZoom(_mLastSpeedMs);
      map.jumpTo({center:[lng,lat],bearing:_mCurHdg,pitch:65,zoom:navZ});
    } else {
      map.jumpTo({center:[lng,lat],bearing:headingUpMode?_mCurHdg:map.getBearing(),pitch:0,zoom:targetNavZoom(_mLastSpeedMs)});
    }
  }
  _mRaf=t<1?requestAnimationFrame(_stepMarker):null;
}

// Keep SVG rotation in sync when map rotates (bearing-up panning)
map.on('rotate',()=>{
  if(!userMarker)return;
  const svg=userMarker.getElement()?.querySelector('svg');
  if(svg) svg.style.transform=`rotate(${_mCurHdg-map.getBearing()}deg)`;
});

function openPlanner(){
  topbar.classList.add('hidden');
  // Step 1: make element renderable (display:flex) while still off-screen
  planner.style.display='flex';
  // Step 2: two rAF frames so browser has painted before transition starts
  requestAnimationFrame(()=>requestAnimationFrame(()=>planner.classList.add('planner-open')));
  document.body.classList.add('searching');
  navState='searching';
  fromInput.placeholder = userMarker ? '📍 My location' : 'Choose start…';
  routeOpts.avoidTolls = prefs.avoidTolls??true;
  routeOpts.avoidHighways = false;
  $$('avoid-tolls').classList.toggle('active', routeOpts.avoidTolls);
  $$('avoid-highways').classList.remove('active');
  setActiveField('to');
  _syncPlannerH();
  // Do NOT auto-focus — keyboard should only open on explicit tap of the input field
  showSuggestions();
}
function closePlanner(){
  // Dismiss keyboard before animating out
  fromInput.blur(); toInput.blur();
  topbar.classList.remove('hidden');
  planner.style.height=''; // reset any expanded height
  planner.classList.remove('planner-open'); // triggers slide-down transition
  // After transition ends, hide completely so nothing underneath is blocked
  setTimeout(()=>{ if(!planner.classList.contains('planner-open')) planner.style.display='none'; }, 380);
  document.body.classList.remove('searching');
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
  const gps=userMarker?userMarker.getLngLat():null;
  let html='';
  html+=`<div id="nearme-chips">
    <button class="nearme-chip" data-q="petrol">⛽ Petrol</button>
    <button class="nearme-chip" data-q="food">🍔 Food</button>
    <button class="nearme-chip" data-q="hospital">🏥 Hospital</button>
    <button class="nearme-chip" data-q="parking">🅿️ Parking</button>
    <button class="nearme-chip" data-q="cafe">☕ Coffee</button>
    <button class="nearme-chip" data-q="supermarket">🛒 Supermarket</button>
    <button class="nearme-chip" data-q="pharmacy">💊 Pharmacy</button>
    <button class="nearme-chip" data-q="atm">🏧 ATM</button>
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
      const gpsPos=userMarker?userMarker.getLngLat():null;
      const lat=gpsPos?.lat??map.getCenter().lat, lng=gpsPos?.lng??map.getCenter().lng;
      searchResultsEl.innerHTML=`<div class="no-results">Searching nearby…</div>`;
      const cat=detectCategory(q);
      if(cat){
        let results=await overpassSearch(cat[0],cat[1],lat,lng,6000);
        if(results.length<4) results=await overpassSearch(cat[0],cat[1],lat,lng,15000);
        if(!results.length){searchResultsEl.innerHTML=`<div class="no-results">None found nearby</div>`;return;}
        searchResultsEl.innerHTML=results.slice(0,20).map(r=>resultRow(r,isFav(r.name),true,r._emoji)).join('');
      } else {
        const results=await geocode(q,lat,lng);
        if(!results.length){searchResultsEl.innerHTML=`<div class="no-results">None found nearby</div>`;return;}
        searchResultsEl.innerHTML=results.map(r=>resultRow(r,isFav(r.name),true,placeEmoji(r),placeLabel(r))).join('');
      }
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
    if(!q){showSuggestions();return;}
    if(q.length===1){ doSearch(q); return; } // instant on first char (local only)
    srchDebounce=setTimeout(()=>doSearch(q),180);
  });
}
wireInput(fromInput,'from');
wireInput(toInput,'to');

// Dismiss keyboard the instant the user's finger touches the results list
searchResultsEl.addEventListener('touchstart',()=>{
  fromInput.blur(); toInput.blur();
},{passive:true});

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
  const gps=userMarker?userMarker.getLngLat():null;
  const lat=gps?.lat??map.getCenter().lat, lng=gps?.lng??map.getCenter().lng;

  // ① Coordinate paste — instant
  const coords=parseCoords(q);
  if(coords){
    searchResultsEl.innerHTML=resultRow(coords,false,true,'📍','Custom location',q);
    bindResultClicks(); return;
  }

  // ② Local matches (recents + favs) shown immediately while APIs load
  const locals=[...getFavs(),...getRecent()]
    .filter(p=>p.name&&p.name.toLowerCase().includes(q.toLowerCase()))
    .reduce((acc,p)=>{ if(!acc.find(x=>x.name===p.name))acc.push(p); return acc; },[])
    .map(p=>({...p,dist:lat&&lng?haversine(lat,lng,p.lat,p.lng):null}))
    .sort((a,b)=>(a.dist??9e9)-(b.dist??9e9));

  function renderLocals(extras=[], extraLabel=''){
    let html='';
    if(locals.length){
      html+=`<div class="results-section-label">🕐 Recent &amp; saved</div>`;
      html+=locals.slice(0,3).map(r=>resultRow(r,isFav(r.name),true,placeEmoji(r),null,q)).join('');
    }
    if(extras.length){
      html+=`<div class="results-section-label">${extraLabel}</div>`;
      html+=extras.map(r=>resultRow(r,isFav(r.name),true,r._emoji??placeEmoji(r),placeLabel(r),q)).join('');
    }
    if(!html) html=`<div class="no-results srch-spin">Searching…</div>`;
    searchResultsEl.innerHTML=html;
    bindResultClicks();
  }

  renderLocals(); // show locals + spinner immediately

  // ③ Category → Overpass only
  const cat=detectCategory(q);
  if(cat){
    let results=await overpassSearch(cat[0],cat[1],lat,lng,6000);
    if(results.length<4) results=await overpassSearch(cat[0],cat[1],lat,lng,20000);
    if(!results.length){ searchResultsEl.innerHTML=`<div class="no-results">None nearby — try zooming out</div>`; return; }
    results.forEach(r=>{ r.dist=haversine(lat,lng,r.lat,r.lng); r._score=scoreResult(r,q,lat,lng); });
    results.sort((a,b)=>b._score-a._score);
    searchResultsEl.innerHTML=results.slice(0,25).map(r=>resultRow(r,isFav(r.name),true,r._emoji,null,q)).join('');
    bindResultClicks(); return;
  }

  // ④ Free-text: fan out to three sources in parallel
  const [photonRaw, nomRaw, overpassByName]=await Promise.all([
    geocode(q,lat,lng),
    geocodeNominatimAU(q,lat,lng),
    overpassNameSearch(q,lat,lng,12000),
  ]);

  const enriched=[
    ...enrichPhoton(photonRaw,lat,lng),
    ...enrichPhoton(nomRaw,lat,lng),
    ...overpassByName,
  ];
  const merged=mergeResults([enriched],lat,lng); // dedup
  if(!merged.length&&!locals.length){
    searchResultsEl.innerHTML=`<div class="no-results">Nothing found for "<strong>${escHtml(q)}</strong>"<br><small>Check spelling or try a suburb name</small></div>`;
    return;
  }

  // ⑤ Score every result and sort
  merged.forEach(r=>{ r._score=scoreResult(r,q,lat,lng); });
  merged.sort((a,b)=>b._score-a._score);

  // ⑥ Render — sections: locals first, then place results
  let html='';
  if(locals.length){
    html+=`<div class="results-section-label">🕐 Recent &amp; saved</div>`;
    html+=locals.slice(0,2).map(r=>resultRow(r,isFav(r.name),true,placeEmoji(r),null,q)).join('');
  }
  if(merged.length){
    if(locals.length) html+=`<div class="results-section-label">🔍 Results</div>`;
    html+=merged.slice(0,20).map(r=>resultRow(r,isFav(r.name),true,r._emoji??placeEmoji(r),placeLabel(r),q)).join('');
  }
  searchResultsEl.innerHTML=html||`<div class="no-results">Nothing found</div>`;
  bindResultClicks();
}

function resultRow(p, faved, showFav=true, emoji='📍', label=null, q=''){
  const nameHtml=q?highlightQuery(p.name,q):escHtml(p.name);
  const dist=fmtDist(p.dist);
  return `<div class="search-result" data-lat="${p.lat}" data-lng="${p.lng}" data-name="${escHtml(p.name)}" data-sub="${escHtml(p.sub??'')}">
    <span class="result-emoji">${emoji}</span>
    <span class="result-body">
      <strong>${nameHtml}</strong>
      ${label?`<em>${escHtml(label)}</em>`:''}
      <span>${escHtml(p.sub??'')}</span>
    </span>
    ${dist?`<span class="result-dist">${dist}</span>`:''}
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
  const gps=userMarker?userMarker.getLngLat():null;
  const from=fromPlace??(gps?{lat:gps.lat,lng:gps.lng}:{lat:map.getCenter().lat,lng:map.getCenter().lng});
  closePlanner();
  calcRoute(from.lat,from.lng,toPlace.lat,toPlace.lng);
}

/* ═══════════════════════════════════════════════
   ROUTING
═══════════════════════════════════════════════ */
async function calcRoute(fromLat,fromLng,toLat,toLng){
  previewBar.classList.add('hidden');
  map.getSource('route-main')?.setData(emptyFC());
  map.getSource('route-traveled')?.setData(emptyFC());
  map.getSource('route-alts')?.setData(emptyFC());
  if(destMarker){destMarker.remove();destMarker=null;}
  {const el=document.createElement('div');el.innerHTML='<span class="dest-pin">📍</span>';
   destMarker=new maplibregl.Marker({element:el,anchor:'bottom'}).setLngLat([toLng,toLat]).addTo(map);}

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
    fetchRouteSpeedLimits();
    navState='preview';
    document.body.classList.add('previewing');
    // Hide topbar so the map and route are unobstructed
    topbar.classList.add('hidden');
  }catch(e){alert('Routing error: '+e.message);}
}

function applySelectedRoute(){
  routeData=allRoutes[selectedRouteIdx];
  maneuvers=routeData.legs[0].maneuvers;
  routePoints=decodePolyline6(routeData.legs[0].shape);

  // Alt routes as MultiLineString
  const altCoords=allRoutes.filter((_,i)=>i!==selectedRouteIdx).map(t=>toGL(decodePolyline6(t.legs[0].shape)));
  map.getSource('route-alts')?.setData({type:'Feature',geometry:{type:'MultiLineString',coordinates:altCoords}});
  map.getSource('route-traveled')?.setData(emptyFC());
  updateRouteGeoJSON();

  // Fit to route bounds
  const lngs=routePoints.map(p=>p[1]),lats=routePoints.map(p=>p[0]);
  map.fitBounds([[Math.min(...lngs),Math.min(...lats)],[Math.max(...lngs),Math.max(...lats)]],{padding:80});

  const td=routeData.summary.length, tt=routeData.summary.time;
  previewDist.textContent=fmtDist(td*1000);
  previewTime.textContent=fmtTime(tt);
  if(previewETA) previewETA.textContent=`ETA ${fmtETA(tt)}`;
  // Via description — pick up to 3 unique major road names from maneuvers
  const viaRoads=[]; const seen=new Set();
  for(const m of maneuvers){
    for(const n of (m.street_names??[])){
      if(n&&!seen.has(n)&&viaRoads.length<3){seen.add(n);viaRoads.push(n);}
    }
    if(viaRoads.length>=3) break;
  }
  const viaEl=$$('preview-via');
  if(viaEl) viaEl.textContent = viaRoads.length ? 'Via '+viaRoads.join(', ') : '';

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

/* ── OSM speed limits — fetched once per route from Overpass ── */
function parseMaxspeed(raw){
  const AU={'AU:urban':50,'AU:rural':100,'AU:motorway':110,'AU:living_street':10,'AU:school_zone':40};
  if(AU[raw]) return AU[raw];
  const n=parseInt(raw);
  return(!isNaN(n)&&n>5&&n<200)?n:null;
}

function distToSegmentM(lat,lng,[la1,lo1],[la2,lo2]){
  const cos=Math.cos(lat*Math.PI/180);
  const dlat=(la2-la1)*111320, dlon=(lo2-lo1)*111320*cos;
  const plat=(lat-la1)*111320, plon=(lng-lo1)*111320*cos;
  const len2=dlat*dlat+dlon*dlon;
  if(len2<1) return Math.hypot(plat,plon);
  const t=Math.max(0,Math.min(1,(plat*dlat+plon*dlon)/len2));
  return Math.hypot(plat-t*dlat,plon-t*dlon);
}

async function fetchRouteSpeedLimits(){
  if(!routePoints.length) return;
  const lats=routePoints.map(p=>p[0]),lngs=routePoints.map(p=>p[1]);
  const s=Math.min(...lats)-0.002,n=Math.max(...lats)+0.002;
  const w=Math.min(...lngs)-0.002,e=Math.max(...lngs)+0.002;
  const q=`[out:json][timeout:25];way["maxspeed"]["highway"~"^(motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|residential|living_street|unclassified)$"](${s},${w},${n},${e});out tags geom;`;
  try{
    const resp=await fetch('https://overpass-api.de/api/interpreter',{
      method:'POST',body:'data='+encodeURIComponent(q),
      headers:{'Content-Type':'application/x-www-form-urlencoded','User-Agent':'radar-app/1.0'}
    });
    const {elements}=await resp.json();
    speedLimitWays=[];
    for(const el of elements){
      if(!el.geometry?.length||!el.tags?.maxspeed) continue;
      const limit=parseMaxspeed(el.tags.maxspeed);
      if(limit) speedLimitWays.push({coords:el.geometry.map(g=>[g.lat,g.lon]),limit});
    }
  }catch{ speedLimitWays=[]; }
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
    const instr=san(m.instruction??'');
    const speedStr=(m.speed_limit&&m.speed_limit<200)?`${m.speed_limit} km/h`:'';
    const isLast=m.type>=4&&m.type<=6;
    // Only show instruction if it adds info beyond the street name
    const showInstr=instr&&!instr.toLowerCase().startsWith(streets.toLowerCase().slice(0,10));
    return `<div class="dir-step${isLast?' dir-arrive':''}">
      <span class="dir-arrow">${ARROW[m.type]??'↑'}</span>
      <div class="dir-info">
        <span class="dir-street">${escHtml(streets)}</span>
        ${showInstr?`<span class="dir-instr">${escHtml(instr)}</span>`:''}
      </div>
      ${speedStr?`<span class="dir-speed">${speedStr}</span>`:''}
      <span class="dir-dist">${i===0?'Start':fmtDist(d)}</span>
    </div>`;
  }).join('');
}

cancelRoute.addEventListener('click',clearRoute);
function clearRoute(){
  map.getSource('route-main')?.setData(emptyFC());
  map.getSource('route-traveled')?.setData(emptyFC());
  map.getSource('route-alts')?.setData(emptyFC());
  if(destMarker){destMarker.remove();destMarker=null;}
  previewBar.classList.add('hidden');
  $$('route-chips').classList.add('hidden');
  $$('speed-profile').classList.add('hidden');
  navState='idle'; routeData=null; routePoints=[]; maneuvers=[]; allRoutes=[]; schoolZones=[]; speedLimitWays=[];
  fromPlace=null; toPlace=null;
  fromInput.value=''; toInput.value='';
  fromClear.classList.add('hidden'); toClear.classList.add('hidden');
  document.body.classList.remove('previewing');
  // Restore topbar
  topbar.classList.remove('hidden');
}

/* ── Share route ─────────────────────────────── */
$$('share-route-btn').addEventListener('click',async()=>{
  const from=fromPlace??(userMarker?{lat:userMarker.getLngLat().lat,lng:userMarker.getLngLat().lng,name:'My Location'}:null);
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
// With bottom:0 positioning, we need to shift the sheet UP when the keyboard
// appears so it sits in the visible area above the keyboard.
const _syncPlannerH=(()=>{
  const pl=$$('route-planner');
  function sync(){
    const vv=window.visualViewport;
    if(!vv){ pl.style.maxHeight='80dvh'; pl.style.bottom='0'; return; }
    // offsetTop from the visual viewport gives keyboard height
    const kbH=Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    pl.style.bottom=kbH+'px';
    pl.style.maxHeight=(vv.height-12)+'px';
  }
  const vv=window.visualViewport;
  if(vv){ vv.addEventListener('resize',sync); vv.addEventListener('scroll',sync); }
  return sync;
})();

/* ── Drag-to-expand/dismiss on the planner handle ───────────────────────── */
(()=>{
  const pl=$$('route-planner'), handle=pl.querySelector('.handle-row');
  if(!handle) return;
  let startY=0, startT=0, startH=0, dragging=false;
  handle.addEventListener('touchstart',e=>{
    startY=e.touches[0].clientY; startT=Date.now(); dragging=true;
    startH=pl.getBoundingClientRect().height;
    pl.style.transition='none';
  },{passive:true});
  handle.addEventListener('touchmove',e=>{
    if(!dragging) return;
    const dy=e.touches[0].clientY-startY;
    if(dy>0){
      // dragging down → slide to dismiss
      pl.style.height='';
      pl.style.transform=`translateY(${dy}px)`;
    } else {
      // dragging up → expand height
      pl.style.transform='';
      pl.style.height=Math.min(startH-dy, window.innerHeight)+'px';
    }
  },{passive:false});
  handle.addEventListener('touchend',e=>{
    if(!dragging) return; dragging=false;
    pl.style.transition='';
    const dy=e.changedTouches[0].clientY-startY;
    const vel=dy/(Date.now()-startT); // px/ms
    if(dy>80||vel>0.4){
      pl.style.height=''; pl.style.transform=''; closePlanner();
    } else if(dy<-60||vel<-0.4){
      // snapped to full screen
      pl.style.transform='';
      pl.style.transition='height .25s cubic-bezier(0.32,0.72,0,1)';
      pl.style.height=window.innerHeight+'px';
    } else {
      // restore original size
      pl.style.height=''; pl.style.transform='';
    }
  });
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
endNavBtn.addEventListener('click',()=>{ endNav(); showScoreSubmit(); });
arrivalDone.addEventListener('click',()=>{arrivalOverlay.classList.add('hidden');showScoreSubmit();});

function startNav(){
  previewBar.classList.add('hidden');
  document.body.classList.remove('previewing');
  topbar.classList.add('hidden');
  navInst.classList.remove('hidden');
  document.body.classList.add('navigating');
  navFooter.classList.remove('hidden');
  navState='navigating';
  currentMidx=0; lastVoice=-1; offCount=0; alertedIds.clear();
  remainingSec=routeData.summary.time;
  arrivedFlag=false; headingUpMode=true;

  $$('compass-widget').classList.remove('hidden');
  $$('recenter-btn').classList.remove('hidden');
  gtaStartNav();
  _navDistance=0; _prevNavPos=null;
  acquireWakeLock();
  // Safety redraw — ensures route is visible after UI transitions settle
  setTimeout(()=>{ if(routePoints.length) updateRouteGeoJSON(); }, 300);
  enable3DView();

  // Reset heading smoother so it doesn't inherit stale heading
  hdgSet=false; userPanning=false;

  // Clear traveled line in MapLibre GeoJSON source
  map.getSource('route-traveled')?.setData(emptyFC());

  // Compute initial bearing from the first route segment so the map faces the road
  const initBrg=routePoints.length>=2
    ? bearing(routePoints[0][0],routePoints[0][1],routePoints[1][0],routePoints[1][1])
    : 0;

  // Get a FRESH high-accuracy GPS fix immediately (don't rely on stale userMarker)
  navigator.geolocation.getCurrentPosition(pos=>{
    userPanning=false;
    const {latitude:lat,longitude:lng}=pos.coords;
    map.easeTo({center:[lng,lat],zoom:20,pitch:65,bearing:initBrg,duration:700});
  }, ()=>{
    const k=userMarker?userMarker.getLngLat():prevPos?{lng:prevPos.lng,lat:prevPos.lat}:null;
    if(k) map.easeTo({center:[k.lng,k.lat],zoom:20,pitch:65,bearing:initBrg,duration:700});
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
  [navInst,navFooter,alertBar,arrivalOverlay,$$('nav-search-sheet'),$$('nav-routes-sheet')].forEach(el=>el?.classList.add('hidden'));
  updateRouteWarn(null);
  gtaEndNav();
  topbar.classList.remove('hidden');
  document.body.classList.remove('navigating');
  $$('recenter-btn').classList.add('hidden');
  const pill=$$('street-pill'); if(pill) pill.classList.add('hidden');
  activeAlert=null; lastRefreshedMidx=-1;
  const overlay=$$('street-labels-overlay'); if(overlay) overlay.innerHTML='';

  headingUpMode=false;
  disable3DView(); // sets pitch:0 via easeTo
  map.easeTo({bearing:0,pitch:0,duration:400});
  $$('compass-widget').classList.add('hidden');

  releaseWakeLock();
  if(_mRaf){cancelAnimationFrame(_mRaf);_mRaf=null;}
  clearRoute();
  if(userMarker){userMarker.remove();userMarker=null;}
  prevPos=null;
  currentSpeedEl.innerHTML='– <small>km/h</small>';
  speedLimitSign.classList.add('hidden');
}

function gpsErr(e){console.warn('GPS',e.code,e.message);}

/* ── Auto-zoom + look-ahead per zoom level ──────── */
function targetNavZoom(speedMs){
  const kmh=speedMs*3.6;
  if(perspective3D) return kmh>70?18:20;
  if(kmh>75) return 16;
  if(kmh>35) return 17;
  return 18;
}
// Max look-ahead in metres per zoom level (keeps car visible in lower third of screen)
const LOOK_CAP={15:900,16:500,17:220,18:90,19:50};

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
    updateRouteGeoJSON();
    map.getSource('route-traveled')?.setData(emptyFC());
    showToast('Route updated',2000);
    loadNearCameras(); loadNearReports();
  }catch{showToast('Rerouting failed',3000);}
}

/* ═══════════════════════════════════════════════
   CAR ROSTER + CAR PICKER
═══════════════════════════════════════════════ */
function _kart(body, driverContent, iconRot, opts={}){
  const {bodyColor='#29a329', wheelColor='#1e293b', bumpColor='#f59e0b', tailColor='#ef4444', headColor='#fef08a'}=opts;
  return `<svg class="user-arrow" style="transform:rotate(${iconRot}deg)" viewBox="0 0 90 120" width="90" height="120" xmlns="http://www.w3.org/2000/svg">
    <ellipse cx="45" cy="116" rx="30" ry="5" fill="rgba(0,0,0,0.28)"/>
    <rect x="24" y="100" width="10" height="16" rx="5" fill="#555"/><rect x="56" y="100" width="10" height="16" rx="5" fill="#555"/>
    <circle cx="29" cy="100" r="5" fill="#333"/><circle cx="61" cy="100" r="5" fill="#333"/>
    <path d="M18 42 C18 24 28 16 45 16 C62 16 72 24 72 42 L74 92 C74 100 62 106 45 106 C28 106 16 100 16 92 Z" fill="${bodyColor}"/>
    <path d="M24 44 C24 30 32 24 45 24 C58 24 66 30 66 44 L67 88" stroke="rgba(255,255,255,.18)" stroke-width="3.5" fill="none" stroke-linecap="round"/>
    <rect x="14" y="98" width="62" height="7" rx="3.5" fill="${bodyColor}" opacity=".7"/>
    <rect x="20" y="14" width="50" height="10" rx="5" fill="${bumpColor}"/>
    <ellipse cx="45" cy="64" rx="20" ry="26" fill="${bodyColor}" opacity=".6"/>
    <rect x="1" y="74" width="18" height="28" rx="9" fill="${wheelColor}"/><rect x="71" y="74" width="18" height="28" rx="9" fill="${wheelColor}"/>
    <rect x="4" y="80" width="8" height="12" rx="4" fill="rgba(255,255,255,.15)"/><rect x="78" y="80" width="8" height="12" rx="4" fill="rgba(255,255,255,.15)"/>
    <rect x="1" y="28" width="18" height="24" rx="9" fill="${wheelColor}"/><rect x="71" y="28" width="18" height="24" rx="9" fill="${wheelColor}"/>
    <rect x="4" y="34" width="8" height="10" rx="4" fill="rgba(255,255,255,.15)"/><rect x="78" y="34" width="8" height="10" rx="4" fill="rgba(255,255,255,.15)"/>
    ${driverContent}
    <rect x="23" y="14" width="14" height="7" rx="3.5" fill="${headColor}"/><rect x="53" y="14" width="14" height="7" rx="3.5" fill="${headColor}"/>
    <rect x="23" y="100" width="12" height="6" rx="3" fill="${tailColor}"/><rect x="55" y="100" width="12" height="6" rx="3" fill="${tailColor}"/>
    <circle cx="10" cy="68" r="2.5" fill="#fde68a" opacity=".7"/><circle cx="80" cy="62" r="2" fill="#fde68a" opacity=".6"/>
  </svg>`;
}

// Shared face + hat helper
function _marioFace(hatColor, hatBadgeColor, overallColor, badgeLetter){
  return `
    <ellipse cx="45" cy="80" rx="14" ry="11" fill="${overallColor}"/>
    <rect x="40" y="68" width="5" height="14" rx="2.5" fill="${overallColor}"/>
    <rect x="50" y="68" width="5" height="14" rx="2.5" fill="${overallColor}"/>
    <rect x="41" y="60" width="8" height="7" rx="3.5" fill="#fde8c8"/>
    <circle cx="45" cy="50" r="17" fill="#fde8c8"/>
    <ellipse cx="45" cy="61" rx="12" ry="6" fill="#f5d5b0"/>
    <circle cx="28" cy="50" r="5" fill="#fde8c8"/><circle cx="62" cy="50" r="5" fill="#fde8c8"/>
    <ellipse cx="45" cy="38" rx="20" ry="8" fill="${hatColor}"/>
    <path d="M30 38 C30 24 36 17 45 17 C54 17 60 24 60 38 Z" fill="${hatColor}"/>
    <ellipse cx="45" cy="38" rx="20" ry="4.5" fill="${hatColor}" opacity=".7"/>
    <ellipse cx="41" cy="26" rx="7" ry="5" fill="rgba(255,255,255,.18)"/>
    <circle cx="45" cy="29" r="9" fill="white"/>
    <rect x="42" y="22" width="4" height="12" rx="2" fill="${hatBadgeColor}"/>
    <rect x="42" y="31.5" width="9" height="4" rx="2" fill="${hatBadgeColor}"/>
    <path d="M34 43 C36 40 40 40 43 43" stroke="#2c1810" stroke-width="3" fill="none" stroke-linecap="round"/>
    <path d="M47 43 C50 40 54 40 56 43" stroke="#2c1810" stroke-width="3" fill="none" stroke-linecap="round"/>
    <circle cx="38" cy="48" r="4.5" fill="white"/><circle cx="52" cy="48" r="4.5" fill="white"/>
    <circle cx="39" cy="49" r="2.6" fill="#2c1810"/><circle cx="53" cy="49" r="2.6" fill="#2c1810"/>
    <circle cx="40" cy="47.5" r="1" fill="white"/><circle cx="54" cy="47.5" r="1" fill="white"/>
    <circle cx="45" cy="54" r="4" fill="#f0b090"/>
    <ellipse cx="37" cy="59" rx="7.5" ry="5" fill="#111"/>
    <ellipse cx="53" cy="59" rx="7.5" ry="5" fill="#111"/>`;
}

function makeLuigiIcon(gpsHdg=0){
  const iconRot=gpsHdg-map.getBearing();
  return {html:_kart(_marioFace('#29a329','#29a329','#1a52c8','L'),iconRot,{bodyColor:'#29a329'})};
}
function makeMarioIcon(gpsHdg=0){
  const iconRot=gpsHdg-map.getBearing();
  return {html:_kart(_marioFace('#dc2626','#dc2626','#dc2626','M'),iconRot,{bodyColor:'#b91c1c',bumpColor:'#fbbf24',tailColor:'#fbbf24'})};
}
function makePikachuIcon(gpsHdg=0){
  const iconRot=gpsHdg-map.getBearing();
  const driver=`
    <ellipse cx="45" cy="80" rx="14" ry="11" fill="#fbbf24"/>
    <rect x="41" y="60" width="8" height="7" rx="3.5" fill="#fbbf24"/>
    <circle cx="45" cy="49" r="17" fill="#fde68a"/>
    <ellipse cx="45" cy="60" rx="12" ry="6" fill="#f5c842"/>
    <!-- ears -->
    <path d="M28 38 L24 16 L34 32 Z" fill="#fbbf24"/><path d="M26 18 L30 14 L33 26 Z" fill="#111"/>
    <path d="M62 38 L66 16 L56 32 Z" fill="#fbbf24"/><path d="M64 18 L60 14 L57 26 Z" fill="#111"/>
    <!-- cheeks -->
    <circle cx="32" cy="52" r="6" fill="#ef4444" opacity=".8"/>
    <circle cx="58" cy="52" r="6" fill="#ef4444" opacity=".8"/>
    <!-- eyes -->
    <circle cx="38" cy="46" r="4" fill="#111"/><circle cx="52" cy="46" r="4" fill="#111"/>
    <circle cx="39.5" cy="44.5" r="1.5" fill="white"/><circle cx="53.5" cy="44.5" r="1.5" fill="white"/>
    <!-- nose + mouth -->
    <circle cx="45" cy="51" r="2.5" fill="#8B4513"/>
    <path d="M41 55 Q45 59 49 55" stroke="#8B4513" stroke-width="1.8" fill="none" stroke-linecap="round"/>
    <!-- lightning bolt on body -->
    <path d="M47 70 L43 80 L47 80 L43 90" stroke="#f59e0b" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
  return {html:_kart(driver,iconRot,{bodyColor:'#fbbf24',bumpColor:'#fbbf24',wheelColor:'#374151',tailColor:'#fbbf24',headColor:'#fde68a'})};
}
function makeBowserIcon(gpsHdg=0){
  const iconRot=gpsHdg-map.getBearing();
  const driver=`
    <ellipse cx="45" cy="78" rx="15" ry="13" fill="#166534"/>
    <rect x="41" y="60" width="8" height="8" rx="3" fill="#f97316"/>
    <!-- spiky shell back -->
    <ellipse cx="45" cy="72" rx="12" ry="8" fill="#15803d"/>
    <path d="M33 68 L30 60 M39 65 L37 56 M45 64 L45 55 M51 65 L53 56 M57 68 L60 60" stroke="#fbbf24" stroke-width="3" stroke-linecap="round"/>
    <!-- head -->
    <ellipse cx="45" cy="49" rx="16" ry="15" fill="#f97316"/>
    <ellipse cx="45" cy="60" rx="12" ry="6" fill="#ea7730"/>
    <!-- horns -->
    <path d="M32 38 L28 28 L36 34 Z" fill="#fbbf24"/><path d="M58 38 L62 28 L54 34 Z" fill="#fbbf24"/>
    <!-- angry eyes -->
    <ellipse cx="38" cy="46" rx="5" ry="4" fill="#dc2626"/>
    <ellipse cx="52" cy="46" rx="5" ry="4" fill="#dc2626"/>
    <circle cx="39" cy="47" r="2.5" fill="#111"/><circle cx="53" cy="47" r="2.5" fill="#111"/>
    <circle cx="40" cy="46" r="1" fill="white"/><circle cx="54" cy="46" r="1" fill="white"/>
    <!-- thick brows -->
    <path d="M32 41 L42 43" stroke="#111" stroke-width="3.5" stroke-linecap="round"/>
    <path d="M48 43 L58 41" stroke="#111" stroke-width="3.5" stroke-linecap="round"/>
    <!-- snout -->
    <ellipse cx="45" cy="54" rx="7" ry="5" fill="#fdba74"/>
    <circle cx="42.5" cy="54" r="2" fill="#9a5227"/><circle cx="47.5" cy="54" r="2" fill="#9a5227"/>
    <!-- teeth -->
    <rect x="39" y="58" width="5" height="4" rx="1" fill="white"/>
    <rect x="46" y="58" width="5" height="4" rx="1" fill="white"/>`;
  return {html:_kart(driver,iconRot,{bodyColor:'#15803d',bumpColor:'#fbbf24',wheelColor:'#292524',tailColor:'#dc2626',headColor:'#fde68a'})};
}
function makePeachIcon(gpsHdg=0){
  const iconRot=gpsHdg-map.getBearing();
  const driver=`
    <ellipse cx="45" cy="80" rx="14" ry="11" fill="#f9a8d4"/>
    <rect x="40" y="68" width="5" height="14" rx="2.5" fill="#f9a8d4"/>
    <rect x="50" y="68" width="5" height="14" rx="2.5" fill="#f9a8d4"/>
    <rect x="41" y="60" width="8" height="7" rx="3.5" fill="#fde8c8"/>
    <circle cx="45" cy="49" r="17" fill="#fde8c8"/>
    <ellipse cx="45" cy="60" rx="12" ry="6" fill="#f5d5b0"/>
    <!-- blonde hair -->
    <ellipse cx="45" cy="34" rx="18" ry="10" fill="#fde047"/>
    <path d="M27 38 L24 55 L30 50 L28 60" stroke="#fde047" stroke-width="5" stroke-linecap="round" fill="none"/>
    <path d="M63 38 L66 55 L60 50 L62 60" stroke="#fde047" stroke-width="5" stroke-linecap="round" fill="none"/>
    <!-- crown -->
    <path d="M30 32 L32 22 L38 28 L45 20 L52 28 L58 22 L60 32 Z" fill="#fbbf24"/>
    <circle cx="38" cy="24" r="3" fill="#ec4899"/><circle cx="45" cy="21" r="3" fill="#60a5fa"/><circle cx="52" cy="24" r="3" fill="#ec4899"/>
    <!-- face -->
    <circle cx="38" cy="48" r="4" fill="white"/><circle cx="52" cy="48" r="4" fill="white"/>
    <circle cx="39" cy="49" r="2.3" fill="#1e3a5f"/><circle cx="53" cy="49" r="2.3" fill="#1e3a5f"/>
    <circle cx="40" cy="47.5" r=".9" fill="white"/><circle cx="54" cy="47.5" r=".9" fill="white"/>
    <circle cx="34" cy="53" r="4" fill="#fda4af" opacity=".7"/><circle cx="56" cy="53" r="4" fill="#fda4af" opacity=".7"/>
    <circle cx="45" cy="53" r="2.5" fill="#f0a080"/>
    <path d="M40 57 Q45 61 50 57" stroke="#b45309" stroke-width="1.8" fill="none" stroke-linecap="round"/>`;
  return {html:_kart(driver,iconRot,{bodyColor:'#ec4899',bumpColor:'#fbbf24',tailColor:'#fda4af',headColor:'#fde047'})};
}

/* ═══════════════════════════════════════════════
   GTA CAR SYSTEM — Unlucky Studio realistic sprites
   PNGs pre-flipped so front faces UP — rotation is
   just gpsHdg - mapBearing, matching the SVG cars.
═══════════════════════════════════════════════ */
function _pngCar(src, gpsHdg){
  const rot=gpsHdg-map.getBearing();
  return {html:`<div class="user-arrow" style="transform:rotate(${rot}deg)"><img class="car-sprite" src="${src}" draggable="false"></div>`};
}
const _pc=(src)=>(h)=>_pngCar(src,h);
const _pi=(src)=>`<img src="${src}" class="car-pick-img">`;

const CARS=[
  // ── 3D perspective car sprites ────────────────────────────────────────────
  {id:'ferrari488',    name:'Ferrari 488',       icon:_pi('/cars/ferrari488.svg'),    fn:_pc('/cars/ferrari488.svg')},
  {id:'lambohuracan',  name:'Huracán',            icon:_pi('/cars/lambohuracan.svg'),  fn:_pc('/cars/lambohuracan.svg')},
  {id:'mclaren720',    name:'McLaren 720S',       icon:_pi('/cars/mclaren720.svg'),    fn:_pc('/cars/mclaren720.svg')},
  {id:'bugattichiron', name:'Bugatti Chiron',     icon:_pi('/cars/bugattichiron.svg'), fn:_pc('/cars/bugattichiron.svg')},
  {id:'bmwm4',         name:'BMW M4',             icon:_pi('/cars/bmwm4.svg'),         fn:_pc('/cars/bmwm4.svg')},
  {id:'porsche911',    name:'Porsche 911',        icon:_pi('/cars/porsche911.svg'),    fn:_pc('/cars/porsche911.svg')},
  {id:'amggt',         name:'AMG GT Black',       icon:_pi('/cars/amggt.svg'),         fn:_pc('/cars/amggt.svg')},
  {id:'astondb11',     name:'Aston Martin DB11',  icon:_pi('/cars/astondb11.svg'),     fn:_pc('/cars/astondb11.svg')},
  {id:'bentleygtc',    name:'Bentley GTC',        icon:_pi('/cars/bentleygtc.svg'),    fn:_pc('/cars/bentleygtc.svg')},
  {id:'rollsroyce',    name:'Rolls-Royce',        icon:_pi('/cars/rollsroyce.svg'),    fn:_pc('/cars/rollsroyce.svg')},
  {id:'gtrr35',        name:'Nissan GT-R',        icon:_pi('/cars/gtrr35.svg'),        fn:_pc('/cars/gtrr35.svg')},
  {id:'challenger',    name:'Challenger',         icon:_pi('/cars/challenger.svg'),    fn:_pc('/cars/challenger.svg')},
  {id:'mustanggt',     name:'Mustang GT500',      icon:_pi('/cars/mustanggt.svg'),     fn:_pc('/cars/mustanggt.svg')},
  {id:'fordraptor',    name:'Ford Raptor',        icon:_pi('/cars/fordraptor.svg'),    fn:_pc('/cars/fordraptor.svg')},
  {id:'rangerover',    name:'Range Rover',        icon:_pi('/cars/rangerover.svg'),    fn:_pc('/cars/rangerover.svg')},
  {id:'lambourus',     name:'Lambo Urus',         icon:_pi('/cars/lambourus.svg'),     fn:_pc('/cars/lambourus.svg')},
  {id:'cybertruck',    name:'Cybertruck',         icon:_pi('/cars/cybertruck.svg'),    fn:_pc('/cars/cybertruck.svg')},
  {id:'wrangler',      name:'Wrangler',           icon:_pi('/cars/wrangler.svg'),      fn:_pc('/cars/wrangler.svg')},
  // ── Easter eggs ───────────────────────────────────────────────────────────
  {id:'luigi',     name:'Luigi',     icon:'🟢', fn:makeLuigiIcon},
  {id:'mario',     name:'Mario',     icon:'🔴', fn:makeMarioIcon},
  {id:'pikachu',   name:'Pikachu',   icon:'⚡', fn:makePikachuIcon},
  {id:'bowser',    name:'Bowser',    icon:'🐢', fn:makeBowserIcon},
  {id:'peach',     name:'Peach',     icon:'👸', fn:makePeachIcon},
];
let selectedCar=localStorage.getItem('selectedCar')??(CARS[0].id);
function getCarFn(){ return CARS.find(c=>c.id===selectedCar)?.fn ?? makeLuigiIcon; }

function makeUserIcon(gpsHdg=0){ return getCarFn()(gpsHdg); }

/* ── Car picker ──────────────────────────────── */
(()=>{
  const grid=$$('car-grid'); if(!grid) return;
  CARS.forEach(car=>{
    const btn=document.createElement('button');
    btn.className='car-pick-btn'+(car.id===selectedCar?' active':'');
    btn.dataset.carid=car.id;
    btn.innerHTML=`<div class="car-pick-preview">${car.icon}</div><span>${car.name}</span>`;
    btn.addEventListener('click',()=>{
      selectedCar=car.id;
      localStorage.setItem('selectedCar',car.id);
      document.querySelectorAll('.car-pick-btn').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      // Recreate marker with new car
      if(userMarker&&prevPos){
        const ll=userMarker.getLngLat();
        userMarker.remove(); userMarker=null;
        userMarker=makeUserMarker(ll.lat,ll.lng,_mCurHdg).addTo(map);
      }
    });
    grid.appendChild(btn);
  });
})();

/* ═══════════════════════════════════════════════
   GTA MODE — points, wanted stars, overlays
═══════════════════════════════════════════════ */
const gta={score:0, stars:0, starsTarget:0, highStars:0, cooldownTimer:null, busted:false};

function fmtScore(n){ return n>=1000?`${(n/1000).toFixed(1)}K`:String(n); }

function renderGtaStars(stars){
  document.querySelectorAll('.gta-star').forEach(el=>{
    const i=parseInt(el.dataset.i);
    el.classList.toggle('active', i<=stars);
  });
  $$('gta-score-val').textContent=fmtScore(Math.floor(gta.score));
  $$('gta-hud')?.setAttribute('data-stars', String(stars));
}

function flashStar(i){
  const el=document.querySelector(`.gta-star[data-i="${i}"]`);
  if(!el) return;
  el.classList.remove('pulse');
  requestAnimationFrame(()=>{ el.classList.add('pulse'); });
  el.addEventListener('animationend',()=>el.classList.remove('pulse'),{once:true});
}

function showGtaPopup(text, color, x, y){
  const el=document.createElement('div');
  el.className='gta-score-popup';
  el.style.cssText=`color:${color};left:${x??16}px;top:${y??200}px`;
  el.textContent=text;
  document.body.appendChild(el);
  setTimeout(()=>el.remove(),1500);
}

function setGtaStars(newStars, prevStars){
  if(newStars===prevStars) return;
  gta.stars=newStars;
  renderGtaStars(newStars);
  const hud=$$('gta-hud');
  if(newStars>prevStars){
    // Stars going up — flash new stars, show WANTED banner
    for(let i=prevStars+1;i<=newStars;i++) setTimeout(()=>flashStar(i),(i-prevStars-1)*120);
    showWantedBanner(newStars);
    gta.highStars=Math.max(gta.highStars,newStars);
  } else if(newStars===0 && prevStars>=3){
    // Evaded!
    showEvaded();
    gta.highStars=0;
  } else if(newStars===0){
    hideWantedBanner();
    gta.highStars=0;
  }
}

let _wantedBannerTimer=null;
function showWantedBanner(stars){
  const banner=$$('gta-wanted-banner'); if(!banner) return;
  $$('gta-wanted-stars').textContent='★'.repeat(stars)+'☆'.repeat(5-stars);
  banner.classList.remove('hidden');
  clearTimeout(_wantedBannerTimer);
  _wantedBannerTimer=setTimeout(hideWantedBanner, 3500);
}
function hideWantedBanner(){
  $$('gta-wanted-banner')?.classList.add('hidden');
}

function showBusted(){
  if(gta.busted) return; gta.busted=true;
  hideWantedBanner();
  const ov=$$('gta-busted-overlay'); if(!ov) return;
  ov.classList.remove('hidden');
  if(prefs.haptic&&navigator.vibrate) navigator.vibrate([500,200,500,200,500]);
  speak('Busted!');
  gta.score=Math.floor(gta.score*0.5); // penalty
  showGtaPopup('BUSTED! Score ÷2','#ef4444',80,300);
  setTimeout(()=>{ ov.classList.add('hidden'); gta.busted=false; setGtaStars(0,gta.stars); },2400);
}
function showEvaded(){
  const ov=$$('gta-evaded-overlay'); if(!ov) return;
  ov.classList.remove('hidden');
  speak('Evaded!');
  const bonus=gta.highStars*500;
  gta.score+=bonus;
  showGtaPopup(`EVADED! +${fmtScore(bonus)}`,'#4ade80',60,260);
  hideWantedBanner();
  setTimeout(()=>ov.classList.add('hidden'),2000);
}

// Main GTA update — star calc always runs; score/popups nav-only
function updateGta(speedMs, limitKmh, lat, lng){
  if(gta.busted) return;
  const speedKmh=speedMs*3.6;
  const limit=limitKmh||60;
  const excessKmh=speedKmh-limit;

  // ── Wanted star calculation (always active) ───────────────────────────────
  let target=0;
  if(excessKmh>=10) target=1;
  if(excessKmh>=20) target=2;
  if(excessKmh>=30) target=3;
  if(excessKmh>=45) target=4;
  if(excessKmh>=60) target=5;

  // Police or speed trap nearby bumps wanted level
  const closestCop=nearReports.filter(r=>r.type==='police'||r.type==='speed_trap')
    .map(r=>haversine(lat,lng,r.lat,r.lng)).sort((a,b)=>a-b)[0]??Infinity;
  if(closestCop<120&&excessKmh>5) target=Math.min(5,target+2);
  else if(closestCop<250&&excessKmh>5) target=Math.min(5,target+1);

  gta.starsTarget=target;

  // Stars rise immediately; fall on a cooldown timer
  if(target>gta.stars){
    clearTimeout(gta.cooldownTimer); gta.cooldownTimer=null;
    setGtaStars(target,gta.stars);
  } else if(target===0&&gta.stars>0&&!gta.cooldownTimer){
    gta.cooldownTimer=setTimeout(()=>{
      gta.cooldownTimer=null;
      if(gta.starsTarget===0) setGtaStars(Math.max(0,gta.stars-1),gta.stars);
    },7000);
  }

  // ── Nav-only: score accumulation, popups, BUSTED ─────────────────────────
  if(navState!=='navigating') return;

  const basePerSec=8;
  const speedBonus=excessKmh>0?excessKmh*0.5:0;
  const mult=[1,1.5,2,3.5,5,10][gta.stars]??1;
  const gained=(basePerSec+speedBonus)*mult;
  gta.score+=gained;
  renderGtaStars(gta.stars);

  if(excessKmh>10&&Math.random()<0.08){
    const x=16+Math.random()*60, y=180+Math.random()*80;
    showGtaPopup(`+${Math.round(gained*8)}`,excessKmh>30?'#f97316':'#fbbf24',x,y);
  }

  if(gta.stars>=4&&closestCop<80&&excessKmh>15) showBusted();
}

/* ── Wire GTA HUD into startNav / endNav ─── */
function gtaStartNav(){
  gta.score=0; gta.stars=0; gta.starsTarget=0; gta.highStars=0; gta.busted=false;
  clearTimeout(gta.cooldownTimer); gta.cooldownTimer=null;
  renderGtaStars(0);
  hideWantedBanner();
}
function gtaEndNav(){
  hideWantedBanner();
  $$('gta-busted-overlay')?.classList.add('hidden');
  $$('gta-evaded-overlay')?.classList.add('hidden');
  clearTimeout(gta.cooldownTimer); gta.cooldownTimer=null;
  // Stars drift to 0 naturally via cooldown; reset score immediately
  gta.score=0; renderGtaStars(gta.stars);
}

function makeUserMarker(lat,lng,gpsHdg=0){
  const el=document.createElement('div');
  el.innerHTML=makeUserIcon(gpsHdg).html;
  el.style.zIndex='9999';
  return new maplibregl.Marker({element:el,anchor:'center'}).setLngLat([lng,lat]);
}

/* ── GPS handler ────────────────────────────────── */
function onGPS(pos){
  const {latitude:lat,longitude:lng,speed:rawSpd,heading}=pos.coords;
  localStorage.setItem('radar_lastpos', JSON.stringify({lat,lng}));

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

  _mLastSpeedMs=speedMs; // expose speed to rAF camera loop

  // Snap car to the nearest point on the route polyline when within 40 m.
  // Eliminates GPS drift that places the car icon off the road.
  let dispLat=lat, dispLng=lng, dispHdg=hdg;
  if(navState==='navigating' && routePoints.length){
    const {idx:sIdx,dist:sDist}=nearestOnRoute(routePoints,lat,lng);
    if(sDist<40){
      dispLat=routePoints[sIdx][0];
      dispLng=routePoints[sIdx][1];
      const nxt=routePoints[Math.min(sIdx+1,routePoints.length-1)];
      // Only use road direction when the next point is far enough to be meaningful
      if(haversine(dispLat,dispLng,nxt[0],nxt[1])>2){
        dispHdg=bearing(dispLat,dispLng,nxt[0],nxt[1]);
      }
    }
  }

  if(!userMarker){
    userMarker=makeUserMarker(dispLat,dispLng,dispHdg).addTo(map);
    _mCurHdg=dispHdg; _mHdgTo=dispHdg;
    _mFrom={lat:dispLat,lng:dispLng}; _mTo={lat:dispLat,lng:dispLng};
  } else {
    const gpsInterval=prevPos?Math.min(Math.max(pos.timestamp-prevPos.ts,400),2000):800;
    const cur=userMarker.getLngLat();
    const jumpDist=haversine(cur.lat,cur.lng,dispLat,dispLng);
    // For large GPS jumps slow down the catch-up to avoid a teleport snap;
    // extend normal interval by 25% so adjacent animations always overlap.
    const animMs = jumpDist>80 ? gpsInterval*2.5 : gpsInterval*1.25;
    animateMarkerTo(dispLat,dispLng,dispHdg,animMs);
  }
  // Camera follow is driven by _stepMarker at 60fps — no easeTo here during nav

  if(navState==='navigating'){
    currentSpeedEl.innerHTML=fmtSpeed(speedMs);
    const lim=getSpeedLimit(lat,lng);
    const dispLim=lim?(prefs.unit==='mph'?Math.round(lim*0.621):lim):null;
    const speedDisp=prefs.unit==='mph'?toMph(speedMs):toKmh(speedMs);
    const over=dispLim&&speedDisp>dispLim;
    const wayOver=dispLim&&speedDisp>dispLim+10;
    currentSpeedEl.classList.toggle('over-limit',over);
    currentSpeedEl.classList.toggle('way-over',wayOver);
    speedLimitSign.classList.toggle('over-limit',over);
    if(over&&prefs.haptic&&navigator.vibrate) navigator.vibrate([100,50,100]);
    if(dispLim){speedLimitSign.classList.remove('hidden');speedLimitVal.textContent=dispLim;}
    else speedLimitSign.classList.add('hidden');
  }

  // Always update wanted stars from speed (nav-only score handled inside updateGta)
  { const _lim=getSpeedLimit(lat,lng); updateGta(speedMs,_lim,lat,lng); }

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
  trackNavDistance();
  if(perspective3D&&currentMidx!==lastRefreshedMidx){lastRefreshedMidx=currentMidx;refreshStreetLabels();}
  updateSpeedProfileCursor();

  if(!headingUpMode&&speedMs>2){
    headingUpMode=true;
  }

  if((nextM.type>=4&&nextM.type<=6)&&distToTurn<25){
    triggerArrival();
  }
}

// toGL declared earlier to avoid temporal dead zone

let _lastRouteIdx=0; // track last GPS route index so style swaps don't reset the trimmed line

function updateRouteGeoJSON(){
  if(!routePoints.length) return;
  if(!map.getSource('route-main') || !map.getLayer('route-main')){
    try{ setupMapLayers(); }catch(_){}
  }
  // During navigation always show only the remaining portion — never reset to full route
  if(navState==='navigating'){ updateRouteStyling(_lastRouteIdx); return; }
  const coords = toGL(routePoints);
  const fc = {type:'FeatureCollection',features:[
    {type:'Feature',properties:{},geometry:{type:'LineString',coordinates:coords}}
  ]};
  try{ map.getSource('route-main')?.setData(fc); }catch(_){}
  try{ map.setLayoutProperty('route-main','visibility','visible'); }catch(_){}
}

function updateRouteStyling(idx){
  if(!routePoints.length) return;
  _lastRouteIdx=idx;
  const rem = toGL(routePoints.slice(Math.max(0,idx)));
  map.getSource('route-main')?.setData({type:'Feature',geometry:{type:'LineString',coordinates:rem}});
  map.getSource('route-traveled')?.setData({type:'Feature',geometry:{type:'LineString',coordinates:[]}});
}

function updateNavPanel(distToTurn){
  if(!maneuvers.length)return;
  const nextM=maneuvers[currentMidx+1]??maneuvers[currentMidx];
  navIconEl.innerHTML=ARROW_SVG[nextM.type]??NAV_SVG.straight;
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

  // Update street-pill with current road name
  const pill=$$('street-pill');
  if(pill){
    const streetName=san((maneuvers[currentMidx]?.street_names??[]).join(' / ')||'');
    pill.textContent=streetName;
    pill.classList.toggle('hidden',!streetName);
  }
}

function getSpeedLimit(lat,lng){
  const m=maneuvers[currentMidx];
  if(m?.speed_limit&&m.speed_limit<200) return m.speed_limit;
  if(!speedLimitWays.length) return null;
  const clat=lat??prevPos?.lat, clng=lng??prevPos?.lng;
  if(clat==null) return null;
  let minD=Infinity,best=null;
  for(const way of speedLimitWays){
    for(let i=0;i<way.coords.length-1;i++){
      const d=distToSegmentM(clat,clng,way.coords[i],way.coords[i+1]);
      if(d<minD){minD=d;best=way.limit;}
    }
  }
  return minD<30?best:null;
}

/* ── Compass widget — driven by map's rotate event ── */
function updateCompass(){
  const bearing=map.getBearing();
  // Rotate the N/S diamond so the pink tip always points to geographic north
  const dial=$$('compass-svg');
  if(dial) dial.style.transform=`rotate(${bearing}deg)`;
  const off=Math.abs(bearing%360)>0.5;
  $$('compass-widget').classList.toggle('hidden',!off);
  // Update car rotation when bearing changes
  if(userMarker&&prevPos){
    const arrow=userMarker.getElement()?.querySelector('.user-arrow');
    if(arrow) arrow.style.transform=`rotate(${(prevPos.hdg??0)-bearing}deg)`;
  }
}

// Wire map rotate event (fires on setBearing AND two-finger gesture)
map.on('rotate', updateCompass);

$$('compass-widget').addEventListener('click', resetNorthUp);
$$('recenter-btn').addEventListener('click',()=>{
  userPanning=false;
  clearTimeout(pausePanTimer);
  if(prevPos && navState==='navigating'){
    const {lat,lng}=prevPos;
    if(perspective3D){
      map.easeTo({center:[lng,lat],bearing:_mCurHdg,pitch:65,zoom:targetNavZoom(_mLastSpeedMs),duration:400});
    } else {
      map.easeTo({center:[lng,lat],bearing:headingUpMode?_mCurHdg:0,pitch:0,zoom:targetNavZoom(_mLastSpeedMs),duration:400});
    }
  }
});

/* ── Two-finger vertical drag → live 3D tilt ─────────────────────────────
   Drag UP  = more tilt (into 3D world)
   Drag DOWN = flatten back to 2D
   Snaps to 0° or 38° on release. Overrides inline transform so it takes
   priority over the CSS class, then clears after snap so CSS class owns it.
──────────────────────────────────────────────────────────────────────── */
/* ── Two-finger vertical drag → native MapLibre pitch ─────────────────────
   Drag UP = more pitch (street-level immersion), drag DOWN = flatten to 2D.
   MapLibre setPitch is WebGL-native: no CSS, proper perspective projection.
──────────────────────────────────────────────────────────────────────── */
(()=>{
  const MAX=75, SENS=0.6;
  let g=null;

  map.getCanvas().addEventListener('touchstart',e=>{
    if(e.touches.length!==2){g=null;return;}
    const [t0,t1]=[e.touches[0],e.touches[1]];
    g={midY0:(t0.clientY+t1.clientY)/2,dist0:Math.hypot(t0.clientX-t1.clientX,t0.clientY-t1.clientY),pitch0:map.getPitch(),mode:null};
  },{passive:true});

  map.getCanvas().addEventListener('touchmove',e=>{
    if(e.touches.length!==2||!g) return;
    const [t0,t1]=[e.touches[0],e.touches[1]];
    const midY=(t0.clientY+t1.clientY)/2;
    const dist=Math.hypot(t0.clientX-t1.clientX,t0.clientY-t1.clientY);
    const dY=midY-g.midY0, dDist=Math.abs(dist-g.dist0);
    if(!g.mode&&(Math.abs(dY)>9||dDist>9))
      g.mode=Math.abs(dY)>dDist*0.85?'tilt':'pinch';
    if(g.mode!=='tilt') return;
    e.preventDefault();
    const newPitch=Math.max(0,Math.min(MAX, g.pitch0-dY*SENS));
    map.setPitch(newPitch);
    document.body.classList.toggle('nav-3d',newPitch>4);
    perspective3D=(newPitch>4);
  },{passive:false});

  function onUp(){
    if(!g||g.mode!=='tilt'){g=null;return;}
    const cur=map.getPitch(); g=null;
    if(cur>MAX*0.28){
      map.easeTo({pitch:MAX,duration:280,easing:t=>t<0.5?2*t*t:1-Math.pow(-2*t+2,2)/2});
      if(!perspective3D) enable3DView(); else document.body.classList.add('nav-3d');
      perspective3D=true;
    } else {
      map.easeTo({pitch:0,duration:280});
      if(perspective3D) disable3DView(); else document.body.classList.remove('nav-3d');
      perspective3D=false;
    }
  }
  map.getCanvas().addEventListener('touchend',onUp,{passive:true});
  map.getCanvas().addEventListener('touchcancel',onUp,{passive:true});
})();

function resetNorthUp(){
  headingUpMode=false;
  map.easeTo({bearing:0,duration:300});
}

/* ── Proximity alerts (cameras + police + schools) ──── */
/* ── Refresh street labels on any map move/pitch (rAF-throttled) ─────────── */
let _labelRaf=null;
['move','zoom','pitch','rotate'].forEach(ev=>map.on(ev,()=>{
  if(!perspective3D||navState!=='navigating') return;
  if(_labelRaf) return;
  _labelRaf=requestAnimationFrame(()=>{_labelRaf=null;refreshStreetLabels();});
}));

/* ── Street label bubbles — map.project() gives exact screen coords
   accounting for bearing, pitch and zoom in WebGL space. No manual math. ── */
function refreshStreetLabels(){
  const overlay=$$('street-labels-overlay');
  if(overlay) overlay.innerHTML='';
  if(!perspective3D||navState!=='navigating'||!maneuvers.length) return;
  const vw=window.innerWidth, vh=window.innerHeight;
  const seen=new Set();
  // Start from currentMidx+1 — current road is shown in the street pill; don't render on the car
  for(let i=currentMidx+1;i<Math.min(maneuvers.length,currentMidx+8);i++){
    const m=maneuvers[i];
    const name=(m.street_names??[])[0];
    if(!name||seen.has(name)) continue;
    seen.add(name);
    const pt=routePoints[m.begin_shape_index]; if(!pt) continue;
    // MapLibre project([lng,lat]) → {x,y} screen coords, pitch-aware
    const sp=map.project([pt[1],pt[0]]);
    if(sp.x<-60||sp.x>vw+60||sp.y<-30||sp.y>vh) continue;
    // Compute road bearing at this maneuver to offset label perpendicular (left of road)
    const ptNext=routePoints[m.begin_shape_index+1]??pt;
    const brg=(bearing(pt[0],pt[1],ptNext[0],ptNext[1])-map.getBearing()+360)%360;
    // Left-perpendicular in screen space: road bearing rotated -90°, converted to screen offsets
    const brgRad=(brg-90)*Math.PI/180;
    const OFFSET=72; // px offset from route line
    const ox=Math.sin(brgRad)*OFFSET;
    const oy=-Math.cos(brgRad)*OFFSET;
    const el=document.createElement('div');
    el.className='street-label';
    el.textContent=san(name);
    el.style.left=(sp.x+ox)+'px';
    el.style.top=(sp.y+oy)+'px';
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

/* ── Route warning flash (camera approach) ──────────────────────────────── */
let _routeWarnState=null, _routeWarnRaf=null;
function updateRouteWarn(state){
  if(state===_routeWarnState) return;
  _routeWarnState=state;
  if(_routeWarnRaf){cancelAnimationFrame(_routeWarnRaf);_routeWarnRaf=null;}
  if(!state){
    try{map.setPaintProperty('route-warn','line-opacity',0);}catch{}
    return;
  }
  const period={far:700,mid:360,near:160}[state];
  const color={far:'#f59e0b',mid:'#f97316',near:'#ef4444'}[state];
  try{map.setPaintProperty('route-warn','line-color',color);}catch{}
  let lastToggle=0,on=false;
  function tick(t){
    if(_routeWarnState!==state) return;
    if(t-lastToggle>period){
      on=!on; lastToggle=t;
      try{map.setPaintProperty('route-warn','line-opacity',on?0.85:0);}catch{}
    }
    _routeWarnRaf=requestAnimationFrame(tick);
  }
  _routeWarnRaf=requestAnimationFrame(tick);
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
      alertBar.dataset.urgency = d<150?'critical':d<300?'high':'medium';
    }
  }

  if(prefs.cameraAlerts){
    for(const cam of nearCameras){
      const d=haversine(lat,lng,cam.lat,cam.lng);
      const camId=String(cam.id);
      const wrap=cameraMarkerEls.get(camId);

      // Direction filter — skip cameras we're not heading toward
      if(cam.direction!=null&&userHeading!=null){
        const diff=Math.abs(((userHeading-cam.direction+180+360)%360)-180);
        if(diff>=90){
          if(d>600){['far','mid','near'].forEach(k=>alertedIds.delete(`c-${camId}-${k}`));}
          if(wrap){wrap.classList.remove('cam-approaching','cam-mid','cam-critical');}
          continue;
        }
      }

      // Update ripple rings on the marker
      if(wrap){
        wrap.classList.toggle('cam-approaching', d<400);
        wrap.classList.toggle('cam-mid',         d<200);
        wrap.classList.toggle('cam-critical',    d<80);
      }

      const label={speed:'Speed camera',red_light:'Red light camera',average_speed:'Average speed camera',bus_lane:'Bus lane camera'}[cam.type]??'Camera';
      const limitStr=cam.speed_limit?` · ${cam.speed_limit} km/h`:'';
      const spokenLimit=cam.speed_limit?`, ${cam.speed_limit} kilometre hour zone`:'';

      if(d<80&&!alertedIds.has(`c-${camId}-near`)){
        // Stage 3 — in capture zone
        alertedIds.add(`c-${camId}-near`);
        cameraChimeNear();
        if(prefs.haptic&&navigator.vibrate) navigator.vibrate([300,80,300,80,300]);
        showAlert({red_light:'🚦',bus_lane:'🚌'}[cam.type]??'📷',`⚠️ ${label}${limitStr} — SLOW DOWN`,fmtDist(d),false,cam.lat,cam.lng,400);
      } else if(d<200&&!alertedIds.has(`c-${camId}-mid`)){
        // Stage 2 — close approach
        alertedIds.add(`c-${camId}-mid`);
        cameraChimeMid();
        if(prefs.haptic&&navigator.vibrate) navigator.vibrate([200,60,200]);
        speak(`${label}${spokenLimit}`);
        showAlert({red_light:'🚦',bus_lane:'🚌'}[cam.type]??'📷',`${label}${limitStr}`,fmtDist(d),false,cam.lat,cam.lng,400);
      } else if(d<400&&!alertedIds.has(`c-${camId}-far`)){
        // Stage 1 — early warning
        alertedIds.add(`c-${camId}-far`);
        cameraChimeFar();
        if(prefs.haptic&&navigator.vibrate) navigator.vibrate(120);
        speak(`${label} ahead${spokenLimit}, in ${Math.round(d/50)*50} metres`);
        showAlert({red_light:'🚦',bus_lane:'🚌'}[cam.type]??'📷',`${label}${limitStr}`,fmtDist(d),false,cam.lat,cam.lng,400);
      }

      if(d>600){
        ['far','mid','near'].forEach(k=>alertedIds.delete(`c-${camId}-${k}`));
        if(wrap) wrap.classList.remove('cam-approaching','cam-mid','cam-critical');
      }
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

  // Drive route flash based on closest approaching camera
  if(prefs.cameraAlerts){
    let minD=Infinity;
    for(const cam of nearCameras){
      const d=haversine(lat,lng,cam.lat,cam.lng);
      // respect direction filter
      if(cam.direction!=null&&userHeading!=null){
        const diff=Math.abs(((userHeading-cam.direction+180+360)%360)-180);
        if(diff>=90) continue;
      }
      if(d<400) minD=Math.min(minD,d);
    }
    updateRouteWarn(minD<80?'near':minD<200?'mid':minD<400?'far':null);
  } else {
    updateRouteWarn(null);
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

/* ═══════════════════════════════════════════════
   MID-NAV SEARCH & ROUTES
═══════════════════════════════════════════════ */

// ── Search sheet ─────────────────────────────────
let nssMode='reroute';
document.querySelectorAll('.nss-tab').forEach(btn=>{
  btn.addEventListener('click',()=>{
    document.querySelectorAll('.nss-tab').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    nssMode=btn.dataset.mode;
  });
});

$$('nav-search-btn').addEventListener('click',()=>{
  $$('nav-routes-sheet').classList.add('hidden');
  $$('nav-search-sheet').classList.remove('hidden');
  $$('nss-input').focus();
});

$$('nss-close').addEventListener('click',()=>{
  $$('nav-search-sheet').classList.add('hidden');
  $$('nss-input').value='';
  $$('nss-results').innerHTML='';
});

let nssDebounce=null;
$$('nss-input').addEventListener('input',e=>{
  clearTimeout(nssDebounce);
  const q=e.target.value.trim();
  if(!q){$$('nss-results').innerHTML='';return;}
  nssDebounce=setTimeout(()=>doNavSearch(q),300);
});

async function doNavSearch(q){
  const gps=prevPos??(userMarker?{lat:userMarker.getLngLat().lat,lng:userMarker.getLngLat().lng}:null);
  const lat=gps?.lat??map.getCenter().lat, lng=gps?.lng??map.getCenter().lng;
  const el=$$('nss-results');
  el.innerHTML='<div class="nss-empty">Searching…</div>';

  const coords=parseCoords(q);
  if(coords){ renderNssResult(el,[coords],q,lat,lng); return; }

  const cat=detectCategory(q);
  let places=[];
  if(cat){
    places=await overpassSearch(cat[0],cat[1],lat,lng,6000);
    if(places.length<4) places=await overpassSearch(cat[0],cat[1],lat,lng,20000);
  } else {
    const [photon,nom,byName]=await Promise.all([
      geocode(q,lat,lng),
      geocodeNominatimAU(q,lat,lng),
      overpassNameSearch(q,lat,lng,12000),
    ]);
    places=mergeResults([[...enrichPhoton(photon,lat,lng),...enrichPhoton(nom,lat,lng),...byName]],lat,lng);
  }
  places.forEach(r=>{ r.dist=r.dist??haversine(lat,lng,r.lat,r.lng); r._score=scoreResult(r,q,lat,lng); });
  places.sort((a,b)=>b._score-a._score);
  if(!places.length){el.innerHTML='<div class="nss-empty">No results found</div>';return;}
  renderNssResult(el,places.slice(0,20),q,lat,lng);
}

function renderNssResult(el,places,q,lat,lng){
  el.innerHTML='';
  for(const r of places){
    const div=document.createElement('div');
    div.className='nss-result';
    const emoji=r._emoji??placeEmoji(r);
    const dist=fmtDist(r.dist);
    div.innerHTML=`
      <span class="nss-r-icon">${emoji}</span>
      <span class="nss-r-body">
        <div class="nss-result-name">${highlightQuery(san(r.name),q)}</div>
        ${r.sub?`<div class="nss-result-sub">${escHtml(san(r.sub))}</div>`:''}
      </span>
      ${dist?`<span class="nss-r-dist">${dist}</span>`:''}`;
    div.addEventListener('click',()=>applyNavSearch(r));
    el.appendChild(div);
  }
}

async function applyNavSearch(place){
  $$('nav-search-sheet').classList.add('hidden');
  $$('nss-input').value='';
  $$('nss-results').innerHTML='';
  const gps=prevPos??(userMarker?{lat:userMarker.getLngLat().lat,lng:userMarker.getLngLat().lng}:null);
  if(!gps){showToast('No GPS fix',2000);return;}
  if(nssMode==='reroute'){
    toPlace=place;
    await navRerouteTo(gps.lat,gps.lng,place.lat,place.lng);
  } else {
    const dest=routePoints[routePoints.length-1];
    await navRouteViaStop(gps.lat,gps.lng,place.lat,place.lng,dest[0],dest[1]);
  }
}

function _buildCostOpts(){
  const c={};
  if(routeOpts.avoidTolls){c.auto=c.auto??{};c.auto.toll_booth_penalty=9999;}
  if(routeOpts.avoidHighways){c.auto=c.auto??{};c.auto.use_highways=0.1;}
  return c;
}

async function navRerouteTo(fromLat,fromLng,toLat,toLng){
  showToast('Recalculating…',20000);
  try{
    const co=_buildCostOpts();
    const resp=await fetch('/api/route',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        locations:[{lon:fromLng,lat:fromLat},{lon:toLng,lat:toLat}],
        costing:'auto',alternates:2,
        directions_options:{units:'kilometers',language:'en-US'},
        ...(Object.keys(co).length?{costing_options:co}:{}),
      })});
    if(!resp.ok){showToast('Could not find route',3000);return;}
    const data=await resp.json();
    allRoutes=[data.trip];
    if(data.alternates) data.alternates.forEach(a=>allRoutes.push(a.trip));
    selectedRouteIdx=0;
    routeData=allRoutes[0];
    routePoints=decodePolyline6(routeData.legs[0].shape);
    maneuvers=routeData.legs[0].maneuvers;
    currentMidx=0;lastVoice=-1;
    updateRouteGeoJSON();
    map.getSource('route-traveled')?.setData(emptyFC());
    showToast('Route updated',2000);
    loadNearCameras();loadNearReports();
  }catch{showToast('Routing failed',3000);}
}

async function navRouteViaStop(fromLat,fromLng,stopLat,stopLng,destLat,destLng){
  showToast('Adding stop…',20000);
  try{
    const co=_buildCostOpts();
    const resp=await fetch('/api/route',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        locations:[{lon:fromLng,lat:fromLat},{lon:stopLng,lat:stopLat},{lon:destLng,lat:destLat}],
        costing:'auto',
        directions_options:{units:'kilometers',language:'en-US'},
        ...(Object.keys(co).length?{costing_options:co}:{}),
      })});
    if(!resp.ok){showToast('Could not add stop',3000);return;}
    const data=await resp.json();
    allRoutes=[data.trip];
    selectedRouteIdx=0;
    routeData=allRoutes[0];
    // Merge multi-leg polylines and maneuvers
    const pts=[];
    for(const leg of routeData.legs){
      const lp=decodePolyline6(leg.shape);
      if(pts.length) lp.shift();
      pts.push(...lp);
    }
    routePoints=pts;
    maneuvers=routeData.legs.flatMap(l=>l.maneuvers);
    currentMidx=0;lastVoice=-1;
    updateRouteGeoJSON();
    map.getSource('route-traveled')?.setData(emptyFC());
    showToast('Stop added',2000);
    loadNearCameras();loadNearReports();
  }catch{showToast('Could not add stop',3000);}
}

// ── Routes sheet ─────────────────────────────────
$$('nav-routes-btn').addEventListener('click',()=>{
  $$('nav-search-sheet').classList.add('hidden');
  $$('nav-routes-sheet').classList.remove('hidden');
  renderNavRoutes();
});

$$('nrs-close').addEventListener('click',()=>$$('nav-routes-sheet').classList.add('hidden'));

async function renderNavRoutes(){
  const list=$$('nrs-list');
  list.innerHTML='<div class="nss-empty">Loading…</div>';
  // Fetch fresh alternatives from current position if we only have one
  if(allRoutes.length<2&&prevPos&&routePoints.length){
    const dest=routePoints[routePoints.length-1];
    try{
      const resp=await fetch('/api/route',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
          locations:[{lon:prevPos.lng,lat:prevPos.lat},{lon:dest[1],lat:dest[0]}],
          costing:'auto',alternates:2,
          directions_options:{units:'kilometers',language:'en-US'},
        })});
      if(resp.ok){
        const data=await resp.json();
        const fresh=[data.trip];
        if(data.alternates) data.alternates.forEach(a=>fresh.push(a.trip));
        if(fresh.length>1) allRoutes=fresh;
      }
    }catch{}
  }
  list.innerHTML='';
  if(!allRoutes.length){list.innerHTML='<div class="nss-empty">No alternatives available</div>';return;}
  const labels=['Fastest','Alternative','Shortest'];
  allRoutes.forEach((route,i)=>{
    const s=route.summary;
    const mins=Math.round(s.time/60);
    const km=s.length.toFixed(1);
    const via=route.legs[0].maneuvers.find(m=>m.street_names?.length)?.street_names[0]??'';
    const div=document.createElement('div');
    div.className='nrs-route'+(i===selectedRouteIdx?' active':'');
    div.innerHTML=`<div class="nrs-route-top">
      <span class="nrs-label">${labels[i]??`Route ${i+1}`}</span>
      ${i===selectedRouteIdx?'<span class="nrs-badge">On route</span>':''}
    </div>
    <div class="nrs-meta">${mins} min · ${km} km${via?' · via '+san(via):''}</div>`;
    div.addEventListener('click',()=>{
      if(i===selectedRouteIdx){$$('nav-routes-sheet').classList.add('hidden');return;}
      selectedRouteIdx=i;
      routeData=allRoutes[i];
      routePoints=decodePolyline6(routeData.legs[0].shape);
      maneuvers=routeData.legs[0].maneuvers;
      currentMidx=0;lastVoice=-1;
      updateRouteGeoJSON();
      map.getSource('route-traveled')?.setData(emptyFC());
      $$('nav-routes-sheet').classList.add('hidden');
      showToast('Route switched',2000);
    });
    list.appendChild(div);
  });
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

/* ═══════════════════════════════════════════════
   GTA MAP COLOURS
═══════════════════════════════════════════════ */
function applyGtaColors(){
  // Override CartoDB dark-matter colours with GTA San Andreas / V palette
  const tryPaint=(layer,prop,val)=>{try{if(map.getLayer(layer)) map.setPaintProperty(layer,prop,val);}catch{}};
  // Land
  tryPaint('background','background-color','#0d1117');
  ['landcover','landuse','landuse_overlay'].forEach(l=>tryPaint(l,'fill-color','#111827'));
  tryPaint('park','fill-color','#0d2b12');
  tryPaint('national_park','fill-color','#0d2b12');
  // Water
  ['water','waterway','waterway_casing'].forEach(l=>tryPaint(l,'fill-color','#0a1628'));
  // Buildings
  tryPaint('building','fill-color','#161b2e');
  tryPaint('building','fill-outline-color','#1e2a40');
  // Roads — make them pop like GTA (warm amber for major, dim gray for minor)
  ['road_motorway','road_trunk','motorway'].forEach(l=>tryPaint(l,'line-color','#c8963c'));
  ['road_primary','road_secondary','primary','secondary'].forEach(l=>tryPaint(l,'line-color','#8a7040'));
  ['road_tertiary','road_minor','tertiary','minor_road','road'].forEach(l=>tryPaint(l,'line-color','#2a2a3a'));
  ['road_path','path','footway'].forEach(l=>tryPaint(l,'line-color','#1e1e2e'));
  // Tweak UI surface too
  document.documentElement.style.setProperty('--surface','#0d1117');
  document.documentElement.style.setProperty('--surface2','#111827');
}

/* ═══════════════════════════════════════════════
   LEADERBOARD + SCORE SUBMIT
═══════════════════════════════════════════════ */
let _navDistance=0, _prevNavPos=null;

// Track distance during navigation (hook into onGPS flow)
const _origPrevPos_hook=()=>{
  if(navState==='navigating'&&prevPos&&_prevNavPos){
    _navDistance+=haversine(prevPos.lat,prevPos.lng,_prevNavPos.lat,_prevNavPos.lng);
  }
  _prevNavPos=prevPos?{...prevPos}:null;
};

// Wire distance tracking — called at end of onGPS
function trackNavDistance(){
  if(navState!=='navigating') return;
  if(_prevNavPos&&prevPos){
    _navDistance+=haversine(prevPos.lat,prevPos.lng,_prevNavPos.lat,_prevNavPos.lng);
  }
  _prevNavPos=prevPos?{...prevPos}:null;
}

function showScoreSubmit(){
  if(gta.score<100){ endNav(); return; } // Not worth showing for tiny scores
  const modal=$$('score-modal'); if(!modal) return;
  $$('score-modal-score').textContent=fmtScore(Math.floor(gta.score))+' pts';
  $$('score-modal-stars').textContent='★'.repeat(gta.highStars)+'☆'.repeat(5-gta.highStars);
  modal.classList.remove('hidden');
}

$$('score-modal-skip').addEventListener('click',()=>{
  $$('score-modal').classList.add('hidden'); endNav();
});
$$('score-modal-submit').addEventListener('click',async()=>{
  const nick=($$('score-modal-nick').value.trim())||'Driver';
  try{
    await fetch('/api/leaderboard',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({nickname:nick,score:Math.floor(gta.score),stars_reached:gta.highStars,distance_km:_navDistance/1000})});
    showToast('Score submitted! 🏆',2500);
  }catch{ showToast('Could not submit score',2000); }
  $$('score-modal').classList.add('hidden');
  _navDistance=0; _prevNavPos=null;
  endNav();
});

// Leaderboard modal
$$('open-leaderboard-btn').addEventListener('click',async()=>{
  $$('lb-modal').classList.remove('hidden');
  const list=$$('lb-list');
  list.innerHTML='<div class="lb-loading">Loading…</div>';
  try{
    const rows=await fetch('/api/leaderboard').then(r=>r.json());
    if(!rows.length){list.innerHTML='<div class="lb-loading">No scores yet. Be the first!</div>';return;}
    const rankEmoji=(i)=>i===0?'🥇':i===1?'🥈':i===2?'🥉':`${i+1}`;
    const rankClass=(i)=>i===0?'gold':i===1?'silver':i===2?'bronze':'';
    list.innerHTML=rows.map((r,i)=>`
      <div class="lb-row">
        <span class="lb-rank ${rankClass(i)}">${rankEmoji(i)}</span>
        <span class="lb-name">${escHtml(r.nickname)}</span>
        <span class="lb-stars">${'★'.repeat(r.stars_reached??0)}</span>
        <span class="lb-score">${fmtScore(r.score)}</span>
      </div>`).join('');
  }catch{list.innerHTML='<div class="lb-loading">Could not load scores</div>';}
});
$$('lb-close').addEventListener('click',()=>$$('lb-modal').classList.add('hidden'));
$$('lb-modal').addEventListener('click',e=>{ if(e.target===$$('lb-modal')) $$('lb-modal').classList.add('hidden'); });
$$('score-modal').addEventListener('click',e=>{ if(e.target===$$('score-modal')){ $$('score-modal').classList.add('hidden'); endNav(); } });

/* ═══════════════════════════════════════════════
   COP WATCH
═══════════════════════════════════════════════ */
(()=>{
  const fab=$$('cw-fab'), sheet=$$('cw-sheet');
  let cwType='sighting', cwPhotoFile=null;

  // Open/close sheet
  fab.addEventListener('click',()=>{ sheet.classList.remove('hidden'); });
  $$('cw-close').addEventListener('click',closeCwSheet);
  function closeCwSheet(){
    sheet.classList.add('hidden');
    $$('cw-plate').value='';
    $$('cw-notes').value='';
    cwPhotoFile=null;
    $$('cw-photo-preview').classList.add('hidden');
    $$('cw-photo-btns').classList.remove('hidden');
    updateCwPtsPreview();
  }

  // Type selector
  document.querySelectorAll('.cw-type-btn').forEach(btn=>{
    btn.addEventListener('click',()=>{
      document.querySelectorAll('.cw-type-btn').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      cwType=btn.dataset.type;
    });
  });

  // Photo handling
  function handlePhotoFile(file){
    if(!file||!file.type.startsWith('image/')) return;
    // Compress client-side
    const reader=new FileReader();
    reader.onload=e=>{
      const img=new Image();
      img.onload=()=>{
        const MAX=1200, scale=Math.min(1,MAX/Math.max(img.width,img.height));
        const canvas=document.createElement('canvas');
        canvas.width=Math.round(img.width*scale);
        canvas.height=Math.round(img.height*scale);
        canvas.getContext('2d').drawImage(img,0,0,canvas.width,canvas.height);
        canvas.toBlob(blob=>{
          cwPhotoFile=new File([blob],'photo.jpg',{type:'image/jpeg'});
          $$('cw-preview-img').src=URL.createObjectURL(cwPhotoFile);
          $$('cw-photo-preview').classList.remove('hidden');
          $$('cw-photo-btns').classList.add('hidden');
          updateCwPtsPreview();
        },'image/jpeg',0.82);
      };
      img.src=e.target.result;
    };
    reader.readAsDataURL(file);
  }
  // Labels trigger inputs natively — just listen for change
  $$('cw-camera-input').addEventListener('change',e=>handlePhotoFile(e.target.files[0]));
  $$('cw-gallery-input').addEventListener('change',e=>handlePhotoFile(e.target.files[0]));
  $$('cw-photo-clear').addEventListener('click',()=>{
    cwPhotoFile=null;
    $$('cw-photo-preview').classList.add('hidden');
    $$('cw-photo-btns').classList.remove('hidden');
    $$('cw-camera-input').value='';
    $$('cw-gallery-input').value='';
    updateCwPtsPreview();
  });

  function updateCwPtsPreview(){
    const pts=150+(cwPhotoFile?200:0);
    $$('cw-pts-preview').textContent=cwPhotoFile
      ? `📸 Photo included — +${pts} pts total!`
      : `🏆 +150 pts — add a photo for +200 bonus!`;
    $$('cw-submit').textContent=`Submit Report (+${pts} pts)`;
  }

  // Submit
  $$('cw-submit').addEventListener('click',async()=>{
    const gps=prevPos??(userMarker?{lat:userMarker.getLngLat().lat,lng:userMarker.getLngLat().lng}:null);
    if(!gps){ showToast('No GPS fix — move outdoors',2000); return; }

    $$('cw-submit').disabled=true;
    $$('cw-submit').textContent='Submitting…';

    const fd=new FormData();
    fd.append('lat',String(gps.lat));
    fd.append('lng',String(gps.lng));
    fd.append('plate',($$('cw-plate').value||'').trim().toUpperCase());
    fd.append('description',($$('cw-notes').value||'').trim());
    fd.append('report_type',cwType);
    if(cwPhotoFile) fd.append('photo',cwPhotoFile,'photo.jpg');

    try{
      const resp=await fetch('/api/copwatch',{method:'POST',body:fd});
      const data=await resp.json();
      if(data.ok){
        // Award GTA points
        gta.score+=data.pts;
        renderGtaStars(gta.stars);
        showGtaPopup(`+${data.pts} WATCHDOG`,'#60a5fa',40,250);
        showToast(`Submitted! +${data.pts} pts 🎥`,2500);
        closeCwSheet();
        loadCwMarkers(); // refresh map markers
      } else {
        showToast('Submission failed',2000);
      }
    }catch{ showToast('Network error',2000); }
    $$('cw-submit').disabled=false;
    updateCwPtsPreview();
  });

  /* ── Map markers for cop watch reports ──── */
  let cwMarkers=[];
  async function loadCwMarkers(){
    if(map.getZoom()<12) return;
    const b=map.getBounds();
    const p=new URLSearchParams({swlat:b.getSouth(),swlng:b.getWest(),nelat:b.getNorth(),nelng:b.getEast()});
    try{
      const data=await fetch(`/api/copwatch?${p}`).then(r=>r.json());
      cwMarkers.forEach(m=>m.remove()); cwMarkers=[];
      for(const r of data){
        const el=document.createElement('div');
        el.className='cw-map-marker';
        el.title=r.plate||'Cop Watch';
        el.innerHTML='🎥';
        el.addEventListener('click',()=>openCwGallery());
        cwMarkers.push(new maplibregl.Marker({element:el,anchor:'center'}).setLngLat([r.lng,r.lat]).addTo(map));
      }
    }catch{}
  }
  map.on('moveend',()=>{ if(navState==='idle') loadCwMarkers(); });
  map.on('zoomend',()=>{ if(navState==='idle') loadCwMarkers(); });

  /* ── Gallery / feed ──────────────────────── */
  const gallery=$$('cw-gallery');
  function openCwGallery(plate=null){
    gallery.classList.remove('hidden');
    if(plate) $$('cw-plate-search').value=plate;
    loadCwFeed(plate||'');
  }
  function closeCwGallery(){ gallery.classList.add('hidden'); }
  $$('cw-gallery-close').addEventListener('click',closeCwGallery);
  gallery.addEventListener('click',e=>{ if(e.target===gallery) closeCwGallery(); });
  $$('open-cw-gallery-btn').addEventListener('click',()=>openCwGallery());
  $$('cw-plate-search-btn').addEventListener('click',()=>loadCwFeed($$('cw-plate-search').value.trim()));
  $$('cw-plate-search').addEventListener('keydown',e=>{ if(e.key==='Enter') loadCwFeed($$('cw-plate-search').value.trim()); });

  const TYPE_LABELS={'sighting':'👁️ Sighting','speeding':'💨 Speeding','checkpoint':'✋ Checkpoint','unmarked':'🕵️ Unmarked','misconduct':'⚠️ Misconduct'};

  async function loadCwFeed(plate=''){
    const feed=$$('cw-feed');
    feed.innerHTML='<div class="lb-loading">Loading…</div>';
    const url=plate?`/api/copwatch?plate=${encodeURIComponent(plate)}`:'/api/copwatch';
    try{
      const rows=await fetch(url).then(r=>r.json());
      if(!rows.length){ feed.innerHTML='<div class="lb-loading">No reports yet. Be the first!</div>'; return; }
      feed.innerHTML='';
      for(const r of rows){
        const ago=Math.round((Date.now()-r.created_at)/60000);
        const agoStr=ago<60?`${ago}m ago`:ago<1440?`${Math.round(ago/60)}h ago`:`${Math.round(ago/1440)}d ago`;
        const div=document.createElement('div');
        div.className='cw-entry';
        div.innerHTML=`
          <div class="cw-entry-top">
            ${r.plate?`<span class="cw-entry-plate">${escHtml(r.plate)}</span>`:'<span class="cw-entry-plate" style="opacity:.5">No plate</span>'}
            <span class="cw-entry-type">${TYPE_LABELS[r.report_type]??r.report_type}</span>
            <span class="cw-entry-time">${agoStr}</span>
          </div>
          ${r.photo_key?`<img class="cw-entry-photo" src="/api/copwatch/photo/${r.id}.jpg" loading="lazy" alt="Cop photo"/>`:''}
          ${r.description?`<div class="cw-entry-desc">${escHtml(r.description)}</div>`:''}
          <div class="cw-entry-footer">
            <button class="cw-confirm-btn" data-id="${r.id}">👍 Confirm</button>
            <span class="cw-confirms">${r.confirms} confirmations</span>
          </div>`;
        feed.appendChild(div);
      }
      // Wire confirm buttons
      feed.querySelectorAll('.cw-confirm-btn').forEach(btn=>{
        btn.addEventListener('click',async()=>{
          try{
            const res=await fetch(`/api/copwatch/${btn.dataset.id}/confirm`,{method:'POST'});
            const d=await res.json();
            if(d.ok){
              gta.score+=d.pts; renderGtaStars(gta.stars);
              showGtaPopup('+50 CONFIRMED','#60a5fa',80,300);
              btn.textContent='✅ Confirmed';
              btn.disabled=true;
              const c=btn.nextElementSibling;
              if(c) c.textContent=(parseInt(c.textContent)+1)+' confirmations';
            }
          }catch{}
        });
      });
    }catch{ feed.innerHTML='<div class="lb-loading">Could not load feed</div>'; }
  }
})();
