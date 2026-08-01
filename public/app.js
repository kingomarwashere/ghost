/* ═══════════════════════════════════════════════
   PWA — register service worker
═══════════════════════════════════════════════ */
if ('serviceWorker' in navigator) {
  // Reload once when a freshly-installed SW takes control, so an already-open
  // home-screen app swaps to the new version without a manual refresh. Guard
  // against the first-install controllerchange (no prior controller) + loops.
  let _swRefreshing = false;
  const _hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (_swRefreshing || !_hadController) return;
    _swRefreshing = true;
    window.location.reload();
  });
  // updateViaCache:'none' → the browser never serves sw.js itself from HTTP cache,
  // so update checks always see the freshly deployed worker.
  navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).then(reg => {
    reg.update();
    // Check for a new deploy whenever the app regains focus + hourly while open.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') reg.update();
    });
    setInterval(() => reg.update(), 60 * 60 * 1000);
  }).catch(()=>{});
}

/* ═══════════════════════════════════════════════
   UTILITY — $$ must be defined first
═══════════════════════════════════════════════ */
function $$(id){return document.getElementById(id);}

/* ═══════════════════════════════════════════════
   SETTINGS — persisted to localStorage
═══════════════════════════════════════════════ */
const PREF_KEY = 'radar_prefs';
const DEFAULT_PREFS = { voice:true, cameraAlerts:true, policeAlerts:true, haptic:true, unit:'kmh', mapStyle:'voyager', lighting:'auto', styleOverride:false, avoidTolls:true, accelTimer:false, accelRange:'0-100' };
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
// Inside the Middle East region we override these with our own Israel-free vector
// tiles; see setupMideastTiles().
const VECTOR_STYLES = {
  dark:    'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
  light:   'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
  voyager: 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json',
  gta:     'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json', // base = dark, then recoloured
  minecraft:'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json',    // base = bright, then blockified
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
  // More towns built on/near depopulated Palestinian villages
  'Yavne':             'Yibna',       'Yavneh':         'Yibna',
  'Gedera':            'Qatra',       'Kfar Saba':      'Kafr Saba',
  'Rosh HaAyin':       'Ras al-Ayn',  'Rosh Ha\'ayin':  'Ras al-Ayn',
  'Or Yehuda':         'Kafr Ana',    'Yehud':          'Al-Yahudiyya',
  'Yehud-Monosson':    'Al-Yahudiyya','Rosh Pina':      'Al-Ja\'una',
  'Rosh Pinna':        'Al-Ja\'una',  'Migdal HaEmek':  'Al-Mujaydil',
  'Tirat Karmel':      'Al-Tira',     'Zikhron Yaakov': 'Zammarin',
  'Zichron Yaakov':    'Zammarin',    'Sderot':         'Najd',
  'Kiryat Ata':        'Kafr Ata',    'Bnei Brak':      'Ibn Ibraq',
  'Bene Beraq':        'Ibn Ibraq',   'Beit Dagan':     'Bayt Dajan',
  'Kiryat Motzkin':    'Al-Sumayriyya','Yesud HaMaala':  'Al-Zuq al-Tahtani',
  // Regions
  'Negev':             'An-Naqab',    'Galilee':        'Al-Jalil',
  'Judea':             'Al-Quds area','Samaria':        'As-Samariyya',
  'Golan Heights':     'Al-Jawlan',   'West Bank':      'West Bank',
};

// ─────────────────────────────────────────────────────────────────────────
//  Self-hosted Middle East basemap — Israel removed at the DATA layer.
//  We serve our OWN vector tiles for this region (built from OSM with the Israel
//  country entity deleted → Palestine, and Israeli place names rewritten to the
//  Palestinian names in PAL_NAMES above; Hebrew labels stripped). Inside the
//  region we suppress CartoDB's own place labels & admin boundaries so nothing
//  bleeds through, and clone CartoDB's place-label layers onto our source so the
//  region stays visually identical per theme — just with Israel-free data.
//  Everything outside the region still renders straight from CartoDB.
const MIDEAST_REGION = { type:'Polygon', coordinates:[[
  [34.6756,33.4544],[35.1042,33.0979],[35.2114,33.1025],[35.3159,33.1127],
  [35.3574,33.0611],[35.4295,33.0717],[35.446,33.0937],[35.519,33.1246],
  [35.5373,33.1965],[35.5305,33.2189],[35.5416,33.2555],[35.5653,33.2935],
  [35.6126,33.2792],[35.6743,33.3063],[35.7079,33.3427],[35.7536,33.3509],
  [35.8151,33.3392],[35.9153,32.9406],[35.8083,32.772],[35.7784,32.7245],
  [35.5949,32.6283],[35.5729,32.3654],[35.5946,32.2186],[35.5545,32.029],
  [35.5722,31.7541],[35.4877,31.4195],[35.4209,31.2512],[35.4794,31.1783],
  [35.4277,30.9517],[35.3321,30.7711],[35.2071,30.5331],[35.172,30.112],
  [35.0751,29.8371],[35.0234,29.6457],[34.9544,29.4641],[34.9163,29.4396],
  [34.8747,29.5355],[34.6967,30.1071],[34.5242,30.4091],[34.3978,30.8667],
  [34.2362,31.2922],[34.2121,31.3208],[33.9999,31.4521],[34.6756,33.4544]
]] };
// ?v bumps whenever me.pmtiles is rebuilt, to bust the 24h browser cache.
const MIDEAST_PMTILES = 'pmtiles://' + location.origin + '/tiles/me.pmtiles?v=2';

// Register the pmtiles:// protocol once so MapLibre can read byte ranges from R2.
if(window.pmtiles && !window._pmtilesReg){
  try{ maplibregl.addProtocol('pmtiles', new pmtiles.Protocol().tile); window._pmtilesReg = true; }catch(_){}
}

// CartoDB layers use MapLibre's LEGACY filter syntax (["==","class","town"]).
// Combining them with the `within` expression fails validation ('within'/'!' are
// not legacy operators), so convert legacy → expression first.
function toExpr(f){
  if(!Array.isArray(f)) return f;
  const op = f[0];
  if(op==='all' || op==='any') return [op, ...f.slice(1).map(toExpr)];
  if(op==='none')              return ['!', ['any', ...f.slice(1).map(toExpr)]];
  const CMP = {'==':1,'!=':1,'>':1,'>=':1,'<':1,'<=':1};
  const getter = k => k==='$type' ? ['geometry-type'] : k==='$id' ? ['id'] : ['get', k];
  if(CMP[op]) return Array.isArray(f[1]) ? f : [op, getter(f[1]), f[2]];
  if(op==='in')  return Array.isArray(f[1]) ? f : ['in', getter(f[1]), ['literal', f.slice(2)]];
  if(op==='!in') return ['!', ['in', getter(f[1]), ['literal', f.slice(2)]]];
  if(op==='has')  return ['has', f[1]];
  if(op==='!has') return ['!', ['has', f[1]]];
  return f;                                            // already an expression
}

function setupMideastTiles(){
  // Runs on the map 'idle' event (see wiring below). We deliberately DON'T run this
  // from 'style.load': during that event the style isn't ready and addSource/addLayer
  // silently no-op (neither throw nor persist). Idempotent + self-healing: a theme
  // swap (setStyle) wipes our clones — sometimes WITHOUT firing style.load — so we
  // detect their absence here and re-apply. Fast path when already present.
  if(map.getStyle().layers.some(l => l.id.startsWith('me_'))) return;

  try{
    if(!map.getSource('me')) map.addSource('me', { type:'vector', url: MIDEAST_PMTILES });
  }catch(_){}

  const inRegion    = ['within', MIDEAST_REGION];
  const notInRegion = ['!', ['within', MIDEAST_REGION]];

  map.getStyle().layers.forEach(l => {
    if(l.id.startsWith('me_')) return;                 // never touch our own clones
    const sl = l['source-layer'];
    const isPlaceLabel = l.type==='symbol' && sl==='place';
    const isSoftLabel  = l.type==='symbol' && (sl==='poi' || sl==='water_name');
    const isBoundary   = l.type==='line'   && sl==='boundary';
    if(!(isPlaceLabel || isSoftLabel || isBoundary)) return;

    const base = l.filter ? toExpr(l.filter) : null;

    // Clone CartoDB's place layers onto our Israel-free source (same style, our data).
    // Our tiles cover a wider area than the region, so clip the clones to the region
    // too — outside it, CartoDB still provides the labels.
    if(isPlaceLabel){
      const cloneId = 'me_' + l.id;
      if(!map.getLayer(cloneId)){
        const def = JSON.parse(JSON.stringify(l));
        def.id = cloneId; def.source = 'me';           // keeps source-layer 'place'
        def.filter = base ? ['all', base, inRegion] : inRegion;
        // Force the romanized name so Hebrew script never renders: renamed cities
        // carry the Palestinian name in name:latin/name_en (Yafa, Al-Quds …); any
        // town we didn't rename shows its transliteration, never עברית.
        def.layout = def.layout || {};
        def.layout['text-field'] = ['coalesce',['get','name:latin'],['get','name_en'],['get','name']];
        try{ map.addLayer(def); }catch(_){}
      }
    }
    // Suppress CartoDB's own labels/boundaries inside the region. Guard against
    // double-wrapping if the pristine filter was already suppressed.
    if(!JSON.stringify(l.filter||'').includes('within')){
      const filtered = base ? ['all', base, notInRegion] : notInRegion;
      try{ map.setFilter(l.id, filtered); }catch(_){}
    }
  });
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
  preserveDrawingBuffer:true, // needed for in-app recording (captureStream) + thumbnails
});
map.addControl(new maplibregl.NavigationControl({showCompass:false}), 'bottom-left');
// Expose map to the 3D car module (car3d.js, loaded as a deferred ES module)
window.ghostMap = map;
window.maplibregl = maplibregl;
window.dispatchEvent(new Event('ghostmap-ready'));

// On every style.load (initial + setStyle calls): fix labels, add custom layers
let _mapReady = false;
// Re-apply the Middle East tiles whenever the map next goes idle (style fully ready).
// setupMideastTiles is self-healing: it re-adds its layers if a style swap wiped them.
map.on('idle', setupMideastTiles);
map.on('style.load', () => {
  setupMapLayers();
  if(prefs.mapStyle==='gta'){ applyGtaColors(); addGtaPoiLayer(); }
  else if(prefs.mapStyle==='minecraft'){ applyMinecraftColors(); }
  // setupMapLayers re-creates the heatmap layer with visibility:'none' on every
  // style swap — re-apply the on-by-default state so it survives style changes.
  if(heatmapVisible && map.getLayer('heatmap-layer')) map.setLayoutProperty('heatmap-layer','visibility','visible');
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
const CUSTOM_LAYERS = new Set(['route-main','route-casing','route-traveled','route-alts','route-traffic','route-warn','heatmap-layer','3d-buildings','gta-poi']);

// Route line widths as zoom-interpolated expressions so the ribbon stays a
// consistent, readable thickness from overview zoom down to the ~18-20 nav zoom
// (a fixed pixel width looked fat when zoomed out and vanished on tilted roads).
const RW_CASING = ['interpolate',['linear'],['zoom'], 10,7, 14,11, 17,16, 19,21, 21,29];
const RW_MAIN   = ['interpolate',['linear'],['zoom'], 10,4, 14,6.5, 17,10.5, 19,14.5, 21,20];
const RW_TRAFFIC= ['interpolate',['linear'],['zoom'], 10,3, 14,5, 17,8, 19,11, 21,15];
const RW_WARN   = ['interpolate',['linear'],['zoom'], 10,6, 14,10, 17,15, 19,20, 21,27];

function setupMapLayers(){
  // Route line sources
  ['route-main','route-traveled','route-alts','route-traffic'].forEach(id=>{
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
  // Dark casing UNDER the main route so the bright ribbon reads on light-grey
  // roads AND dark backgrounds (this is why the route "vanished" on some roads).
  if(!map.getLayer('route-casing'))
    map.addLayer({id:'route-casing',type:'line',source:'route-main',
      layout:{'line-cap':'round','line-join':'round','visibility':'visible'},
      paint:{'line-color':'#05070f','line-width':RW_CASING,'line-opacity':0.95}});
  if(!map.getLayer('route-main'))
    map.addLayer({id:'route-main',type:'line',source:'route-main',
      layout:{'line-cap':'round','line-join':'round','visibility':'visible'},
      paint:{'line-color':'#ffd700','line-width':RW_MAIN,'line-opacity':1}});
  // Traffic overlay — congested stretches drawn on top of the gold route.
  // Narrower than route-main so the gold shows as an outline; colour by severity.
  if(!map.getLayer('route-traffic'))
    map.addLayer({id:'route-traffic',type:'line',source:'route-traffic',
      layout:{'line-cap':'round','line-join':'round','visibility':'visible'},
      paint:{'line-color':['match',['get','sev'],'heavy','#dc2626','slow','#f97316','#dc2626'],
             'line-width':RW_TRAFFIC,'line-opacity':0.96}});
  // Warning flash overlay — same source as route-main, drawn on top
  if(!map.getLayer('route-warn'))
    map.addLayer({id:'route-warn',type:'line',source:'route-main',
      layout:{'line-cap':'round','line-join':'round','visibility':'visible'},
      paint:{'line-color':'#f59e0b','line-width':RW_WARN,'line-opacity':0}});
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
  // Keep the 3D car above all route lines — move it to top of the layer stack
  try{ if(map.getLayer('player-car-3d')) map.moveLayer('player-car-3d'); }catch(_){}
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
  // Themed styles (gta/minecraft) reuse another style's base URL. A plain
  // setStyle(sameURL) diffs to a no-op and never fires style.load, so the
  // recolour never runs. diff:false forces a full replacement → style.load fires.
  const themed = style==='gta'||style==='minecraft';
  const prevThemed = prefs.mapStyle==='gta'||prefs.mapStyle==='minecraft';
  map.setStyle(s, (themed||prevThemed) ? {diff:false} : undefined); // clean reload entering/leaving a theme
  prefs.mapStyle=style; savePrefs();
  if(!isAuto){ prefs.styleOverride=true; savePrefs(); }
  document.querySelectorAll('.style-btn').forEach(b=>b.classList.toggle('active',b.dataset.style===style));
  if(themed){ // belt & suspenders in case idle settles after style.load
    map.once('idle',()=>{ if(prefs.mapStyle==='gta'){applyGtaColors();addGtaPoiLayer();} else if(prefs.mapStyle==='minecraft'){applyMinecraftColors();} });
  }
}
// initial setTile handled by map construction style — just sync UI
document.querySelectorAll('.style-btn').forEach(b=>b.classList.toggle('active',b.dataset.style===prefs.mapStyle));

/* ═══════════════════════════════════════════════
   MARKER ARRAYS (replaces Leaflet cluster groups)
═══════════════════════════════════════════════ */
let cameraMarkers=[];
const cameraMarkerEls=new Map(); // camId → wrapper DOM element for ripple updates
function clearMarkers(arr){ arr.forEach(m=>m.remove()); arr.length=0; }
// Report markers are diffed (not torn down) each refresh — keyed by report id →
// {marker, sig}. sig captures the fields that affect the rendered marker/popup,
// so an unchanged report keeps its existing DOM node instead of being rebuilt.
const reportMarkerById=new Map();
function clearReportMarkers(){ for(const e of reportMarkerById.values()) e.marker.remove(); reportMarkerById.clear(); }
const REPORT_LABELS={police:'🐷 5-0',speed_trap:'📷 Speed trap',accident:'💥 Crash',hazard:'💀 Hazard',traffic:'🚗 Traffic',closure:'🚧 Closure',roadwork:'👷 Roadwork',weather:'🌧️ Weather',blocked_lane:'🦺 Blocked lane'};
// Popup HTML for a report — recomputed each time so the "Xm ago" age and vote
// counts are always current (not frozen at marker-creation time).
function reportPopupHtml(r){
  const label=REPORT_LABELS[r.type]??r.type;
  const age=Math.round((Date.now()-r.created_at)/60000);
  const ageStr=age<60?`${age}m ago`:`${Math.round(age/60)}h ago`;
  return `<strong>${label}</strong>${r.description?`<p>${escHtml(r.description)}</p>`:''}<p>${ageStr} · ✅ ${r.confirms} 👎 ${r.denies}</p><div class="popup-actions"><button class="popup-confirm" onclick="vote('${r.id}','confirm')">✅ Still there</button><button class="popup-deny" onclick="vote('${r.id}','deny')">👎 Gone</button></div>`;
}

/* ── Heatmap ──────────────────────────────── */
let heatmapVisible=true;  // report heatmap ON by default
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
// ── Pig cop SVG — used for all police visual icons ───────────────────────────
const PIG_COP_SVG = (w=30,h=30) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" width="${w}" height="${h}">
  <rect x="6" y="11" width="28" height="3.5" rx="1.5" fill="#0a0a2a"/>
  <rect x="11" y="4" width="18" height="8" rx="2.5" fill="#1c1c4a"/>
  <rect x="11" y="10" width="18" height="2" rx="0.5" fill="#ffd700"/>
  <ellipse cx="8.5" cy="21" rx="4.5" ry="5.5" fill="#f9a8c0"/>
  <ellipse cx="31.5" cy="21" rx="4.5" ry="5.5" fill="#f9a8c0"/>
  <ellipse cx="8.5" cy="21" rx="2.8" ry="3.5" fill="#f07090"/>
  <ellipse cx="31.5" cy="21" rx="2.8" ry="3.5" fill="#f07090"/>
  <circle cx="20" cy="24" r="13.5" fill="#f9a8c0"/>
  <circle cx="14.5" cy="21" r="3.2" fill="white"/>
  <circle cx="25.5" cy="21" r="3.2" fill="white"/>
  <circle cx="14.5" cy="21.5" r="1.9" fill="#111"/>
  <circle cx="25.5" cy="21.5" r="1.9" fill="#111"/>
  <circle cx="15.1" cy="20.8" r="0.65" fill="white"/>
  <circle cx="26.1" cy="20.8" r="0.65" fill="white"/>
  <ellipse cx="20" cy="29" rx="7.5" ry="5.5" fill="#f07090"/>
  <ellipse cx="17.2" cy="29.5" rx="2" ry="2.2" fill="#c0405a"/>
  <ellipse cx="22.8" cy="29.5" rx="2" ry="2.2" fill="#c0405a"/>
  <path d="M8,35 C8,38.5 13,40 20,40 C27,40 32,38.5 32,35 L30,31 C27,33 13,33 10,31Z" fill="#1c1c4a"/>
  <circle cx="20" cy="36.5" r="2.5" fill="#ffd700"/>
  <polygon points="20,34.8 20.4,35.8 21.5,35.8 20.7,36.5 21,37.5 20,36.8 19,37.5 19.3,36.5 18.5,35.8 19.6,35.8" fill="#0a0a2a"/>
</svg>`;

function makeEmojiIcon(emoji, bg='#1e3a5f', size=42){
  const html=`<div style="width:${size}px;height:${size}px;border-radius:13px;background:${bg};display:flex;align-items:center;justify-content:center;box-shadow:0 4px 14px rgba(0,0,0,.45),inset 0 1px 0 rgba(255,255,255,.18);cursor:pointer;font-size:24px;line-height:1;user-select:none">${emoji}</div>`;
  return { el:()=>{ const d=document.createElement('div'); d.innerHTML=html; return d.firstChild; } };
}

// GTA-style police marker: circle with alternating blue/red ring flash
function makePoliceFlashIcon(){
  return { el:()=>{
    const d=document.createElement('div');
    d.className='gta-cop-marker';
    d.innerHTML=`<div class="gta-cop-inner">${PIG_COP_SVG(24,24)}</div>`;
    return d;
  }};
}

// Custom SVG marker badge — dark rounded tile, coloured glow ring, white glyph.
function makeSvgIcon(glyph, accent, size=42){
  const html=`<div style="width:${size}px;height:${size}px;border-radius:14px;`+
    `background:radial-gradient(120% 120% at 30% 20%,#232634 0%,#0d0f16 100%);border:1.6px solid ${accent};`+
    `display:flex;align-items:center;justify-content:center;`+
    `box-shadow:0 5px 16px rgba(0,0,0,.55),0 0 14px ${accent}66,inset 0 1px 0 rgba(255,255,255,.14);`+
    `cursor:pointer;user-select:none"><svg viewBox="0 0 24 24" width="26" height="26" fill="none">${glyph}</svg></div>`;
  return { el:()=>{ const d=document.createElement('div'); d.innerHTML=html; return d.firstChild; } };
}
const MK_A={speed:'#22d3ee',red_light:'#ef4444',speed_trap:'#f59e0b',accident:'#ef4444',hazard:'#fbbf24',
  roadwork:'#f97316',traffic:'#f59e0b',closure:'#ef4444',weather:'#38bdf8',blocked_lane:'#fb923c',
  average_speed:'#a78bfa',bus_lane:'#f59e0b'};
const MK_G={
  speed:`<rect x="2.5" y="8.5" width="12" height="8.5" rx="1.8" fill="#fff"/><circle cx="8.5" cy="12.7" r="2.7" fill="#0b0b12"/><circle cx="8.5" cy="12.7" r="1.1" fill="${MK_A.speed}"/><rect x="14.6" y="10" width="4" height="5.5" rx="1" fill="#fff"/><path d="M18 3.4 l-3 4.4 h2.3 l-2.7 4" stroke="#fbbf24" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>`,
  red_light:`<rect x="7.5" y="2.8" width="9" height="18.4" rx="3.4" fill="#fff"/><circle cx="12" cy="7.4" r="2.2" fill="${MK_A.red_light}"/><circle cx="12" cy="12" r="2.2" fill="#3b3b46"/><circle cx="12" cy="16.6" r="2.2" fill="#3b3b46"/><path d="M4.6 7.4h2.6M4.6 16.6h2.6M16.8 7.4h2.6M16.8 16.6h2.6" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/>`,
  speed_trap:`<rect x="3" y="9" width="10.5" height="8" rx="1.7" fill="#fff"/><circle cx="8" cy="13" r="2.4" fill="#0b0b12"/><circle cx="8" cy="13" r="1" fill="${MK_A.speed_trap}"/><path d="M16 8 a6 6 0 0 1 0 8 M18.4 6 a9 9 0 0 1 0 12" stroke="${MK_A.speed_trap}" stroke-width="1.7" stroke-linecap="round"/>`,
  accident:`<path d="M12 2 l1.9 5.2 5.4-1.6 -3.1 4.7 4.6 3.3 -5.7 .6 .9 5.6 -4.5-3.6 -4.5 3.6 .9-5.6 -5.7-.6 4.6-3.3 -3.1-4.7 5.4 1.6z" fill="${MK_A.accident}" stroke="#fff" stroke-width=".6" stroke-linejoin="round"/><path d="M11 8.5h2l-.4 4.2h-1.2z" fill="#fff"/><circle cx="12" cy="15" r="1" fill="#fff"/>`,
  hazard:`<path d="M12 3.6 L21 19 H3 Z" fill="${MK_A.hazard}" stroke="#0b0b12" stroke-width="1.1" stroke-linejoin="round"/><rect x="10.9" y="8.6" width="2.2" height="5.4" rx="1.1" fill="#0b0b12"/><circle cx="12" cy="16.4" r="1.25" fill="#0b0b12"/>`,
  roadwork:`<path d="M4.5 16.5 a7.5 7.5 0 0 1 15 0 z" fill="${MK_A.roadwork}"/><rect x="2.3" y="16.3" width="19.4" height="2.8" rx="1.4" fill="#fff"/><rect x="10.9" y="6.2" width="2.2" height="4.6" rx="1.1" fill="#fff"/>`,
  traffic:`<rect x="6" y="3.6" width="12" height="4.9" rx="2.2" fill="${MK_A.traffic}"/><rect x="6" y="9.6" width="12" height="4.9" rx="2.2" fill="#fff"/><rect x="6" y="15.6" width="12" height="4.9" rx="2.2" fill="${MK_A.traffic}"/>`,
  closure:`<rect x="2.5" y="8.5" width="19" height="6.5" rx="1.2" fill="#fff"/><path d="M4 15 L8 8.5 M9 15 L13 8.5 M14 15 L18 8.5" stroke="${MK_A.closure}" stroke-width="2.4"/><rect x="4.2" y="14.5" width="2.1" height="5.5" rx=".6" fill="#fff"/><rect x="17.7" y="14.5" width="2.1" height="5.5" rx=".6" fill="#fff"/>`,
  weather:`<path d="M7.5 14.5 a3.7 3.7 0 0 1 .4-7.4 5 5 0 0 1 9.4 1.4 A3.1 3.1 0 0 1 16.5 14.5 z" fill="#fff"/><path d="M8.5 16.5l-1 3M12 16.5l-1 3M15.5 16.5l-1 3" stroke="${MK_A.weather}" stroke-width="1.7" stroke-linecap="round"/>`,
  blocked_lane:`<path d="M12 3.5 L17.5 19 H6.5 Z" fill="${MK_A.blocked_lane}"/><path d="M9.3 12h5.4M8.2 15.5h7.6" stroke="#fff" stroke-width="1.7" stroke-linecap="round"/><rect x="4.5" y="19" width="15" height="2.4" rx="1.2" fill="#fff"/>`,
  average_speed:`<circle cx="5.5" cy="12" r="2.8" fill="#fff"/><circle cx="18.5" cy="12" r="2.8" fill="#fff"/><path d="M8.5 12 h7" stroke="${MK_A.average_speed}" stroke-width="1.8" stroke-dasharray="2 2" stroke-linecap="round"/><circle cx="5.5" cy="12" r="1.1" fill="${MK_A.average_speed}"/><circle cx="18.5" cy="12" r="1.1" fill="${MK_A.average_speed}"/>`,
  bus_lane:`<rect x="4.5" y="3.5" width="15" height="14" rx="2.6" fill="#fff"/><rect x="6.5" y="6" width="11" height="4.5" rx="1.2" fill="#0b0b12"/><circle cx="8" cy="13.5" r="1.4" fill="${MK_A.bus_lane}"/><circle cx="16" cy="13.5" r="1.4" fill="${MK_A.bus_lane}"/><rect x="6.5" y="17" width="2.6" height="3" rx=".8" fill="#fff"/><rect x="14.9" y="17" width="2.6" height="3" rx=".8" fill="#fff"/>`,
};
const svgIcon=(k)=>makeSvgIcon(MK_G[k], MK_A[k]);
const ICONS = {
  police:        makePoliceFlashIcon(), // keep the signature pig/flash cop marker
  speed_trap:    svgIcon('speed_trap'),
  accident:      svgIcon('accident'),
  hazard:        svgIcon('hazard'),
  speed:         svgIcon('speed'),
  bus_lane:      svgIcon('bus_lane'),
  red_light:     svgIcon('red_light'),
  average_speed: svgIcon('average_speed'),
  traffic:       svgIcon('traffic'),
  closure:       svgIcon('closure'),
  roadwork:      svgIcon('roadwork'),
  weather:       svgIcon('weather'),
  blocked_lane:  svgIcon('blocked_lane'),
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
// haversine/bearing/toGL/decodePolyline6/nearestOnRoute now live in the shared
// core (public/lib/geo.js, unit-tested) and are loaded before this script.
const haversine = GhostCore.haversine;
const bearing   = GhostCore.bearing;
const toKmh = ms => Math.round(ms * 3.6);
const toMph = ms => Math.round(ms * 2.237);
function fmtSpeed(ms) {
  const v = prefs.unit==='mph' ? toMph(ms) : toKmh(ms);
  return `${v}<small>${prefs.unit==='mph'?'mph':'km/h'}</small>`;
}
function fmtDist(m) { return m<1000?`${Math.round(m/10)*10}m`:`${(m/1000).toFixed(1)}km`; }
function fmtTime(s) { const m=Math.round(s/60); return m<60?`${m} min`:`${Math.floor(m/60)}h ${m%60}m`; }
// routePoints are [lat,lng] arrays; MapLibre/GeoJSON needs [lng,lat]
const toGL = GhostCore.toGL;
function fmtETA(s)  { return new Date(Date.now()+s*1000).toLocaleTimeString([],{hour:'numeric',minute:'2-digit',hour12:true}); }
function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }

const decodePolyline6 = GhostCore.decodePolyline6;
const nearestOnRoute  = GhostCore.nearestOnRoute;

// Forward-biased route matcher for live nav. Searches a window ahead of the
// current cursor so a route that loops near itself (interchanges/ramps) doesn't
// snap our position far ahead. Only falls back to a global scan when the car is
// genuinely off the windowed route (post-reroute or a big GPS jump).
// Thin wrappers: pure logic lives in public/lib/route-match.js (unit-tested);
// these thread the live module state (routePoints / _lastRouteIdx / routeCumDist).
function matchRouteIdx(lat,lng){ return GhostCore.matchRouteIdx(routePoints,_lastRouteIdx,lat,lng); }

/* ── Route arc-length (drives GPS-loss dead reckoning) ──────────────────────
   routeCumDist[i] = metres travelled along the polyline to reach routePoints[i].
   Rebuilt whenever the active route changes (startNav / reroute). */
let routeCumDist=[];
function buildRouteCumDist(){ routeCumDist=GhostCore.buildRouteCumDist(routePoints); }
// Ground-truth position → metres along the route (nearest vertex + partial segment)
function posToProgressM(idx,lat,lng){ return GhostCore.posToProgressM(routePoints,routeCumDist,idx,lat,lng); }
// Metres along the route → {lat,lng,idx,hdg} by walking the cumulative table
function progressMToPos(m){ return GhostCore.progressMToPos(routePoints,routeCumDist,m); }

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
async function overpassNameSearch(q, lat, lng, radius=8000, signal, timeoutMs=9000){
  // Search across all common POI-holding tag keys
  // Escape regex metacharacters — q is interpolated into an Overpass regex, so a
  // bare "(", "+", "[" etc. (e.g. "fish (co", "C++") would make an invalid query
  // that silently returns nothing.
  const rx=q.replace(/[\\^$.*+?()[\]{}|]/g,'\\$&').replace(/"/g,'');
  const filter=`[name~"${rx}",i][~"^(amenity|shop|tourism|leisure|office|brand)$"~"."]`;
  const results=await overpassSearch(filter,'📍',lat,lng,radius,signal,timeoutMs);
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
      const hn=a.house_number, road=a.road;
      const raw=hn&&road?`${hn} ${road}`:(r.name||road||a.suburb||r.display_name?.split(',')[0]||'Place');
      const parts=[
        !hn&&road&&!raw.includes(road)?road:null,
        a.suburb||a.quarter||a.village||a.town||a.city_district,
        a.state_district||a.state,
      ].filter(Boolean);
      return {
        lat:parseFloat(r.lat), lng:parseFloat(r.lon),
        name:san(raw), sub:san(parts.join(', ')),
        osmKey:r.category||'', osmVal:r.type||'', house:!!hn,
        importance:hn?0.85:(r.importance??0.5),
      };
    });
  }catch{return [];}
}

// ── Unified geocoder — one fast, edge-cached request (Photon+Nominatim merged
//    server-side). Replaces the client awaiting 3 slow sources in parallel. ────
async function unifiedSearch(q, lat, lng, signal){
  const params=new URLSearchParams({ q, lat:String(lat??''), lon:String(lng??'') });
  try{
    const data=await fetch(`/api/search?${params}`,{signal}).then(r=>r.json());
    return Array.isArray(data)?data:[];
  }catch{ return []; }
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
// Ranking rewritten & unit-tested in public/lib/address.js. When the query leads
// with a house number it switches to "address mode": text + exact house-number
// match dominate and proximity is only a faint tiebreak, so the right building a
// few km away beats a bus stop next to you. This wrapper supplies live history.
function scoreResult(r, q, lat, lng){
  return GhostCore.scoreResult(r, q, {
    lat, lng,
    isFav: isFav(r.name),
    isRecent: getRecent().some(x=>x.name===r.name),
  });
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
  police:              ['[amenity=police]','🐷'],
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
async function overpassSearch(filter, emoji, lat, lng, radius=6000, signal, timeoutMs=9000){
  const q=`[out:json][timeout:8];(node${filter}(around:${radius},${lat},${lng});way${filter}(around:${radius},${lat},${lng}););out center 25;`;
  // Hard-cap Overpass (it can hang for 10s+) and honour the caller's abort so a
  // superseded search stops fetching. Either firing returns [] gracefully.
  const ctrl=new AbortController();
  const to=setTimeout(()=>ctrl.abort(),timeoutMs);
  if(signal){ if(signal.aborted) ctrl.abort(); else signal.addEventListener('abort',()=>ctrl.abort(),{once:true}); }
  try{
    const resp=await fetch('https://overpass-api.de/api/interpreter',{method:'POST',body:'data='+encodeURIComponent(q),signal:ctrl.signal});
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
  finally{ clearTimeout(to); }
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
      const hn = p.housenumber;
      const name = hn && (p.street || p.name) ? `${hn} ${p.street || p.name}`.trim()
                 : (p.name || p.street || p.city || p.county || 'Place');
      return {
        lat, lng,
        name: san(name),
        sub:  san([hn ? null : p.street,
                   p.suburb || p.district || p.town || p.village || p.city,
                   p.state].filter(Boolean).join(', ')),
        osmKey: p.osm_key ?? '',
        osmVal: p.osm_value ?? '',
        house: !!hn,
      };
    });
  } catch { return []; }
}

// Photon uses osm_key/osm_value instead of Nominatim's category/type
function placeEmoji(r) {
  const k = r.osmKey||r.category||'', v = r.osmVal||r.type||'';
  if(r.house) return '🏠';
  if(k==='railway') return v==='tram_stop'?'🚋':'🚆';
  if(k==='public_transport') return '🚉';
  if(k==='aeroway') return '✈️';
  if(k==='amenity'){const m={hospital:'🏥',clinic:'🏥',pharmacy:'💊',fuel:'⛽',restaurant:'🍽️',cafe:'☕',fast_food:'🍔',bar:'🍺',bank:'🏦',school:'🏫',university:'🎓',library:'📚',police:'🐷',fire_station:'🚒',cinema:'🎬',theatre:'🎭'};return m[v]||'📍';}
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
  // Zoom guard keeps the idle map uncluttered, but during nav we ALWAYS want
  // reports (incl. pigs) loaded regardless of zoom — otherwise a low preview
  // zoom at trip start leaves the map bare until the user pans.
  if(map.getZoom()<12 && navState!=='navigating'){clearReportMarkers();return;}
  const b=map.getBounds();
  const p=new URLSearchParams({swlat:b.getSouth(),swlng:b.getWest(),nelat:b.getNorth(),nelng:b.getEast()});
  try{
    const data=await fetch(`/api/reports?${p}`).then(r=>r.json());
    lastReports=Array.isArray(data)?data:[];
    detectNewCops(lastReports); // 🐷 toast when a fresh police report shows up
    // Refresh traffic colouring on the active/previewed route with fresh reports
    if(routePoints.length) updateTrafficOverlay(navState==='navigating'?routePoints.slice(Math.max(0,_lastRouteIdx)):routePoints);
    // Diff against the currently-rendered markers: reuse unchanged ones and only
    // add / remove / rebuild what actually changed, rather than tearing down and
    // recreating every marker DOM node on each refresh (a churn cost on pans and
    // the nav poll).
    const desired=new Map();
    for(const r of data){
      // speed_trap uses speed layer filter; police/all others use police filter
      if(r.type==='speed_trap'&&!visibleLayers.speed) continue;
      if(r.type!=='speed_trap'&&!visibleLayers.police) continue;
      desired.set(String(r.id), r);
    }
    // Drop markers that are gone or now filtered out.
    for(const [id,entry] of reportMarkerById){
      if(!desired.has(id)){ entry.marker.remove(); reportMarkerById.delete(id); }
    }
    // Add new / update changed. sig changes when type, vote counts, or position move.
    for(const [id,r] of desired){
      const sig=`${r.type}|${r.confirms}|${r.denies}|${r.lat.toFixed(5)}|${r.lng.toFixed(5)}`;
      const existing=reportMarkerById.get(id);
      if(existing){
        existing.r=r; // keep the latest data so the popup open-handler shows fresh age/counts
        if(existing.sig===sig) continue;                 // nothing visual changed
        if(existing.type===r.type){
          // Same icon — update in place so an OPEN popup (e.g. right after the
          // user votes) isn't torn down; just move it and refresh its content.
          existing.sig=sig;
          existing.marker.setLngLat([r.lng,r.lat]);
          existing.marker.getPopup()?.setHTML(reportPopupHtml(r));
          continue;
        }
        existing.marker.remove(); reportMarkerById.delete(id); // type changed → rebuild
      }
      const icon=ICONS[r.type]??ICONS.hazard;
      const entry={marker:null,sig,type:r.type,r};
      const popup=new maplibregl.Popup({offset:24,maxWidth:'260px'}).setHTML(reportPopupHtml(r));
      popup.on('open',()=>popup.setHTML(reportPopupHtml(entry.r))); // always-current age/counts
      entry.marker=new maplibregl.Marker({element:icon.el(),anchor:'center'}).setLngLat([r.lng,r.lat]).setPopup(popup).addTo(map);
      reportMarkerById.set(id,entry);
    }
  }catch{}
}
window.vote=async(id,action)=>{try{await fetch(`/api/reports/${id}/${action}`,{method:'POST'});loadReports();}catch{}};

/* ── "🐷 Pig located at <suburb>" — announce newly-added police reports ──────
   Fires when a police report we haven't seen before appears AND was created
   recently (so old cops scrolling into view as you drive don't spam). The
   nearest one is announced; a batch just adds "(+N more)". */
let _seenCops=null, _lastCopAnnounce=0;
function detectNewCops(data){
  const cops=(data||[]).filter(r=>r.type==='police');
  if(_seenCops===null){ _seenCops=new Set(cops.map(c=>String(c.id))); return; } // seed silently on first load
  const fresh=cops.filter(c=>!_seenCops.has(String(c.id)));
  if(!fresh.length) return;
  fresh.forEach(c=>_seenCops.add(String(c.id)));
  if(_seenCops.size>1500) _seenCops=new Set(cops.map(c=>String(c.id))); // cap growth
  const now=Date.now();
  const justAdded=fresh.filter(c=>now-(c.created_at||0)<180000); // genuinely new, not just entering view
  if(!justAdded.length || now-_lastCopAnnounce<6000) return;      // and don't spam
  _lastCopAnnounce=now;
  const me=userMarker?userMarker.getLngLat():(prevPos?{lng:prevPos.lng,lat:prevPos.lat}:null);
  if(me) justAdded.sort((a,b)=>haversine(me.lat,me.lng,a.lat,a.lng)-haversine(me.lat,me.lng,b.lat,b.lng));
  announceCop(justAdded[0], justAdded.length-1);
}
async function announceCop(r, more){
  let where='';
  try{
    const resp=await fetch(`https://photon.komoot.io/reverse?lon=${r.lng}&lat=${r.lat}&lang=en&limit=1`);
    const p=(await resp.json())?.features?.[0]?.properties||{};
    where=p.district||p.locality||p.suburb||p.city||p.town||p.village||p.name||p.county||'';
  }catch{}
  const extra=more>0?` (+${more} more)`:'';
  showToast(where?`🐷 Pig located at ${where}${extra}`:`🐷 Pig reported nearby${extra}`, 3800);
  if(prefs.haptic&&navigator.vibrate) navigator.vibrate(30);
}

/* Live refresh while navigating — moveend drives loads only while MOVING, so
   stopped at a light nothing refreshed for up to 90s. This poll keeps reports
   (incl. Waze police) + cameras current regardless of movement. 20s (was 12s):
   police-alert freshness is unaffected at driving speeds and it ~halves the
   background fetch/marker churn. */
let _navRefresh=null;
function startNavRefresh(){
  stopNavRefresh();
  _navRefresh=setInterval(()=>{
    if(navState!=='navigating') return;
    loadReports(); loadCameras(); loadNearReports(); loadNearCameras();
    try{ window.GhostPigs?.refresh?.(); }catch(_){} // keep statewide pigs current
    updateRouteCamsBtn();
    if(!$$('route-cams-sheet')?.classList.contains('hidden')) renderRouteCams(); // refresh live thumbs
  }, 20000);
}
function stopNavRefresh(){ if(_navRefresh){ clearInterval(_navRefresh); _navRefresh=null; } }

/* ── Live traffic cameras on your route (nav only) ──────────────────────────
   Filters the traffic-cam feed to cameras within ~400m of the active route
   (and the alternative routes), ordered by how far ahead they are, so you can
   glance at conditions on the road you're driving. */
let _routeCams=[];
function computeRouteCams(){
  const list = (window.GhostCams && window.GhostCams.all && window.GhostCams.all()) || [];
  if(!list.length || !routePoints.length){ _routeCams=[]; return; }
  const RADIUS=400;
  const altPolys=[];
  try{ (allRoutes||[]).forEach(t=>{ if(t&&t!==routeData) altPolys.push(decodePolyline6(t.legs[0].shape)); }); }catch(_){}
  const out=[];
  const STEP=3; // sample every 3rd vertex — 400m radius tolerates the gap, ~3x faster
  for(const cam of list){
    let best=Infinity, bestIdx=0;
    for(let i=0;i<routePoints.length;i+=STEP){ const d=haversine(cam.lat,cam.lng,routePoints[i][0],routePoints[i][1]); if(d<best){best=d;bestIdx=i;} }
    let onAlt=false;
    if(best>RADIUS){
      let na=false;
      for(const poly of altPolys){ for(let i=0;i<poly.length;i+=STEP){ if(haversine(cam.lat,cam.lng,poly[i][0],poly[i][1])<=RADIUS){na=true;break;} } if(na)break; }
      if(!na) continue; onAlt=true;
    }
    out.push({cam,idx:bestIdx,dist:best,onAlt});
  }
  out.sort((a,b)=> (a.onAlt-b.onAlt) || (a.idx-b.idx));
  _routeCams=out;
}
function _aheadCams(){ const cur=_lastRouteIdx||0; return _routeCams.filter(rc=> rc.onAlt || rc.idx>=cur-8); }
function _rcDist(rc){
  if(rc.onAlt) return 'alt';
  const cur=_lastRouteIdx||0; if(rc.idx<cur) return 'passed';
  let m=0; for(let i=cur;i<rc.idx&&i<routePoints.length-1;i++) m+=haversine(routePoints[i][0],routePoints[i][1],routePoints[i+1][0],routePoints[i+1][1]);
  return fmtDist(m);
}
function updateRouteCamsBtn(){
  const btn=$$('route-cams-btn'), cnt=$$('route-cams-count'); if(!btn) return;
  const show = navState==='navigating' && _routeCams.length>0;
  btn.classList.toggle('hidden', !show);
  if(show){ const n=_aheadCams().length; if(cnt){ cnt.textContent=String(n); cnt.classList.toggle('hidden', n===0); } }
  else { $$('route-cams-sheet')?.classList.add('hidden'); document.body.classList.remove('cams-open'); }
}
function renderRouteCams(){
  const listEl=$$('route-cams-list'); if(!listEl) return;
  const cams=_aheadCams();
  if(!cams.length){ listEl.innerHTML='<div id="route-cams-empty">No cameras on your route.</div>'; return; }
  listEl.innerHTML=cams.map(rc=>`
    <div class="rc-card${rc.onAlt?' rc-alt':''}" data-id="${escHtml(String(rc.cam.id))}">
      <div class="rc-thumb-wrap"><span class="rc-loading">📷</span><img alt=""><div class="rc-dist">${_rcDist(rc)}</div></div>
      <div class="rc-name">${escHtml(rc.cam.title||'Camera')}${rc.onAlt?' <span class="rc-alt-tag">ALT</span>':''}</div>
    </div>`).join('');
  cams.forEach((rc,i)=>{
    const card=listEl.children[i]; if(!card) return;
    const img=card.querySelector('img'), fresh=new Image();
    fresh.onload=()=>{ img.src=fresh.src; card.querySelector('.rc-loading')?.remove(); };
    fresh.onerror=()=>{ const l=card.querySelector('.rc-loading'); if(l) l.textContent='⚠️'; };
    fresh.src=window.GhostCams.img(rc.cam.file);
    card.addEventListener('click',()=> window.GhostCams&&window.GhostCams.open(rc.cam.id));
  });
}
function setRouteCamsOpen(open){
  const sheet=$$('route-cams-sheet'); if(!sheet) return;
  if(open){ renderRouteCams(); sheet.classList.remove('hidden'); }
  else sheet.classList.add('hidden');
  // While open the sheet owns the bottom band — hide the speed float + side FABs
  // it would otherwise collide with (they render above it otherwise).
  document.body.classList.toggle('cams-open', open);
}
$$('route-cams-btn')?.addEventListener('click',()=>{
  const sheet=$$('route-cams-sheet'); if(!sheet) return;
  setRouteCamsOpen(sheet.classList.contains('hidden'));
});
$$('route-cams-close')?.addEventListener('click',()=> setRouteCamsOpen(false));

async function loadCameras(){
  if(map.getZoom()<9 && navState!=='navigating'){clearMarkers(cameraMarkers);return;}
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
      const label={speed:'📷 Speed camera',red_light:'🔴 Red light camera',average_speed:'📡 Avg speed',bus_lane:'🚌 Bus lane camera'}[cam.type]??cam.type;
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

let _lastFetchAt=0;
function scheduleFetch(){
  const doFetch=()=>{
    _lastFetchAt=performance.now(); fetchTmr=null;
    loadReports(); loadCameras(); if(heatmapVisible) loadHeatmap();
    // Keep proximity-alert data fresh while driving (nav start only loaded it once)
    if(navState==='navigating'){ loadNearCameras(); loadNearReports(); }
  };
  clearTimeout(fetchTmr);
  // Normally debounce, BUT during nav the motion loop's per-frame jumpTo floods
  // moveend and would reset the debounce forever — starving camera/report loads.
  // Force a refresh if it's been >1.5s so cameras keep appearing as you drive.
  if(performance.now()-_lastFetchAt > 1500) doFetch();
  else fetchTmr=setTimeout(doFetch, 300);
}
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
    label:'5-0', emoji:'🐷', title:'Report police',
    subtypes:[
      {key:'police',     label:'Police',        emoji:'🐷', bg:'#1a2540'},
      {key:'hidden',     label:'Hidden',        emoji:'👁️', bg:'#1e2030'},
      {key:'other_side', label:'Other side',    emoji:'↩️', bg:'#222'},
    ]
  },
  speed_trap: {
    label:'Speed trap', emoji:'📷', title:'Report speed trap',
    subtypes:[
      {key:'speed_trap',   label:'Mobile camera', emoji:'📷', bg:'#1e1a2e'},
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
    label:'Roadwork', emoji:'👷', title:'Report roadwork',
    subtypes:[
      {key:'roadwork',     label:'Roadwork',       emoji:'👷', bg:'#1a1608'},
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
  if(pendingLat==null||pendingLng==null||!selCat||!selSubKey) return;
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
      window.Game?.onReport(); // daily "report N hazards"
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
    if(key==='voice'){ window._syncVoiceBtn&&window._syncVoiceBtn(); if(el.checked) unlockVoice(); }
  });
});

// Acceleration timer toggle + range picker
(()=>{
  const t=$$('s-acceltimer');
  if(t){
    t.checked=!!prefs.accelTimer;
    t.addEventListener('change',()=>{ prefs.accelTimer=t.checked; savePrefs();
      const row=$$('accel-range-row'); if(row) row.style.display=t.checked?'':'none';
      if(!t.checked){ accelReset(); }
      ensureAccelWatch(); // start/stop the standalone GPS watch for the timer
    });
    const row=$$('accel-range-row'); if(row) row.style.display=t.checked?'':'none';
    if(prefs.accelTimer) setTimeout(()=>ensureAccelWatch(), 1500); // resume watch on load if enabled
  }
  document.querySelectorAll('.accel-range-btn').forEach(btn=>{
    btn.classList.toggle('active',btn.dataset.range===prefs.accelRange);
    btn.addEventListener('click',()=>{
      prefs.accelRange=btn.dataset.range; savePrefs();
      document.querySelectorAll('.accel-range-btn').forEach(b=>b.classList.toggle('active',b.dataset.range===prefs.accelRange));
      accelReset();
    });
  });
})();

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
let arrivedFlag=false, _plannedArriveMs=0;

/* ── Open / close planner ──────────────────────── */
plannerBack.addEventListener('click', closePlanner);

/* ═══════════════════════════════════════════════
   SMOOTH MOTION — continuous dead-reckoning + GPS correction
   The car is driven by a velocity model, NOT by tweening between
   fixes. A single rAF loop advances the car forward along its
   heading at its current speed every frame, so it always flows.
   Each GPS fix updates a target (pos/heading/speed); the rendered
   car critically-damps toward that target PROJECTED FORWARD by the
   fix's age — so during a GPS gap the target keeps moving and the
   car flows with it, and on reconnect the correction is tiny (no
   jump). Long dropouts decay speed to a smooth stop.
═══════════════════════════════════════════════ */
let _mCurHdg=0, _mLastSpeedMs=0, _mRaf=null;
let _mv=null;   // rendered state {lat,lng,hdg,spd(m/s)}
let _mt=null;   // latest GPS target {lat,lng,hdg,spd,ts}
let _mLastFrame=0;
const _POS_TAU=0.32; // position-filter time constant (s); also the feed-forward lead
const _arc=(a,b)=>((b-a)%360+540)%360-180;

// Trim the route line to start at the animated car position (60fps).
// Only searches a small forward window around _lastRouteIdx so it's O(1) in practice.
// Route-line redraw throttle state. `_syncRouteRef` tracks the active routePoints
// array by identity so any reroute (which reassigns routePoints) auto-resets the
// cache and forces an immediate redraw.
let _lastSyncIdx = -1, _lastSyncLat = null, _lastSyncLng = null, _syncRest = null, _syncRouteRef = null;
function _syncRouteLine(lat, lng) {
  if (!routePoints.length || navState !== 'navigating') return;
  if (_syncRouteRef !== routePoints) { _syncRouteRef = routePoints; _lastSyncIdx = -1; _lastSyncLat = null; _lastSyncLng = null; _syncRest = null; }
  const len = routePoints.length;
  // Forward-biased window around the cursor. NEVER a global scan: at interchanges
  // the route passes near a LATER part of itself, so a global nearest-vertex can
  // jump far ahead — leaving routePoints.slice(best+1) empty and collapsing the
  // line to a single (invisible) point (the reported "route vanished" bug).
  const lo = Math.max(0, _lastRouteIdx - 3);
  const hi = Math.min(len - 1, _lastRouteIdx + 160);
  let minD = Infinity, best = _lastRouteIdx;
  for (let i = lo; i <= hi; i++) {
    const d = haversine(routePoints[i][0], routePoints[i][1], lat, lng);
    if (d < minD) { minD = d; best = i; }
  }
  _lastRouteIdx = best; // cursor follows the car at 60 fps so the window can't lag
  // Throttle the GPU upload: the 60fps motion loop calls us every frame, but the
  // remaining-route line only needs redrawing when we advance a vertex or the car
  // has moved a few metres — not 60×/s. Rebuilding + re-uploading the whole
  // remaining polyline every frame was the #1 nav lag source.
  if (!GhostCore.routeSyncNeeded(_lastSyncIdx, best, _lastSyncLat, _lastSyncLng, lat, lng, 6)) return;
  // Re-slice the (potentially long) remaining polyline only when we actually
  // advance a vertex; between advances just re-anchor its head to the car.
  if (best !== _lastSyncIdx || !_syncRest) _syncRest = routePoints.slice(best + 1);
  _lastSyncIdx = best; _lastSyncLat = lat; _lastSyncLng = lng;
  // Always draw car → remaining route as ≥2 points; clamp a near-end cursor so it
  // can't produce a 1-point LineString (which renders nothing).
  const coords = _syncRest.length ? toGL([[lat, lng], ..._syncRest])
                                  : toGL([[lat, lng], routePoints[len - 1]]);
  try {
    map.getSource('route-main')?.setData({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: coords }
    });
  } catch (_) {}
}

// Called on every GPS fix. Updates the target; snaps only on an
// implausible teleport (real GPS glitch), otherwise stays smooth.
function _setMotionTarget(lat,lng,hdg,spd){
  const now=performance.now();
  spd=Math.max(0, spd||0);
  if(!_mv){
    _mv={lat,lng,hdg,spd};
  } else {
    const d=haversine(_mv.lat,_mv.lng,lat,lng);
    // How far off we could plausibly be given our speed — dead reckoning
    // should have kept us close. Beyond this it's a teleport → snap once.
    const tol=Math.max(120, _mv.spd*6+60);
    if(d>tol){ _mv.lat=lat; _mv.lng=lng; _mv.hdg=hdg; _mv.spd=spd; }
  }
  _mt={lat,lng,hdg,spd,ts:now};
  if(_mRaf==null){ _mLastFrame=now; _mRaf=requestAnimationFrame(_motionFrame); }
}

function _syncMarkerTransform(){
  if(!userMarker)return;
  const el=userMarker.getElement();
  const rot=_mCurHdg-map.getBearing();
  const pitch=map.getPitch();
  const wrap=el.querySelector('.car3d-wrap');
  if(wrap){
    wrap.style.transform=`rotate(${rot}deg)`;
    const tilt=wrap.querySelector('.car3d-tilt');
    if(tilt) tilt.style.transform=`rotateX(${pitch}deg)`;
    return;
  }
  const svg=el.querySelector('svg,.user-arrow');
  if(svg) svg.style.transform=`rotate(${rot}deg)`;
}

function _motionFrame(ts){
  if(!userMarker||!_mv||!_mt){ _mRaf=null; return; }
  const now=performance.now();
  const dt=Math.min(Math.max((ts-_mLastFrame)/1000,0.001),0.1); // clamp long tab-away gaps
  _mLastFrame=ts;
  const age=(now-_mt.ts)/1000; // seconds since last GPS fix

  // Staleness: hold speed for 2.5 s, then glide to a stop by ~5 s (no runaway on dropout)
  const stale=age<=2.5?1:Math.max(0,1-(age-2.5)/2.5);
  const tgtSpd=_mt.spd*stale;

  // Ease rendered speed + heading toward target (exponential smoothing)
  _mv.spd+=(tgtSpd-_mv.spd)*(1-Math.exp(-dt/0.6));
  _mv.hdg+=_arc(_mv.hdg,_mt.hdg)*(1-Math.exp(-dt/0.35));

  // Predicted "true" position = last fix projected forward along its heading
  // by speed × age. This IS the dead reckoning: as the fix ages during a GPS
  // gap, the target keeps advancing, so the car keeps flowing forward.
  // Plus a velocity feed-forward lead: an exponential filter chasing a moving
  // target sits a steady τ·v behind it (τ=_POS_TAU below). Leading the target
  // by that same distance cancels the lag so the car rides ON the road, not
  // ~5 m behind it at speed. Lead fades to 0 as we stop, so no overshoot.
  const projDist=Math.min(age,3)*tgtSpd + _POS_TAU*tgtSpd;
  let ptLat=_mt.lat, ptLng=_mt.lng;
  if(projDist>0.2){ const p=aheadPoint(_mt.lat,_mt.lng,_mt.hdg,projDist); ptLat=p[0]; ptLng=p[1]; }

  // Critically-damped convergence toward the (moving) predicted target.
  const kPos=1-Math.exp(-dt/_POS_TAU);
  let nLat=_mv.lat+(ptLat-_mv.lat)*kPos;
  let nLng=_mv.lng+(ptLng-_mv.lng)*kPos;
  // While moving, never let a correction push the car BACKWARD along its heading
  // (that reads as stutter). Keep the lateral component (road-snapping), drop the
  // reverse along-track component so motion always flows forward.
  if(_mv.spd>2){
    const hr=_mv.hdg*Math.PI/180, cosL=Math.cos(_mv.lat*Math.PI/180);
    let dLat=nLat-_mv.lat, dLng=(nLng-_mv.lng)*cosL;
    const fLat=Math.cos(hr), fLng=Math.sin(hr);          // forward unit vector
    const along=dLat*fLat+dLng*fLng;
    if(along<0){ dLat-=along*fLat; dLng-=along*fLng; nLat=_mv.lat+dLat; nLng=_mv.lng+dLng/cosL; }
  }
  _mv.lat=nLat; _mv.lng=nLng;

  _mCurHdg=_mv.hdg; _mLastSpeedMs=_mv.spd;
  userMarker.setLngLat([_mv.lng,_mv.lat]);
  _syncMarkerTransform();
  window.Car3D?.setPos(_mv.lng,_mv.lat,_mv.hdg);
  _syncRouteLine(_mv.lat, _mv.lng);

  // Drive the map camera at 60fps — car sits in lower third via top padding
  const _NAV_PAD={top:Math.round(window.innerHeight*0.30),bottom:0,left:0,right:0};
  if(navState==='navigating' && !userPanning){
    if(perspective3D){
      map.jumpTo({center:[_mv.lng,_mv.lat],bearing:_mv.hdg,pitch:65,zoom:targetNavZoom(_mLastSpeedMs),padding:_NAV_PAD});
    } else {
      map.jumpTo({center:[_mv.lng,_mv.lat],bearing:headingUpMode?_mv.hdg:map.getBearing(),pitch:0,zoom:targetNavZoom(_mLastSpeedMs),padding:_NAV_PAD});
    }
  }
  // Pause the loop once the car is parked + settled — it restarts on the next
  // fix (_setMotionTarget). Avoids spinning at 60fps at red lights / when idle.
  const settled=_mv.spd<0.5 && Math.hypot(ptLat-_mv.lat,ptLng-_mv.lng)*111000<1;
  _mRaf = settled ? null : requestAnimationFrame(_motionFrame);
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
function showSuggestions(filterQ=''){
  const favs=getFavs(), recents=getRecent();
  const ql=filterQ.toLowerCase();
  const filter=p=>!ql||p.name?.toLowerCase().includes(ql);
  if(filterQ){
    const hits=[...favs,...recents].filter(filter).reduce((a,p)=>a.find(x=>x.name===p.name)?a:[...a,p],[]);
    if(hits.length){
      searchResultsEl.innerHTML=
        `<div class="results-section-label">🕐 Recent &amp; saved</div>`+
        hits.slice(0,5).map(p=>resultRow(p,isFav(p.name),true,placeEmoji(p),null,filterQ)).join('');
      bindResultClicks(); return;
    }
    searchResultsEl.innerHTML=`<div class="no-results" style="font-size:.85rem;color:#666">Keep typing…</div>`;
    return;
  }
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
let srchDebounce=null, _searchSeq=0, _searchAbort=null;
// Short-lived client cache so backspacing / re-typing a query is instant.
const _searchCache=new Map(); const SEARCH_TTL=120000, SEARCH_CACHE_MAX=60;
function searchCacheGet(k){ const e=_searchCache.get(k); if(!e) return null; if(Date.now()-e.t>SEARCH_TTL){_searchCache.delete(k);return null;} _searchCache.delete(k); _searchCache.set(k,e); return e.r; }
function searchCacheSet(k,r){ _searchCache.set(k,{t:Date.now(),r}); if(_searchCache.size>SEARCH_CACHE_MAX) _searchCache.delete(_searchCache.keys().next().value); }
function wireInput(input, field){
  input.addEventListener('focus',()=>{
    setActiveField(field);
    const q=input.value.trim();
    const minLen=/^\d/.test(q)?2:3; // match the input handler's gate
    if(q.length>=minLen) doSearch(q);
    else showSuggestions(q);
  });
  input.addEventListener('input',()=>{
    const q=input.value.trim();
    (field==='from'?fromClear:toClear).classList.toggle('hidden',!q);
    clearTimeout(srchDebounce);
    if(!q){showSuggestions();return;}
    // Number-led (civic address) queries search from 2 chars; everything else at 3.
    const minLen = /^\d/.test(q) ? 2 : 3;
    if(q.length<minLen){ showSuggestions(q); return; }
    srchDebounce=setTimeout(()=>doSearch(q),220);
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
  // Re-route whenever there's a destination — tryRoute falls back to My-location
  // for a null origin, so requiring fromPlace here left valid swaps doing nothing.
  if(toPlace)tryRoute();
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

  // ④ Free-text — progressive. Paint the fast edge-cached geocoder the instant
  //    it returns; merge slow Overpass POIs in late (hard-capped at 2.8s) so the
  //    UI NEVER blocks on the slowest source (the old code awaited all three).
  const seq=++_searchSeq;
  if(_searchAbort) _searchAbort.abort();  // cancel a prior in-flight search
  _searchAbort=new AbortController();
  const signal=_searchAbort.signal;

  // Cache key includes a coarse (~11km) location bucket so results ranked by
  // distance for one area aren't replayed after the user has moved.
  const cacheKey=`${q.toLowerCase()}@${lat?lat.toFixed(1):''},${lng?lng.toFixed(1):''}`;
  const collected=[]; let settled=0, painted=false;
  const paint=()=>{
    const merged=mergeResults([collected],lat,lng); // dedup
    merged.forEach(r=>{ r._score=scoreResult(r,q,lat,lng); });
    merged.sort((a,b)=>b._score-a._score);
    renderSearchResults(merged,locals,q);
    searchCacheSet(cacheKey,merged);
    painted=true;
  };
  const ingest=(list)=>{ if(seq!==_searchSeq||!list?.length) return; collected.push(...list); paint(); };
  const finish=()=>{ if(seq!==_searchSeq) return;
    // Only show "Nothing found" if we never painted anything (don't clobber a
    // cached list when both live sources come back empty on a transient failure).
    if(++settled>=2 && !collected.length && !locals.length && !painted){
      searchResultsEl.innerHTML=`<div class="no-results">Nothing found for "<strong>${escHtml(q)}</strong>"<br><small>Check spelling or try a suburb name</small></div>`;
    }
  };

  // Instant paint from cache while the network refreshes underneath.
  const cached=searchCacheGet(cacheKey);
  if(cached?.length){ renderSearchResults(cached,locals,q); painted=true; }

  unifiedSearch(q,lat,lng,signal).then(r=>ingest(enrichPhoton(r,lat,lng))).catch(()=>{}).finally(finish);
  overpassNameSearch(q,lat,lng,12000,signal,2800).then(r=>ingest(r)).catch(()=>{}).finally(finish);
}

// Shared renderer: locals section + place results (used for progressive paints).
function renderSearchResults(merged,locals,q){
  let html='';
  if(locals.length){
    html+=`<div class="results-section-label">🕐 Recent &amp; saved</div>`;
    html+=locals.slice(0,2).map(r=>resultRow(r,isFav(r.name),true,placeEmoji(r),null,q)).join('');
  }
  if(merged.length){
    if(locals.length) html+=`<div class="results-section-label">🔍 Results</div>`;
    html+=merged.slice(0,20).map(r=>resultRow(r,isFav(r.name),true,r._emoji??placeEmoji(r),placeLabel(r),q)).join('');
  }
  if(!html) html=`<div class="no-results srch-spin">Searching…</div>`;
  searchResultsEl.innerHTML=html;
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

// ── Bridge for race.js (keeps race logic decoupled from app internals) ────────
window.ghostRace = {
  dest(){ return toPlace ? {lat:+toPlace.lat, lng:+toPlace.lng, name:toPlace.name||'Finish'} : null; },
  pos(){ const g=userMarker?userMarker.getLngLat():(prevPos?{lat:prevPos.lat,lng:prevPos.lng}:null); return g?{lat:g.lat,lng:g.lng}:null; },
  navState(){ return navState; },
  car(){ return localStorage.getItem('selectedCar')||''; },
  // Set a destination and show the route preview (used when joining a race)
  routeTo(lat,lng,name){ toPlace={lat,lng,name:name||'Finish'}; if(typeof toInput!=='undefined'&&toInput){toInput.value=toPlace.name;toClear.classList.remove('hidden');} tryRoute(); },
  // Ready to launch? (route calculated, not already driving)
  canGo(){ return !!routeData && routePoints.length>0 && navState!=='navigating'; },
  // Auto-launch navigation at "GO!" (both racers start together)
  go(){ if(routeData && routePoints.length && navState!=='navigating') startNav(); },
};

/* ═══════════════════════════════════════════════
   ROUTING
═══════════════════════════════════════════════ */
let _routeReq=0; // generation counter — ignore responses that a cancel/new search superseded
async function calcRoute(fromLat,fromLng,toLat,toLng){
  const myReq=++_routeReq;
  previewBar.classList.add('hidden');
  map.getSource('route-main')?.setData(emptyFC());
  map.getSource('route-traveled')?.setData(emptyFC());
  map.getSource('route-alts')?.setData(emptyFC());
  map.getSource('route-traffic')?.setData(emptyFC());
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

  // ── Instant feedback ── the /api/route fetch takes ~1-2s; without this the
  // tap felt dead. React immediately: buzz, frame the whole trip on the map,
  // and pop the preview sheet in a "Finding routes…" loading state that fills
  // in when the route arrives. An optimistic straight line hints the shape.
  if(prefs.haptic && navigator.vibrate) navigator.vibrate(15);
  navState='preview'; document.body.classList.add('previewing'); topbar.classList.add('hidden');
  try{
    map.getSource('route-alts')?.setData({type:'Feature',geometry:{type:'LineString',coordinates:[[fromLng,fromLat],[toLng,toLat]]}});
    map.fitBounds([[Math.min(fromLng,toLng),Math.min(fromLat,toLat)],[Math.max(fromLng,toLng),Math.max(fromLat,toLat)]],
      {padding:{top:120,bottom:220,left:60,right:60}, maxZoom:15, duration:550});
  }catch(_){}
  showRouteLoading(true);
  previewBar.classList.remove('hidden');
  setSheetState('peek');

  try{
    const resp=await fetch('/api/route',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(16000)});
    if(myReq!==_routeReq) return; // superseded by a newer request / cancelled
    if(!resp.ok){ routeFail('Couldn’t find a route there.'); return; }
    const data=await resp.json();
    if(myReq!==_routeReq) return;
    // Guard against a flaky upstream handing back a 200 with no usable trip.
    if(!data?.trip?.legs?.[0]?.shape){ routeFail('Couldn’t find a route there.'); return; }

    allRoutes=[];
    allRoutes.push(data.trip);
    if(data.alternates){
      data.alternates.forEach(a=>{ if(a?.trip?.legs?.[0]?.shape) allRoutes.push(a.trip); });
    }
    selectedRouteIdx=0;
    showRouteLoading(false);
    applySelectedRoute();
    fetchSchoolZones();
    fetchRouteSpeedLimits();
  }catch(e){ if(myReq!==_routeReq) return; routeFail(e?.name==='TimeoutError'?'Routing timed out — try again.':'Routing error — check your connection.'); }
}

// Preview sheet loading state — shown instantly while the route is fetched.
function showRouteLoading(on){
  if(!previewBar) return;
  previewBar.classList.toggle('route-loading', on);
  if(on){
    if(previewTime) previewTime.innerHTML='<span class="route-spinner"></span>Finding routes…';
    if(previewDist) previewDist.textContent='';
    const via=$$('preview-via'); if(via) via.textContent='';
    const note=$$('preview-avoidance-note'); if(note) note.classList.add('hidden');
  }
}
// Route fetch failed — clear the optimistic UI and drop back to search.
function routeFail(msg){
  showRouteLoading(false);
  previewBar.classList.add('hidden');
  document.body.classList.remove('previewing');
  map.getSource('route-alts')?.setData(emptyFC());
  if(destMarker){destMarker.remove();destMarker=null;}
  navState='idle';
  showToast(msg);
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

  const td=routeData.summary.length, tt=routeData.summary.time + trafficDelaySec(routePoints);
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
// Sensible AU default speed for a road class when OSM has no maxspeed tag — so a
// limit sign shows on rural/suburban roads (Chifley Rd, Sofala Rd…) that Overpass
// returns no maxspeed for. Used only as a fallback below real maxspeed data.
function classDefaultSpeed(hw){
  switch(hw){
    case 'motorway': case 'motorway_link': return 100;
    case 'trunk': case 'trunk_link': return 90;
    case 'primary': case 'primary_link': return 80;
    case 'secondary': case 'secondary_link': return 70;
    case 'tertiary': case 'tertiary_link': return 60;
    case 'unclassified': return 60;
    case 'residential': return 50;
    case 'living_street': return 20;
    default: return null;
  }
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
  // Fetch drivable ways WHETHER OR NOT they carry a maxspeed tag — we fall back to
  // a class default when maxspeed is absent so the sign shows on nearly every road.
  // (residential/living_street excluded: huge in cities and low-value for the HUD.)
  const q=`[out:json][timeout:25];way["highway"~"^(motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|unclassified)$"](${s},${w},${n},${e});out tags geom;`;
  try{
    const resp=await fetch('https://overpass-api.de/api/interpreter',{
      method:'POST',body:'data='+encodeURIComponent(q),
      headers:{'Content-Type':'application/x-www-form-urlencoded','User-Agent':'radar-app/1.0'}
    });
    const {elements}=await resp.json();
    speedLimitWays=[];
    for(const el of elements){
      if(!el.geometry?.length) continue;
      const limit=parseMaxspeed(el.tags?.maxspeed) ?? classDefaultSpeed(el.tags?.highway);
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
  _routeReq++; // invalidate any in-flight route fetch so it can't re-open the preview
  previewBar.classList.remove('route-loading');
  map.getSource('route-main')?.setData(emptyFC());
  map.getSource('route-traveled')?.setData(emptyFC());
  map.getSource('route-alts')?.setData(emptyFC());
  map.getSource('route-traffic')?.setData(emptyFC());
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
startNavBtn.addEventListener('click',()=>{ unlockVoice(); startNav(); });
// Show the score FIRST (banks points + shows the modal, whose Done handler
// then ends nav). Calling endNav() first would reset gta.score to 0 via
// gtaEndNav(), so pressing End awarded no points. Mirror the arrival flow.
endNavBtn.addEventListener('click',()=>{ showScoreSubmit(); });
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
  // Lock in the ORIGINAL traffic-aware ETA at trip start — this is the baseline
  // the arrival roast judges you against, and it never changes during the trip.
  const _startTraffic=trafficDelaySec(routePoints);
  remainingSec=routeData.summary.time+_startTraffic;
  _plannedArriveMs=Date.now()+remainingSec*1000;
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

  // Force every hazard overlay ON the moment nav starts — don't wait on the
  // page-idle lazy-load or a user pan. Speed/red-light camera + report markers,
  // the statewide pigs layer, and live traffic cams are all always-on for nav.
  loadCameras();   // fixed enforcement-camera markers
  loadReports();   // reports incl. 🐷 police
  try{ window.GhostCams?.show?.(); }catch(_){}   // live traffic-cam layer
  try{ window.GhostPigs?.ensureOn?.(); }catch(_){} // statewide police overlay

  // Precompute route arc-length + reset the dead-reckoning estimator for this trip.
  buildRouteCumDist(); _drProgressM=0; _drSpeed=0; _drActive=false; _lastRouteIdx=0;
  _lastLimit=null; _lastLimitAtM=-1e9; // don't carry a prior trip's speed limit

  if(watchId!=null) navigator.geolocation.clearWatch(watchId);
  watchId=navigator.geolocation.watchPosition(onGPS,gpsErr,{enableHighAccuracy:true,maximumAge:0,timeout:10000});
  startGpsWatchdog(); // surface "Searching for GPS…" + keep the map alive on dropout
  startDeadReckon();  // keep position/turns/cameras moving during GPS/data dropout
  startNavRefresh();  // keep reports/cameras live even when stopped at a light
  // Build the "cameras on your route" list (loads cam metadata if needed)
  try{ (window.GhostCams?.ensure?.()||Promise.resolve()).then(()=>{ computeRouteCams(); updateRouteCamsBtn(); }); }catch(_){}
  ensureAccelWatch(); // nav's onGPS now feeds the accel timer — stop the standalone watch
  updateNavPanel();
  dingChime();
}

function endNav(){
  navState='idle';
  if(watchId!=null){navigator.geolocation.clearWatch(watchId);watchId=null;}
  stopGpsWatchdog(); setGpsLost(false); stopDeadReckon();
  stopNavRefresh();
  _routeCams=[]; $$('route-cams-btn')?.classList.add('hidden'); $$('route-cams-sheet')?.classList.add('hidden'); document.body.classList.remove('cams-open');
  ensureAccelWatch(); // resume the standalone accel watch if the timer is on
  [navInst,navFooter,alertBar,arrivalOverlay,$$('nav-search-sheet'),$$('nav-routes-sheet')].forEach(el=>el?.classList.add('hidden'));
  updateRouteWarn(null);
  window.Game?.onDriveEnd(gta.score); // daily "drives"/"bestScore" + auto-stop recording
  gtaEndNav();
  accelReset();
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
  _mv=null; _mt=null;
  clearRoute();
  if(userMarker){userMarker.remove();userMarker=null;}
  window.Car3D?.hide();
  { const g=$$('congestion-glow'); if(g){ g.classList.remove('on','slow','heavy'); _glowSev=-1; } }
  prevPos=null;
  currentSpeedEl.innerHTML='– <small>km/h</small>';
  speedLimitSign.classList.add('hidden');
}

/* ── GPS-loss handling ──────────────────────────────────────────────────
   When fixes stop arriving (tunnel, dead zone, phone GPS glitch) the motion
   loop dead-reckons to a stop and then PAUSES — so nothing drives the map
   canvas, which can be left black with the car floating (reported bug). We
   (1) show a "Searching for GPS…" banner, (2) keep forcing repaints so the
   basemap/route don't stay black if a repaint stalled. */
let _lastFixMs=0, _gpsWatchdog=null, _gpsLost=false;

/* ── Dead reckoning during GPS/data dropout ─────────────────────────────────
   When fixes stop arriving we keep the nav "alive" by advancing our distance
   ALONG THE ROUTE using the last-known speed (decaying), then walking that
   distance down the polyline to an estimated position. That estimate feeds the
   same turn/camera/ETA logic AND the visual motion controller, so the car keeps
   following the road through curves and callouts keep firing. A real fix snaps
   everything back to truth (see onGPS). Speed-based only — no accelerometer. */
let _drProgressM=0, _drSpeed=0, _drLastMs=0, _drActive=false, _drTimer=null;
const DR_GAP_MS=3000; // start estimating once ~3s pass with no fix (fixes are ~1Hz)
function startDeadReckon(){
  stopDeadReckon();
  _drLastMs=performance.now();
  _drTimer=setInterval(deadReckonTick,500);
}
function stopDeadReckon(){ if(_drTimer){ clearInterval(_drTimer); _drTimer=null; } _drActive=false; }
function deadReckonTick(){
  if(navState!=='navigating'||!routePoints.length||!routeCumDist.length) return;
  const now=performance.now();
  const sinceFix=now-_lastFixMs;
  if(sinceFix<DR_GAP_MS){ _drLastMs=now; return; } // GPS is fresh — onGPS is driving
  const dt=Math.min((now-_drLastMs)/1000,2); _drLastMs=now;
  // Hold full speed for the first 3s of the gap, then ease to a stop by ~+18s so
  // a long tunnel doesn't send the estimate racing off the end of the route.
  const gapAge=sinceFix/1000;
  const decay=gapAge<=3?1:Math.max(0,1-(gapAge-3)/15);
  const spd=_drSpeed*decay;
  const total=routeCumDist[routeCumDist.length-1]||0;
  _drProgressM=Math.min(_drProgressM+spd*dt, total);
  const est=progressMToPos(_drProgressM);
  if(!est) return;
  _drActive=true;
  // Feed the visual motion loop so the car follows the polyline (not a straight
  // line off the road), and update all the turn/camera/ETA readouts.
  _setMotionTarget(est.lat,est.lng,est.hdg,spd);
  applyNavProgress(est.lat,est.lng,est.hdg,est.idx,true);
}

function setGpsLost(lost){
  if(lost===_gpsLost) return;
  _gpsLost=lost;
  $$('gps-lost')?.classList.toggle('hidden', !lost);
  if(lost && prefs.voice){ try{ speak('GPS signal lost. Searching.'); }catch(_){} }
}
function startGpsWatchdog(){
  stopGpsWatchdog();
  _lastFixMs=performance.now();
  _gpsWatchdog=setInterval(()=>{
    if(navState!=='navigating') return;
    if(performance.now()-_lastFixMs>6000){
      setGpsLost(true);
      try{ map.triggerRepaint(); }catch(_){} // don't let the GL canvas stay black
    }
  }, 2000);
}
function stopGpsWatchdog(){ if(_gpsWatchdog){ clearInterval(_gpsWatchdog); _gpsWatchdog=null; } }
function gpsErr(e){
  console.warn('GPS',e.code,e.message);
  if(navState==='navigating' && e.code===e.TIMEOUT) setGpsLost(true);
}

// Recover from a WebGL context loss (mobile memory pressure) instead of a
// permanently black map. Re-add our custom sources/layers and repaint.
(function(){
  try{
    const cv=map.getCanvas();
    cv.addEventListener('webglcontextlost', (e)=>{ e.preventDefault(); console.warn('WebGL context lost'); }, false);
    cv.addEventListener('webglcontextrestored', ()=>{
      console.warn('WebGL context restored — rebuilding layers');
      try{ setupMapLayers(); }catch(_){}
      try{ if(navState==='navigating' && routePoints.length) updateRouteStyling(_lastRouteIdx); }catch(_){}
      try{ map.triggerRepaint(); }catch(_){}
    }, false);
  }catch(_){}
})();

/* ── Auto-zoom + look-ahead per zoom level ──────── */
function targetNavZoom(speedMs){ return GhostCore.targetNavZoom(speedMs,perspective3D); }
// Max look-ahead in metres per zoom level (keeps car visible in lower third of screen)
const LOOK_CAP={15:900,16:500,17:220,18:90,19:50};

/* ── Silent reroute (mid-navigation, no preview bar) ── */
// Reroute in-flight guard + cooldown. Off-route detection can fire GPS-fast, so
// without these a second reroute would launch while the first is still awaiting
// (a stale response could then clobber a newer route). One at a time, and no more
// than one every few seconds even if we stay off-route.
let _rerouting=false, _lastRerouteAt=0;
const REROUTE_COOLDOWN_MS=4000;
async function reroute(lat,lng){
  if(!routePoints.length || navState!=='navigating') return;
  if(_rerouting) return;                                   // one at a time
  if(Date.now()-_lastRerouteAt < REROUTE_COOLDOWN_MS) return; // don't spam upstream
  _rerouting=true; _lastRerouteAt=Date.now();
  const myGen=++_routeReq; // invalidate any in-flight preview fetch; tag this reroute
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
      signal:AbortSignal.timeout(16000),
      body:JSON.stringify({
        locations:[{lon:lng,lat:lat},{lon:dest[1],lat:dest[0]}],
        costing:'auto',
        directions_options:{units:'kilometers',language:'en-US'},
        ...(Object.keys(costOpts).length?{costing_options:costOpts}:{}),
      })});
    // Bail if the trip ended or a newer route request superseded us mid-flight.
    if(navState!=='navigating' || myGen!==_routeReq){ return; }
    if(!resp.ok){showToast('Could not reroute',3000);return;}
    const data=await resp.json();
    if(navState!=='navigating' || myGen!==_routeReq){ return; }
    if(!data?.trip?.legs?.[0]?.shape){ showToast('Could not reroute',3000); return; }
    routeData=data.trip;
    routePoints=decodePolyline6(routeData.legs[0].shape);
    maneuvers=routeData.legs[0].maneuvers;
    currentMidx=0; lastVoice=-1; offCount=0;
    allRoutes=[routeData]; selectedRouteIdx=0;
    buildRouteCumDist(); _drProgressM=0; _lastRouteIdx=0; // new geometry → rebuild arc-length + re-anchor cursor
    updateRouteGeoJSON();
    map.getSource('route-traveled')?.setData(emptyFC());
    showToast('Route updated',2000);
    loadNearCameras(); loadNearReports();
    // New geometry → refresh which cameras are "on your route".
    try{ computeRouteCams(); updateRouteCamsBtn(); }catch(_){}
  }catch(e){ showToast(e?.name==='TimeoutError'?'Reroute timed out':'Rerouting failed',3000); }
  finally{ _rerouting=false; }
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
   CAR SYSTEM — real 3D models (Kenney Car Kit, CC0)
   The car is rendered by car3d.js as a WebGL layer
   inside the map's 3D world, at the GPS point + heading.
   The DOM marker is just a transparent anchor.
═══════════════════════════════════════════════ */
// Transparent anchor marker — the actual car is drawn by the 3D WebGL layer.
function _d3Marker(){ return {html:'<div class="user-arrow car3d-anchor" style="width:4px;height:4px;pointer-events:none"></div>', d3:true}; }

const CARS=[
  // ── Realistic fleet (Sketchfab, CC-BY — see CREDITS.md) ──────────────────
  {id:'ferrari',    name:'Ferrari',        emoji:'🏎️', model:'ferrari.glb',        fn:_d3Marker, d3:true},
  {id:'pony',       name:'GT Sport',       emoji:'🏎️', model:'sk-pony.glb',        fn:_d3Marker, d3:true},
  {id:'f40',        name:'F40 LM',         emoji:'🏎️', model:'sk-f40.glb',         fn:_d3Marker, d3:true},
  {id:'koenigsegg', name:'Koenigsegg One', emoji:'🏎️', model:'sk-koenigsegg.glb',  fn:_d3Marker, d3:true},
  {id:'phoenix',    name:'Muscle Car',     emoji:'🚗', model:'sk-phoenix.glb',     fn:_d3Marker, d3:true},
  {id:'copcruiser', name:'Cop Cruiser',    emoji:'🚓', model:'sk-copcruiser.glb',  fn:_d3Marker, d3:true},
  {id:'cyber',      name:'Cyber Car',      emoji:'🏎️', model:'sk-cyber.glb',       fn:_d3Marker, d3:true},
  {id:'volvo130',   name:'Classic Coupe',  emoji:'🚗', model:'sk-volvo130.glb',    fn:_d3Marker, d3:true},
  {id:'c10pickup',  name:'C10 Pickup',     emoji:'🛻', model:'sk-c10pickup.glb',   fn:_d3Marker, d3:true},
  {id:'cadillac',   name:'Classic Sedan',  emoji:'🚗', model:'sk-cadillac.glb',    fn:_d3Marker, d3:true},
  {id:'karlmann',   name:'Luxury SUV',     emoji:'🚙', model:'sk-karlmann.glb',    fn:_d3Marker, d3:true},
  {id:'skyline',    name:'Skyline R34',    emoji:'🏎️', model:'sk-skyline.glb',     fn:_d3Marker, d3:true},
  {id:'rx7',        name:'RX-7',           emoji:'🏎️', model:'sk-rx7.glb',         fn:_d3Marker, d3:true},
  {id:'porsche930', name:'911 Turbo',      emoji:'🏎️', model:'sk-porsche930.glb',  fn:_d3Marker, d3:true},
  {id:'mustang65',  name:"'65 Mustang",    emoji:'🚗', model:'sk-mustang.glb',     fn:_d3Marker, d3:true},
  {id:'mini',       name:'Mini Cooper',    emoji:'🚗', model:'sk-mini.glb',        fn:_d3Marker, d3:true},
  {id:'vwbus',      name:'VW Kombi',       emoji:'🚐', model:'sk-vwbus.glb',       fn:_d3Marker, d3:true},
  {id:'jeep',       name:'Wrangler',       emoji:'🚙', model:'sk-jeep.glb',        fn:_d3Marker, d3:true},
  {id:'countach',   name:'Countach',       emoji:'🏎️', model:'sk-countach.glb',    fn:_d3Marker, d3:true},
  {id:'mclarenf1',  name:'F1 Car',         emoji:'🏎️', model:'sk-mclaren.glb',     fn:_d3Marker, d3:true},
  {id:'charger',    name:'Charger (Cop)',  emoji:'🚓', model:'sk-charger.glb',     fn:_d3Marker, d3:true},
  {id:'delorean',   name:'DeLorean',       emoji:'🚗', model:'sk-delorean.glb',    fn:_d3Marker, d3:true},
  {id:'cybertruck', name:'Cybertruck',     emoji:'🛻', model:'sk-cybertruck.glb',  fn:_d3Marker, d3:true},
  {id:'ae86',       name:'AE86 Trueno',    emoji:'🏎️', model:'sk-ae86.glb',        fn:_d3Marker, d3:true},
  {id:'e30',        name:'BMW E30',        emoji:'🚗', model:'sk-e30.glb',         fn:_d3Marker, d3:true},
  // ── 3D models (Kenney Car Kit) ───────────────────────────────────────────
  {id:'sedan-sports',    name:'Sports Sedan',  emoji:'🏎️', model:'sedan-sports.glb',    fn:_d3Marker, d3:true},
  {id:'race',            name:'Race Car',      emoji:'🏁', model:'race.glb',             fn:_d3Marker, d3:true},
  {id:'race-future',     name:'Hypercar',      emoji:'🚀', model:'race-future.glb',      fn:_d3Marker, d3:true},
  {id:'hatchback-sports',name:'Hot Hatch',     emoji:'🚗', model:'hatchback-sports.glb', fn:_d3Marker, d3:true},
  {id:'sedan',           name:'Sedan',         emoji:'🚙', model:'sedan.glb',            fn:_d3Marker, d3:true},
  {id:'suv',             name:'SUV',           emoji:'🚐', model:'suv.glb',              fn:_d3Marker, d3:true},
  {id:'suv-luxury',      name:'Luxury SUV',    emoji:'🛻', model:'suv-luxury.glb',       fn:_d3Marker, d3:true},
  {id:'taxi',            name:'Taxi',          emoji:'🚕', model:'taxi.glb',             fn:_d3Marker, d3:true},
  {id:'police',          name:'Police',        emoji:'🚓', model:'police.glb',           fn:_d3Marker, d3:true},
  {id:'van',             name:'Van',           emoji:'🚌', model:'van.glb',              fn:_d3Marker, d3:true},
  {id:'delivery',        name:'Delivery',      emoji:'📦', model:'delivery.glb',         fn:_d3Marker, d3:true},
  {id:'truck',           name:'Truck',         emoji:'🚚', model:'truck.glb',            fn:_d3Marker, d3:true},
  {id:'ambulance',       name:'Ambulance',     emoji:'🚑', model:'ambulance.glb',        fn:_d3Marker, d3:true},
  {id:'firetruck',       name:'Fire Truck',    emoji:'🚒', model:'firetruck.glb',        fn:_d3Marker, d3:true},
  {id:'garbage-truck',   name:'Garbage Truck', emoji:'🗑️', model:'garbage-truck.glb',   fn:_d3Marker, d3:true},
  {id:'tractor',         name:'Tractor',       emoji:'🚜', model:'tractor.glb',          fn:_d3Marker, d3:true},
  // ── Planes (fly above the map) ───────────────────────────────────────────
  {id:'plane-prop',      name:'Prop Plane',    emoji:'🛩️', model:'plane-prop.glb',       fn:_d3Marker, d3:true},
  {id:'plane-liner',     name:'Airliner',      emoji:'✈️', model:'plane-liner.glb',      fn:_d3Marker, d3:true},
  {id:'plane-paper',     name:'Paper Plane',   emoji:'📄', model:'plane-paper.glb',      fn:_d3Marker, d3:true},
  // ── Novelty ──────────────────────────────────────────────────────────────
  {id:'eggplant',        name:'Eggplant',      emoji:'🍆', model:'food/eggplant.glb',         fn:_d3Marker, d3:true},
  {id:'avocado',         name:'Avocado',       emoji:'🥑', model:'food/avocado.glb',          fn:_d3Marker, d3:true},
  {id:'duck',            name:'Rubber Duck',   emoji:'🦆', model:'duck.glb',                   fn:_d3Marker, d3:true},
  {id:'toycar',          name:'Toy Car',       emoji:'🧸', model:'toycar.glb',                 fn:_d3Marker, d3:true},
  {id:'milktruck',       name:'Milk Truck',    emoji:'🥛', model:'milktruck.glb',              fn:_d3Marker, d3:true},
  {id:'londonbus',       name:'London Bus',    emoji:'🚌', model:'sk-londonbus.glb',           fn:_d3Marker, d3:true},
  {id:'monster',         name:'Monster Truck', emoji:'🛻', model:'sk-monster.glb',              fn:_d3Marker, d3:true},
  // ── Karts (tinted 3D karts + character faces — set in car3d.js) ───────────
  {id:'mario',     name:'Mario',     emoji:'🔴', model:'char-mario.glb', fn:_d3Marker, d3:true},
  {id:'luigi',     name:'Luigi',     emoji:'🟢', model:'char-luigi.glb', fn:_d3Marker, d3:true},
  {id:'peach',     name:'Peach',     emoji:'👸', model:'char-peach.glb', fn:_d3Marker, d3:true},
  {id:'bowser',    name:'Bowser',    emoji:'🐢', model:'char-bowser.glb', fn:_d3Marker, d3:true},
  {id:'pikachu',   name:'Pikachu',   emoji:'⚡', model:'char-pikachu.glb', fn:_d3Marker, d3:true},
];
// Migrate legacy selections (old PNG ids) → default 3D car
let selectedCar=localStorage.getItem('selectedCar')??(CARS[0].id);
if(!CARS.some(c=>c.id===selectedCar)) selectedCar=CARS[0].id;
function currentCar(){ return CARS.find(c=>c.id===selectedCar); }
function getCarFn(){ return currentCar()?.fn ?? _d3Marker; }

function makeUserIcon(gpsHdg=0){ return getCarFn()(gpsHdg); }

// Push the current selection to the on-map 3D car layer.
function applyCarSelection(){
  const car=currentCar();
  if(car&&car.d3){ window.Car3D?.setModel(car.model); window.Car3D?.show(); }
  else window.Car3D?.hide();
}

/* ── Garage: 3D showroom + car chips ─────────────── */
let _showroom=null;
(()=>{
  const grid=$$('car-grid'); if(!grid) return;
  const canvas=$$('car-showroom-canvas');
  const nameEl=$$('car-showroom-name');
  function showName(){ const c=currentCar(); if(nameEl) nameEl.textContent=c?c.name:''; }
  // Colour swatches — shown only for cars that recolour cleanly
  const colorRow=$$('car-color-row');
  const SWATCHES=['','#ff0099','#ef4444','#f97316','#fbbf24','#22c55e','#22d3ee','#3b82f6','#a855f7','#f8fafc','#0b0b12'];
  function buildSwatches(){
    if(!colorRow) return;
    const cur=(localStorage.getItem('carTint')||'');
    colorRow.innerHTML='';
    SWATCHES.forEach(c=>{
      const b=document.createElement('button');
      b.className='car-swatch'+(c===cur?' active':'')+(c===''?' swatch-reset':'');
      b.title=c===''?'Default paint':c;
      if(c===''){ b.textContent='✕'; } else { b.style.background=c; }
      b.addEventListener('click',()=>{
        window.Car3D?.setTint(c);
        colorRow.querySelectorAll('.car-swatch').forEach(x=>x.classList.remove('active'));
        b.classList.add('active');
      });
      colorRow.appendChild(b);
    });
  }
  function updateColorRow(){
    if(!colorRow) return;
    const c=currentCar();
    const ok=!!(c&&c.model&&window.Car3D&&window.Car3D.isTintable&&window.Car3D.isTintable(c.model));
    colorRow.classList.toggle('hidden',!ok);
    if(ok) buildSwatches();
  }
  function mount(){
    if(_showroom||!window.Car3D||!canvas) return;
    _showroom=window.Car3D.mountShowroom(canvas);
    const c=currentCar(); if(c&&c.model) _showroom.setModel(c.model);
    updateColorRow();
  }
  // The module is deferred; retry until it's ready.
  let tries=0; const iv=setInterval(()=>{ mount(); if(_showroom||++tries>50) clearInterval(iv); },100);
  mount(); showName();

  CARS.forEach(car=>{
    const btn=document.createElement('button');
    btn.className='car-pick-btn'+(car.id===selectedCar?' active':'');
    btn.dataset.carid=car.id;
    // Rendered thumbnail of the actual model (falls back to emoji if missing)
    btn.innerHTML=`<div class="car-pick-preview"><img class="car-pick-img" src="/carthumbs/${car.id}.png" alt="" loading="lazy" onerror="this.remove();this.parentNode.textContent='${car.emoji||'🚗'}'"></div><span>${car.name}</span>`;
    btn.addEventListener('click',()=>{
      selectedCar=car.id;
      localStorage.setItem('selectedCar',car.id);
      document.querySelectorAll('.car-pick-btn').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      showName();
      updateColorRow();
      if(car.model) _showroom?.setModel(car.model);
      applyCarSelection();
      // Recreate marker with new car (emoji cars need fresh DOM; 3D just swaps model)
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

// Compact score: 523000→"523K", 1000000→"1M", 1500000→"1.5M", 5230→"5.2K".
let _scoreFmt=null;
try{ _scoreFmt=new Intl.NumberFormat('en',{notation:'compact',maximumFractionDigits:1}); }catch(_){}
function fmtScore(n){
  n=Math.floor(n)||0;
  if(_scoreFmt) return _scoreFmt.format(n);
  const a=Math.abs(n); // fallback for browsers without compact notation
  if(a>=1e6) return parseFloat((n/1e6).toFixed(1))+'M';
  if(a>=1e3) return parseFloat((n/1e3).toFixed(a<1e5?1:0))+'K';
  return String(n);
}

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
    window.Game?.onStars(newStars); // daily "reach N wanted stars"
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
  // Sit the banner BELOW the nav instruction so it never covers the maneuver icon
  const nav=$$('nav-instruction');
  banner.style.top=(nav && !nav.classList.contains('hidden')) ? nav.offsetHeight+'px' : '0px';
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
  window.Game?.onEvade(); // daily "evade the cops"
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
  // Stars 1–4 scale with how far over the limit you are. The 5th is the
  // "absolutely flying" star — near-impossible: you must be doing ~150 km/h.
  let target=0;
  if(excessKmh>=15) target=1;
  if(excessKmh>=30) target=2;
  if(excessKmh>=45) target=3;
  if(excessKmh>=60) target=4;

  // Police or speed trap nearby bumps wanted level — but proximity alone caps
  // at 4 stars; the 5th can only come from genuinely reckless speed.
  const closestCop=nearReports.filter(r=>r.type==='police'||r.type==='speed_trap')
    .map(r=>haversine(lat,lng,r.lat,r.lng)).sort((a,b)=>a-b)[0]??Infinity;
  if(closestCop<120&&excessKmh>5) target=Math.min(4,target+2);
  else if(closestCop<250&&excessKmh>5) target=Math.min(4,target+1);

  // ⭐⭐⭐⭐⭐ — the near-impossible fifth star: ~150 km/h.
  if(speedKmh>=150) target=5;

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
  window.Car3D?.setPos(lng,lat,gpsHdg);
  applyCarSelection();
  return new maplibregl.Marker({element:el,anchor:'center'}).setLngLat([lng,lat]);
}

/* ── GPS handler ────────────────────────────────── */
/* ═══════════════════════════════════════════════
   ACCELERATION TIMER — 0-60 / 0-100 / 40-150 etc.
   Measures time to accelerate through a speed window. Runs while navigating.
═══════════════════════════════════════════════ */
const ACCEL_RANGES = {'0-60':[0,60],'0-100':[0,100],'0-160':[0,160],'40-150':[40,150],'60-160':[60,160],'100-200':[100,200]};
let _ax = {timing:false, t0:0, prevKmh:0, prevT:0, raf:null};
function accelBest(range){ return parseFloat(localStorage.getItem('accelBest_'+range)||'')||null; }
function accelReset(){ _ax.timing=false; _ax.prevKmh=0; _ax.prevT=0; _ax.doneUntil=0; _accelStopLive(); $$('accel-timer')?.classList.add('hidden'); }

// Smooth live counter — GPS is only ~1 Hz, so tick the displayed time on rAF.
function _accelStartLive(){
  if(_ax.raf) return;
  const step=()=>{ if(!_ax.timing){ _ax.raf=null; return; } renderAccel('live',(performance.now()-_ax.t0)/1000,false); _ax.raf=requestAnimationFrame(step); };
  _ax.raf=requestAnimationFrame(step);
}
function _accelStopLive(){ if(_ax.raf){ cancelAnimationFrame(_ax.raf); _ax.raf=null; } }

function accelTick(speedMs){
  const el=$$('accel-timer'); if(!prefs.accelTimer||!el) return;
  const [lo,hi]=ACCEL_RANGES[prefs.accelRange]||[0,100];
  const kmh=(speedMs||0)*3.6;
  const startLine=Math.max(lo,1);
  const now=performance.now();
  const pk=_ax.prevKmh, pt=_ax.prevT||now;

  if(!_ax.timing){
    // Crossed the start line going up → interpolate the exact launch instant
    if(pk<startLine && kmh>=startLine){
      const f=(startLine-pk)/((kmh-pk)||1);
      _ax.t0=pt+f*(now-pt);
      _ax.timing=true;
      _accelStartLive();
    } else if(kmh<hi && now>=(_ax.doneUntil||0)){
      // Armed but not yet launched — show a live readout so you can SEE it's
      // watching, instead of a silent pill that only appears after a full run.
      // Suppressed briefly after a run so the result stays on screen.
      renderAccelArmed(kmh);
    }
  } else {
    if(kmh>=hi){
      // Crossed the finish line → interpolate the exact finish instant
      const f=(hi-pk)/((kmh-pk)||1);
      const t=(pt+f*(now-pt)-_ax.t0)/1000;
      _ax.timing=false; _accelStopLive();
      const best=accelBest(prefs.accelRange);
      const isBest=!best||t<best;
      if(isBest) localStorage.setItem('accelBest_'+prefs.accelRange,t.toFixed(2));
      renderAccel('done',t,isBest);
      if(prefs.haptic&&navigator.vibrate) navigator.vibrate(isBest?[80,40,80,40,160]:[120]);
      _ax.prevKmh=kmh; _ax.prevT=now;
      _ax.doneUntil=now+7000; // keep the result on screen; suppress armed readout
      clearTimeout(_ax._hide); _ax._hide=setTimeout(()=>{ if(!_ax.timing) $$('accel-timer')?.classList.add('hidden'); },7000);
      return;
    }
    // Aborted — slowed well below the start line
    if(kmh<startLine-3){ _ax.timing=false; _accelStopLive(); el.classList.add('hidden'); }
  }
  _ax.prevKmh=kmh; _ax.prevT=now;
}

// Keep a GPS watch alive for the accel timer even when NOT navigating, so you
// can just floor it and time a run without setting a route.
let accelWatchId=null, _accelPrev=null;
function _accelSpeed(pos){
  const {latitude:lat,longitude:lng,speed}=pos.coords;
  let sp=speed;
  if(sp==null||isNaN(sp)){
    if(_accelPrev){ const dt=(pos.timestamp-_accelPrev.ts)/1000; if(dt>0) sp=haversine(_accelPrev.lat,_accelPrev.lng,lat,lng)/dt; }
  }
  _accelPrev={lat,lng,ts:pos.timestamp};
  accelTick(sp||0);
}
function ensureAccelWatch(){
  const want = prefs.accelTimer && navState!=='navigating';
  if(want && accelWatchId==null){
    try{ accelWatchId=navigator.geolocation.watchPosition(_accelSpeed,()=>{},{enableHighAccuracy:true,maximumAge:0,timeout:12000}); }catch(_){}
  } else if(!want && accelWatchId!=null){
    navigator.geolocation.clearWatch(accelWatchId); accelWatchId=null; _accelPrev=null;
  }
}
// Idle "armed & watching" readout: current speed vs the target window, so you
// can confirm the timer is live before you launch (no more silent waiting).
function renderAccelArmed(kmh){
  const el=$$('accel-timer'); if(!el) return;
  const [lo,hi]=ACCEL_RANGES[prefs.accelRange]||[0,100];
  const best=accelBest(prefs.accelRange);
  el.classList.remove('hidden');
  el.className='accel-timer accel-armed';
  el.innerHTML=`<span class="accel-range">${prefs.accelRange} km/h</span>`+
    `<span class="accel-time">${Math.round(kmh)}<small>km/h</small></span>`+
    `<span class="accel-tag">${best?`BEST ${best.toFixed(2)}s`:'ready'}</span>`;
}
function renderAccel(state,t,isBest){
  const el=$$('accel-timer'); if(!el) return;
  const best=accelBest(prefs.accelRange);
  el.classList.remove('hidden');
  el.className='accel-timer '+(state==='done'?(isBest?'accel-best':'accel-done'):'accel-live');
  const tag=(state==='done'&&isBest)?'🏆 NEW BEST':(best?`BEST ${best.toFixed(2)}s`:'');
  el.innerHTML=`<span class="accel-range">${prefs.accelRange} km/h</span>`+
    `<span class="accel-time">${t.toFixed(2)}<small>s</small></span>`+
    (tag?`<span class="accel-tag">${tag}</span>`:'');
}

function onGPS(pos){
  _lastFixMs=performance.now();
  if(_gpsLost) setGpsLost(false); // a fix arrived → clear the "searching" state
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
  accelTick(speedMs);
  window.Game?.onSpeed(speedMs*3.6); // daily top-speed + recording stat

  // Snap car to the nearest point on the route polyline when within 40 m.
  // Eliminates GPS drift that places the car icon off the road.
  let dispLat=lat, dispLng=lng, dispHdg=hdg;
  if(navState==='navigating' && routePoints.length){
    const {idx:sIdx,dist:sDist}=matchRouteIdx(lat,lng);
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
    _mCurHdg=dispHdg;
    _mv={lat:dispLat,lng:dispLng,hdg:dispHdg,spd:speedMs};
  }
  // Feed the fix to the continuous motion controller (dead-reckoning + damping).
  _setMotionTarget(dispLat,dispLng,dispHdg,speedMs);
  // Motion + 60fps camera follow run continuously in _motionFrame

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

  // Detect traffic from own sustained low speed → feeds the red route overlay
  detectCongestion(lat,lng,speedMs*3.6,getSpeedLimit(lat,lng));
  updateCongestionGlow(lat,lng); // red/amber edge glow when inside a jam
  window.Race?.tick(lat,lng);    // race: push my position + poll opponent

  const {idx,dist}=matchRouteIdx(lat,lng);

  if(dist>60){
    offCount++;
    if(offCount>=3){offCount=0;reroute(lat,lng);return;}
  } else offCount=0;

  // Re-anchor the dead-reckoning estimator to this ground-truth fix.
  _drProgressM=posToProgressM(idx,lat,lng);
  _drSpeed=speedMs; _drLastMs=performance.now();
  // If we'd been coasting on estimates (GPS/data gap), the fix is back → reload
  // the whole-route hazard set so "what's upcoming" is a fresh, correct default.
  if(_drActive){ _drActive=false; loadNearCameras(); loadNearReports(); }

  applyNavProgress(lat,lng,hdg,idx,false);
  trackNavDistance();

  if(!headingUpMode&&speedMs>2){
    headingUpMode=true;
  }
}

// Shared "where am I on the route / what's next" update. Runs on every real GPS
// fix AND — during a GPS/data dropout — on every dead-reckoning tick with an
// estimated position, so turn callouts, camera alerts and ETA keep working with
// no signal. `estimated`=true suppresses the arrival trigger (see below).
function applyNavProgress(lat,lng,hdg,idx,estimated){
  if(navState!=='navigating'||!routePoints.length) return;
  updateRouteStyling(idx);
  for(let i=maneuvers.length-1;i>=0;i--){if(idx>=maneuvers[i].begin_shape_index){currentMidx=i;break;}}
  const nextM=maneuvers[currentMidx+1]??maneuvers[currentMidx];
  const nextPt=routePoints[nextM.begin_shape_index]??routePoints[routePoints.length-1];
  const distToTurn=haversine(lat,lng,nextPt[0],nextPt[1]);
  // Base remaining time + traffic still ahead of us (shrinks as we clear jams)
  // Fraction complete by arc-length (routeCumDist), not vertex index — Valhalla
  // packs far more vertices around turns than on long straights, so index-fraction
  // makes the ETA count down unevenly.
  const _total=routeCumDist.length?routeCumDist[routeCumDist.length-1]:0;
  const _frac=_total>0?Math.min(routeCumDist[idx]/_total,1):Math.min(idx/routePoints.length,1);
  remainingSec=Math.round(routeData.summary.time*(1-_frac))
               + trafficDelaySec(routePoints.slice(idx));
  updateNavPanel(distToTurn);
  checkVoice(currentMidx,distToTurn);
  checkProximityAlerts(lat,lng,hdg);
  if(perspective3D&&currentMidx!==lastRefreshedMidx){lastRefreshedMidx=currentMidx;refreshStreetLabels();}
  updateSpeedProfileCursor();
  // Only declare arrival on a REAL fix — a dead-reckoned estimate can coast to
  // the destination during a GPS dropout (tunnel / underground car park) and
  // falsely announce "you have arrived" a block early.
  if(!estimated && (nextM.type>=4&&nextM.type<=6) && distToTurn<25){
    triggerArrival();
  }
}

// toGL declared earlier to avoid temporal dead zone

let _lastRouteIdx=0; // track last GPS route index so style swaps don't reset the trimmed line

/* ═══════════════════════════════════════════════
   TRAFFIC — colour congested stretches of the route red/orange.
   Sources: crowdsourced traffic-type reports + the driver's own
   sustained low speed (no external traffic API needed).
═══════════════════════════════════════════════ */
// Report types that mean congestion, mapped to severity.
const TRAFFIC_SEV = {accident:'heavy', closure:'heavy', blocked_lane:'heavy', traffic:'slow', roadwork:'slow'};
let lastReports=[];              // most recent reports fetched for the viewport
let liveCongestion=[];           // {lat,lng,sev,ts} from own-speed detection
const CONGESTION_TTL=10*60*1000; // live congestion expires after 10 min

function addLiveCongestion(lat,lng,sev){
  const now=Date.now();
  for(const c of liveCongestion){
    if(haversine(lat,lng,c.lat,c.lng)<40){ c.ts=now; if(sev==='heavy') c.sev='heavy'; return; }
  }
  liveCongestion.push({lat,lng,sev,ts:now});
}

function congestionSources(){
  const now=Date.now();
  liveCongestion=liveCongestion.filter(c=>now-c.ts<CONGESTION_TTL);
  const rep=lastReports.filter(r=>TRAFFIC_SEV[r.type]).map(r=>({lat:r.lat,lng:r.lng,sev:TRAFFIC_SEV[r.type]}));
  return rep.concat(liveCongestion);
}

// Extra seconds to add to a route's ETA for the traffic sitting on it.
// Heavy jam ≈ crawl (8 km/h), slow ≈ 20 km/h, vs an assumed free-flow ~50 km/h.
function trafficDelaySec(points){
  const srcs=congestionSources();
  if(!srcs.length || !points || points.length<2) return 0;
  const THRESH=90, FREE=13.9, V_HEAVY=2.2, V_SLOW=5.5; // m/s
  let heavyM=0, slowM=0;
  for(let i=1;i<points.length;i++){
    const seg=haversine(points[i-1][0],points[i-1][1],points[i][0],points[i][1]);
    let sev=0;
    for(const s of srcs){ if(haversine(points[i][0],points[i][1],s.lat,s.lng)<THRESH){ sev=Math.max(sev,s.sev==='heavy'?2:1); if(sev===2)break; } }
    if(sev===2) heavyM+=seg; else if(sev===1) slowM+=seg;
  }
  const extra=heavyM*(1/V_HEAVY-1/FREE)+slowM*(1/V_SLOW-1/FREE);
  return Math.max(0,Math.round(extra));
}

// Own-speed congestion detection: sustained crawl well below the limit = a jam.
// Requires 15 s of slow-but-moving speed so red lights don't trigger false jams.
let _slowSince=0;
function detectCongestion(lat,lng,kmh,lim){
  if(!lim){ _slowSince=0; return; }
  if(kmh < lim*0.55){
    const now=performance.now();
    if(!_slowSince) _slowSince=now;
    if(now-_slowSince>15000 && kmh>3){
      addLiveCongestion(lat,lng, kmh<Math.max(10,lim*0.3)?'heavy':'slow');
    }
  } else if(kmh > lim*0.7){ _slowSince=0; }
}

// Build a FeatureCollection of the congested sub-segments of `points` ([lat,lng][]).
// Pure logic in public/lib/geo.js; here we feed it the live congestion sources.
function computeTrafficFC(points){ return GhostCore.computeTrafficFC(points, congestionSources()); }

function updateTrafficOverlay(points){
  try{ map.getSource('route-traffic')?.setData(computeTrafficFC(points)); }catch(_){}
}

// Severity of congestion the driver is currently inside (0 none, 1 slow, 2 heavy).
function currentCongestionSev(lat,lng){
  let sev=0;
  // Tight radius so the glow only fires when you're genuinely on top of a jam
  // (heavy gets a slightly wider reach than a minor slowdown).
  for(const s of congestionSources()){
    const d=haversine(lat,lng,s.lat,s.lng);
    if(s.sev==='heavy'){ if(d<75) sev=Math.max(sev,2); }
    else if(d<45) sev=Math.max(sev,1);
  }
  return sev;
}

// "Hue lights": fade a red/amber screen-edge glow in/out as you enter/leave a jam.
let _glowSev=-1;
function updateCongestionGlow(lat,lng){
  const el=$$('congestion-glow'); if(!el) return;
  const sev = (navState==='navigating') ? currentCongestionSev(lat,lng) : 0;
  if(sev===_glowSev) return;
  _glowSev=sev;
  el.classList.toggle('slow', sev===1);
  el.classList.toggle('heavy', sev===2);
  el.classList.toggle('on', sev>0);
  if(sev>0 && prefs.haptic && navigator.vibrate) navigator.vibrate(sev===2?[60,40,60]:[45]);
}

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
  updateTrafficOverlay(routePoints);
}

let _lastTrafficAt=0, _lastTrafficIdx=-999;
// The congestion overlay is O(points·sources) with a dilation pass — recomputing
// it on every GPS fix / dead-reckon tick is wasteful. Refresh at most ~every
// 2.5s, or immediately when the route index jumps (reroute / big skip). Fresh
// reports still force an out-of-band refresh via loadReports().
function _trafficDirty(idx){
  const now=performance.now();
  if(Math.abs(idx-_lastTrafficIdx)>40 || now-_lastTrafficAt>2500){ _lastTrafficAt=now; _lastTrafficIdx=idx; return true; }
  return false;
}
function updateRouteStyling(idx){
  if(!routePoints.length) return;
  _lastRouteIdx=idx;
  // Draw from the animated car position (not the raw GPS index) so the line
  // never appears behind the car. _syncRouteLine owns the route-main visual.
  const animLat = _mv ? _mv.lat : routePoints[idx][0];
  const animLng = _mv ? _mv.lng : routePoints[idx][1];
  _syncRouteLine(animLat, animLng);
  map.getSource('route-traveled')?.setData({type:'Feature',geometry:{type:'LineString',coordinates:[]}});
  if(_trafficDirty(idx)) updateTrafficOverlay(routePoints.slice(Math.max(0,idx)));
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
  // metres/sec of the planned route; guard time===0 so a degenerate route can't
  // render "NaNkm".
  const rate=routeData.summary.time>0?routeData.summary.length*1000/routeData.summary.time:0;
  const remDist=Math.max(0,remainingSec*rate);
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

let _lastLimit=null, _lastLimitAtM=-1e9;
function getSpeedLimit(lat,lng){
  const clat=lat??prevPos?.lat, clng=lng??prevPos?.lng;
  let lim=null;
  // 1. Limit provided by the routing engine for the current maneuver.
  const m=maneuvers[currentMidx];
  if(m?.speed_limit&&m.speed_limit<200) lim=m.speed_limit;
  // 2. Nearest OSM way — real maxspeed if tagged, else the road-class default.
  if(lim==null && speedLimitWays.length && clat!=null){
    let minD=Infinity,best=null;
    for(const way of speedLimitWays){
      for(let i=0;i<way.coords.length-1;i++){
        const d=distToSegmentM(clat,clng,way.coords[i],way.coords[i+1]);
        if(d<minD){minD=d;best=way.limit;}
      }
    }
    if(minD<45) lim=best;
  }
  // 3. A nearby speed camera's posted zone.
  if(lim==null && clat!=null && Array.isArray(nearCameras)){
    for(const cam of nearCameras){
      if(cam.speed_limit && haversine(clat,clng,cam.lat,cam.lng)<300){ lim=cam.speed_limit; break; }
    }
  }
  if(lim!=null){ _lastLimit=lim; _lastLimitAtM=_drProgressM; return lim; }
  // 4. Hold the last known limit through short data gaps (until ~6km past it).
  if(_lastLimit!=null && (_drProgressM-_lastLimitAtM)<6000) return _lastLimit;
  return null;
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
    const _rp={top:Math.round(window.innerHeight*0.30),bottom:0,left:0,right:0};
    if(perspective3D){
      map.easeTo({center:[lng,lat],bearing:_mCurHdg,pitch:65,zoom:targetNavZoom(_mLastSpeedMs),duration:400,padding:_rp});
    } else {
      map.easeTo({center:[lng,lat],bearing:headingUpMode?_mCurHdg:0,pitch:0,zoom:targetNavZoom(_mLastSpeedMs),duration:400,padding:_rp});
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

// Bounding box covering the WHOLE active route (+~5km pad). During navigation we
// load cameras/reports for the entire corridor up front (and on each refresh) so
// upcoming hazards are always in memory — they don't vanish when data drops or the
// map viewport lags behind the car. Falls back to the viewport when not navigating.
function _hazardBounds(){
  if(navState==='navigating' && routePoints.length){
    // Only the stretch AHEAD (~8km) rather than the whole trip's bounding box, so
    // hazard/camera fetches stay small and relevant as you drive — a Sydney→
    // Newcastle route used to request a ~150km box every refresh.
    const AHEAD_M=8000;
    const start=Math.max(0,Math.min(_lastRouteIdx,routePoints.length-1));
    let s=90,w=180,n=-90,e=-180,acc=0;
    for(let i=start;i<routePoints.length;i++){
      const [la,lo]=routePoints[i];
      if(la<s)s=la; if(la>n)n=la; if(lo<w)w=lo; if(lo>e)e=lo;
      if(i>start){ acc+=haversine(routePoints[i-1][0],routePoints[i-1][1],la,lo); if(acc>AHEAD_M) break; }
    }
    const pad=0.01; // ~1km lateral cushion for side streets
    return {getSouth:()=>s-pad,getWest:()=>w-pad,getNorth:()=>n+pad,getEast:()=>e+pad};
  }
  return map.getBounds().pad(0.3);
}
async function loadNearCameras(){
  const b=_hazardBounds();
  const p=new URLSearchParams({swlat:b.getSouth(),swlng:b.getWest(),nelat:b.getNorth(),nelng:b.getEast()});
  try{const r=await fetch(`/api/cameras?${p}`).then(r=>r.json()); if(Array.isArray(r)) nearCameras=r;}catch{}
}
async function loadNearReports(){
  const b=_hazardBounds();
  const p=new URLSearchParams({swlat:b.getSouth(),swlng:b.getWest(),nelat:b.getNorth(),nelng:b.getEast()});
  try{const r=await fetch(`/api/reports?${p}`).then(r=>r.json()); if(Array.isArray(r)) nearReports=r;}catch{}
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
let _voice=null, _voiceUnlocked=false;
function pickVoice(){
  if(!synth) return;
  const vs=synth.getVoices()||[];
  _voice = vs.find(v=>v.lang==='en-AU') || vs.find(v=>/^en-GB/i.test(v.lang))
        || vs.find(v=>/^en/i.test(v.lang)) || vs[0] || null;
}
if(synth){ pickVoice(); try{ synth.onvoiceschanged=pickVoice; }catch(_){} }
// iOS & most mobile browsers silently block speechSynthesis until it has fired
// once inside a real user gesture. Prime it with a muted utterance on the first
// tap (and when nav starts / voice is toggled on) so turn-by-turn actually speaks.
function unlockVoice(){
  if(_voiceUnlocked||!synth) return;
  try{ const u=new SpeechSynthesisUtterance(' '); u.volume=0; synth.speak(u); _voiceUnlocked=true; }catch(_){}
}
document.addEventListener('pointerdown', unlockVoice, {once:true});
function speak(text){
  if(!prefs.voice||!synth||!text) return;
  try{
    synth.cancel();
    const u=new SpeechSynthesisUtterance(text);
    u.lang='en-AU'; u.rate=1.05; u.volume=1; if(_voice) u.voice=_voice;
    synth.speak(u);
  }catch(_){}
}
// Speaker/mute toggle on the nav screen (kept in sync with the settings switch).
(function(){
  const btn=$$('voice-toggle'); if(!btn) return;
  window._syncVoiceBtn=()=>{ btn.textContent=prefs.voice?'🔊':'🔇'; btn.classList.toggle('muted',!prefs.voice); const s=$$('s-voice'); if(s) s.checked=prefs.voice; };
  _syncVoiceBtn();
  btn.addEventListener('click',()=>{
    prefs.voice=!prefs.voice; savePrefs(); _syncVoiceBtn();
    if(prefs.voice){ unlockVoice(); speak('Voice on'); showToast('🔊 Voice guidance on'); }
    else { try{ synth&&synth.cancel(); }catch(_){} showToast('🔇 Voice muted'); }
  });
})();
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
// Graded roast — vs the ORIGINAL ETA locked in at trip start (never the updated
// one). Negative m = arrived LATE. Punchy on both ends.
function arrivalRoast(m){ // m = minutes early
  if(m<=-12) return ['🚽','Dead last. Absolute little bitch.'];
  if(m<=-7)  return ['🐌','You drive like a scared little bitch.'];
  if(m<=-4)  return ['💀','Pathetic. My nan would’ve beaten you.'];
  if(m<=-2)  return ['🥱','Late. Sunday-driver little bitch energy.'];
  if(m<=-0.5)return ['😬','Cut it close, softie. Barely late.'];
  if(m< 1)   return ['🫡','Bang on time. Respectable.'];
  if(m< 3)   return ['🔥','Early. Not bad, hotshot.'];
  if(m< 6)   return ['😈','Certified speed demon.'];
  if(m< 10)  return ['🚔','Absolute menace. Cops want a word.'];
  if(m< 15)  return ['👑','You ARE the traffic now.'];
  return ['🏆','LUDICROUS SPEED. GODLIKE.'];
}
function triggerArrival(){
  if(arrivedFlag)return; arrivedFlag=true;
  window.Race?.onArrive(); // race: mark me finished (winner detection)
  speak('You have arrived at your destination.');
  dingChime(); setTimeout(dingChime,600); setTimeout(dingChime,1200);
  if(prefs.haptic&&navigator.vibrate)navigator.vibrate([300,100,300,100,300]);
  arrivalDest.textContent=toPlace?.name??'your destination';
  // Roast based on how early/late vs the original ETA
  const diffMin=_plannedArriveMs?(_plannedArriveMs-Date.now())/60000:0;
  const [emoji,line]=arrivalRoast(diffMin);
  const roastEl=$$('arrival-roast');
  if(roastEl){
    const absM=Math.abs(Math.round(diffMin));
    const when=diffMin>=1?`${absM} min early`:diffMin<=-1?`${absM} min late`:'right on time';
    roastEl.innerHTML=`<div class="roast-line">${line}</div><div class="roast-sub">${when}</div>`;
  }
  const emojiEl=$$('arrival-emoji'); if(emojiEl) emojiEl.textContent=emoji;
  arrivalOverlay.classList.remove('hidden');
  [navInst,navFooter,alertBar].forEach(el=>el.classList.add('hidden'));
  releaseWakeLock();
  accelReset();
  // Arrived — tear down the live loops now (endNav also does this, but only after
  // the score modal is dismissed). Otherwise GPS watch + the 20s report/camera
  // poll + dead-reckon/watchdog timers keep running and draining battery/data
  // while the arrival overlay sits open.
  stopNavRefresh(); stopDeadReckon(); stopGpsWatchdog();
  if(watchId!=null){ navigator.geolocation.clearWatch(watchId); watchId=null; }
  if(_mRaf!=null){ cancelAnimationFrame(_mRaf); _mRaf=null; }
}

/* ═══════════════════════════════════════════════
   GTA MAP COLOURS
═══════════════════════════════════════════════ */
function applyMinecraftColors(){
  // Repaint the bright voyager base into a Minecraft overworld palette.
  const p=(layer,prop,val)=>{try{if(map.getLayer(layer)) map.setPaintProperty(layer,prop,val);}catch{}};
  const GRASS='#79c05a', GRASS2='#6bab4c', WATER='#3f76e4', LEAVES='#3f7a2e',
        SAND='#e3dcaf', STONE='#b7b7b7', DIRT='#a6895b', PLANK='#b0885a';
  // Land = grass
  p('background','background-color',GRASS);
  ['landcover','landcover_wood','landcover_grass','landuse','landuse_overlay','landuse_residential','landuse_commercial'].forEach(l=>p(l,'fill-color',GRASS2));
  ['park','park_national_park','park_nature_reserve','national_park','nature_reserve','pitch','grass','wood','landcover_forest'].forEach(l=>{p(l,'fill-color',LEAVES);p(l,'line-color',LEAVES);});
  ['sand','beach'].forEach(l=>p(l,'fill-color',SAND));
  // Water = Minecraft blue
  ['water','water_shadow','ocean','waterway_tunnel','water_pattern'].forEach(l=>p(l,'fill-color',WATER));
  ['waterway','waterway_river','waterway_other','waterway-river','river'].forEach(l=>{p(l,'line-color',WATER);p(l,'fill-color',WATER);});
  // Building footprints = cobblestone grey (NOT brown planks). In a dense CBD the
  // flat footprint fill tiles the whole ground, so brown here = the "mud" look;
  // grey reads as a clean Minecraft stone town and lets green grass/roads pop.
  const COBBLE='#8f8b83';
  ['building','building-top'].forEach(l=>{p(l,'fill-color',COBBLE);p(l,'fill-outline-color','#5a564f');});
  // Roads = gravel/dirt paths
  ['road_motorway','road_trunk','motorway','trunk','highway_motorway','tunnel_motorway','bridge_motorway'].forEach(l=>p(l,'line-color',STONE));
  ['road_primary','road_secondary','primary','secondary','highway_primary','highway_secondary'].forEach(l=>p(l,'line-color','#c9ac78'));
  ['road_tertiary','road_minor','tertiary','minor_road','road','street','highway_minor','residential'].forEach(l=>p(l,'line-color',DIRT));
  ['road_path','path','footway','pedestrian'].forEach(l=>p(l,'line-color','#8a6d45'));
  // Route line — bright pink so it pops on grass
  p('route-main','line-color','#ff2f8e');
  p('route-traveled','line-color','#7a1f4a');
  p('route-alts','line-color','#9a5a3a');

  // ── Blockify: make it read like Minecraft geometry, not just its palette ──
  const lay=(layer,prop,val)=>{try{if(map.getLayer(layer)) map.setLayoutProperty(layer,prop,val);}catch{}};
  const style=map.getStyle&&map.getStyle();
  if(style&&style.layers) style.layers.forEach(l=>{
    if(l.id.startsWith('route-')||l.id.startsWith('me_')) return;
    // Hard pixel edges: kill fill anti-aliasing so coastlines/parks/buildings
    // meet the grass in jagged steps instead of smooth curves.
    if(l.type==='fill') p(l.id,'fill-antialias',false);
    // Square road corners + ends — no rounded joins/caps (blocks have right angles).
    if(l.type==='line'){ lay(l.id,'line-join','miter'); lay(l.id,'line-cap','butt'); }
  });

  // Voxel buildings — Minecraft VILLAGE scale, not a city skyline. The previous
  // pass kept real heights (ceil only rounded up), so a CBD became a chaotic wall
  // of tall brown extrusions that buried the road. Now every building is a short
  // flat-shaded cobblestone block, 4–20 m (1–5 blocks) snapped to 4 m steps, and
  // buildings only render from z16 so the distant skyline can't wall off the view.
  const H=['coalesce',['get','render_height'],['get','height'],6];
  const BLOCK=['max',4,['min',20,['*',4,['ceil',['/',H,4]]]]];
  p('3d-buildings','fill-extrusion-color',COBBLE);
  p('3d-buildings','fill-extrusion-height',BLOCK);
  p('3d-buildings','fill-extrusion-base',0);
  p('3d-buildings','fill-extrusion-opacity',1);
  try{ map.setPaintProperty('3d-buildings','fill-extrusion-vertical-gradient',false); }catch{}
  try{ map.setLayerZoomRange('3d-buildings',16,24); }catch{}
}

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
  // GTA V GPS route line — vivid magenta/pink (matches the in-game minimap route)
  tryPaint('route-main','line-color','#ff2ec4');
  tryPaint('route-traveled','line-color','#6d2c5f');
  tryPaint('route-alts','line-color','#5b2a6b');
  // Tweak UI surface too
  document.documentElement.style.setProperty('--surface','#0d1117');
  document.documentElement.style.setProperty('--surface2','#111827');
}

/* ═══════════════════════════════════════════════
   GTA POI BLIPS — icon-per-place on the GTA map only
   Strip club → 👠, Ammu-Nation (gun shop) → 🔫, bar → 🍸, etc.
   Driven by the vector tile `poi` source-layer (OpenMapTiles schema).
═══════════════════════════════════════════════ */
// subclass (OSM-ish tag value) → [emoji, ring colour]
const GTA_POI = {
  stripclub:['👠','#ff2ec4'], nightclub:['🍸','#c026d3'], bar:['🍸','#c026d3'],
  pub:['🍺','#d97706'], biergarten:['🍺','#d97706'], casino:['🎰','#eab308'],
  fast_food:['🍔','#f59e0b'], restaurant:['🍴','#f97316'], cafe:['☕','#a16207'],
  bakery:['🥐','#d97706'], butcher:['🥩','#ef4444'], ice_cream:['🍦','#f472b6'],
  fuel:['⛽','#22c55e'], charging_station:['🔌','#22c55e'],
  hospital:['🏥','#ef4444'], clinic:['🏥','#ef4444'], doctors:['🩺','#ef4444'],
  dentist:['🦷','#38bdf8'], pharmacy:['💊','#10b981'], veterinary:['🐾','#10b981'],
  police:['👮','#3b82f6'], fire_station:['🚒','#ef4444'], prison:['🔒','#94a3b8'],
  hotel:['🛏️','#8b5cf6'], motel:['🛏️','#8b5cf6'], hostel:['🛏️','#8b5cf6'],
  supermarket:['🛒','#22d3ee'], convenience:['🏪','#22d3ee'], mall:['🛍️','#38bdf8'],
  bank:['💰','#eab308'], atm:['💵','#eab308'],
  parking:['🅿️','#3b82f6'],
  cinema:['🎬','#a855f7'], theatre:['🎭','#a855f7'], nightlife:['🍸','#c026d3'],
  hairdresser:['💈','#f472b6'], beauty:['💅','#f472b6'], tattoo:['🎨','#f472b6'],
  clothes:['👕','#38bdf8'], shoes:['👟','#38bdf8'], jewelry:['💍','#eab308'],
  books:['📖','#a16207'], florist:['🌹','#f472b6'], gift:['🎁','#f472b6'],
  car_repair:['🔧','#94a3b8'], car:['🚗','#94a3b8'], car_parts:['🔩','#94a3b8'],
  gym:['💪','#f43f5e'], fitness_centre:['💪','#f43f5e'], swimming_pool:['🏊','#38bdf8'],
  weapons:['🔫','#94a3b8'], hunting:['🔫','#94a3b8'],
  place_of_worship:['⛪','#cbd5e1'], school:['🏫','#fbbf24'], university:['🎓','#fbbf24'],
  college:['🎓','#fbbf24'], library:['📚','#fbbf24'], post_office:['📮','#ef4444'],
  stadium:['🏟️','#22c55e'], pitch:['⚽','#22c55e'], golf_course:['⛳','#22c55e'],
  marina:['⚓','#38bdf8'], zoo:['🦁','#f59e0b'], theme_park:['🎡','#f472b6'],
  laundry:['🧺','#38bdf8'], dry_cleaning:['🧺','#38bdf8'],
};

// Render an emoji onto a GTA-style dark blip with a coloured ring → raw image for addImage.
function makePoiIcon(emoji, color='#0a0a10'){
  const S=64, c=document.createElement('canvas'); c.width=c.height=S;
  const x=c.getContext('2d');
  x.beginPath(); x.arc(S/2,S/2,S/2-5,0,Math.PI*2);
  x.fillStyle='rgba(10,10,16,0.82)'; x.fill();
  x.lineWidth=3.5; x.strokeStyle=color; x.stroke();
  x.font='34px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';
  x.textAlign='center'; x.textBaseline='middle';
  x.fillText(emoji, S/2, S/2+1);
  const d=x.getImageData(0,0,S,S);
  return {width:S, height:S, data:new Uint8Array(d.data.buffer)};
}

function addGtaPoiLayer(){
  try{
    const style=map.getStyle();
    const vsrc=Object.keys(style.sources).find(k=>style.sources[k].type==='vector');
    if(!vsrc) return;
    // Register one blip image per category (idempotent across style reloads)
    for(const [sub,[emoji,color]] of Object.entries(GTA_POI)){
      const id='gp-'+sub;
      if(!map.hasImage(id)){ try{ map.addImage(id, makePoiIcon(emoji,color), {pixelRatio:2}); }catch{} }
    }
    const knownSubs=Object.keys(GTA_POI);
    const iconMatch=['match',['get','subclass']];
    for(const sub of knownSubs) iconMatch.push(sub,'gp-'+sub);
    iconMatch.push('gp-'+knownSubs[0]); // default (never hit — filtered)
    // Prefer a non-italic Regular font stack the style's glyph server actually serves
    let fontStack=['Noto Sans Regular'];
    for(const l of style.layers){
      const f=l.layout&&l.layout['text-font'];
      if(f&&/Regular/.test(f[0])&&!/Italic/.test(f[0])){ fontStack=f; break; }
    }
    if(map.getLayer('gta-poi')) map.removeLayer('gta-poi');
    map.addLayer({
      id:'gta-poi', type:'symbol', source:vsrc, 'source-layer':'poi',
      minzoom:14.5,
      filter:['match',['get','subclass'], knownSubs, true, false],
      layout:{
        'icon-image':iconMatch,
        'icon-size':0.5,
        'icon-allow-overlap':false,
        'symbol-sort-key':['coalesce',['get','rank'],100],
        'text-field':['coalesce',['get','name'],''],
        'text-font':fontStack,
        'text-size':10.5,
        'text-offset':[0,1.3],
        'text-anchor':'top',
        'text-optional':true,
        'text-max-width':8,
      },
      paint:{
        'text-color':'#ffd1f2',
        'text-halo-color':'#1a001a',
        'text-halo-width':1.3,
        'icon-opacity':0.96,
      },
    });
  }catch(e){ console.warn('gta poi layer',e); }
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
    const seg=haversine(prevPos.lat,prevPos.lng,_prevNavPos.lat,_prevNavPos.lng);
    _navDistance+=seg;
    if(seg>0&&seg<2000) window.Game?.onDistance(seg/1000); // daily distance + recording stat
  }
  _prevNavPos=prevPos?{...prevPos}:null;
}

const MIN_BANK_KM=1; // must drive at least 1km before a trip's score counts (anti-gaming)
function showScoreSubmit(){
  if(gta.score<100){ endNav(); return; } // Not worth showing for tiny scores
  const modal=$$('score-modal'); if(!modal) return;
  $$('score-modal-score').textContent=fmtScore(Math.floor(gta.score))+' pts';
  $$('score-modal-stars').textContent='★'.repeat(gta.highStars)+'☆'.repeat(5-gta.highStars);
  const banked=$$('score-modal-banked'), submitBtn=$$('score-modal-submit');
  // Anti-gaming gate: show the fun score, but don't bank a trip under 1km.
  if(_navDistance < MIN_BANK_KM*1000){
    if(banked) banked.innerHTML=`<span style="opacity:.7">Drive at least ${MIN_BANK_KM}km to bank points — this trip was ${(_navDistance/1000).toFixed(2)}km.</span>`;
    if(submitBtn){ submitBtn.textContent='Done'; submitBtn.dataset.mode='done'; }
    modal.classList.remove('hidden');
    return;
  }
  if(currentUser){
    // Auto-bank onto the account total
    if(banked) banked.innerHTML=`Banking to <b>${escHtml(currentUser.username)}</b>…`;
    if(submitBtn){ submitBtn.textContent='Done'; submitBtn.dataset.mode='done'; }
    bankScore();
  } else {
    if(banked) banked.innerHTML=`<span style="opacity:.7">Sign in to bank this score to the leaderboard.</span>`;
    if(submitBtn){ submitBtn.textContent='Sign in & save'; submitBtn.dataset.mode='signin'; }
  }
  modal.classList.remove('hidden');
}

async function bankScore(){
  if(!currentUser) return;
  try{
    const r=await authFetch('/api/auth/score',{method:'POST',
      body:JSON.stringify({score:Math.floor(gta.score),stars:gta.highStars,distance_km:_navDistance/1000})});
    const d=await r.json();
    if(d?.user){
      currentUser=d.user; renderAccountUI();
      const banked=$$('score-modal-banked');
      if(banked) banked.innerHTML=`＋${fmtScore(d.added)} pts · Total <b>${fmtScore(currentUser.score)}</b> 🏆`;
    } else if(d?.error){
      // Backend rejected the bank (e.g. under the 1km distance gate)
      const banked=$$('score-modal-banked');
      if(banked) banked.innerHTML=`<span style="opacity:.7">${escHtml(d.error)}</span>`;
    }
  }catch{ const b=$$('score-modal-banked'); if(b) b.textContent='Could not save (offline?)'; }
}

$$('score-modal-skip').addEventListener('click',()=>{
  $$('score-modal').classList.add('hidden'); _navDistance=0; _prevNavPos=null; endNav();
});
$$('score-modal-submit').addEventListener('click',async()=>{
  const mode=$$('score-modal-submit').dataset.mode;
  if(mode==='signin'){
    // Keep the score pending; open the account modal, bank after login
    _pendingBank=true;
    openAccountModal();
    return;
  }
  $$('score-modal').classList.add('hidden');
  _navDistance=0; _prevNavPos=null;
  endNav();
});

/* ═══════════════════════════════════════════════
   ACCOUNTS
═══════════════════════════════════════════════ */
let currentUser=null, _pendingBank=false;
const TOKEN_KEY='ghost_token';
const authToken=()=>localStorage.getItem(TOKEN_KEY)||'';
function authFetch(url,opts={}){
  const h={'Content-Type':'application/json',...(opts.headers||{})};
  const t=authToken(); if(t) h['Authorization']='Bearer '+t;
  return fetch(url,{...opts,headers:h});
}
async function loadMe(){
  if(!authToken()) return;
  try{
    const r=await authFetch('/api/auth/me');
    if(r.ok){ currentUser=await r.json(); renderAccountUI(); }
    else if(r.status===401){ localStorage.removeItem(TOKEN_KEY); currentUser=null; renderAccountUI(); }
  }catch{}
}
function renderAccountUI(){
  const box=$$('account-box'); if(!box) return;
  if(currentUser){
    box.innerHTML=`<div class="acct-signed">
        <div class="acct-info"><span class="acct-name">🎮 ${escHtml(currentUser.username)}</span>
          <span class="acct-score">🏆 ${fmtScore(currentUser.score||0)} pts · ${currentUser.trips||0} trips</span></div>
        <button id="acct-logout" class="acct-btn-sm">Log out</button>
      </div>`;
    $$('acct-logout').addEventListener('click',logout);
  } else {
    box.innerHTML=`<button id="acct-open" class="acct-btn-primary">👤 Sign in / Create account</button>`;
    $$('acct-open').addEventListener('click',openAccountModal);
  }
}
function openAccountModal(){ $$('account-modal')?.classList.remove('hidden'); setAuthMode('login'); }
function closeAccountModal(){ $$('account-modal')?.classList.add('hidden'); }
function setAuthMode(mode){
  const m=$$('account-modal'); if(!m) return;
  m.dataset.mode=mode;
  $$('am-title').textContent=mode==='login'?'Welcome back':'Create your account';
  $$('am-username').placeholder = mode==='register' ? 'Gamertag — 3–16 letters/numbers' : 'Gamertag or email';
  $$('am-email-row').style.display=mode==='register'?'':'none';
  $$('am-submit').textContent=mode==='login'?'Log in':'Create account';
  $$('am-switch').innerHTML=mode==='login'
    ? `No account? <button id="am-to-register" class="am-link">Create one</button>`
    : `Have an account? <button id="am-to-login" class="am-link">Log in</button>`;
  $$('am-to-register')?.addEventListener('click',()=>setAuthMode('register'));
  $$('am-to-login')?.addEventListener('click',()=>setAuthMode('login'));
  $$('am-error').textContent='';
}
async function submitAuth(){
  const m=$$('account-modal'), mode=m.dataset.mode;
  const username=$$('am-username').value.trim();
  const password=$$('am-password').value;
  const email=$$('am-email').value.trim();
  const err=$$('am-error'); err.textContent='';
  const btn=$$('am-submit'); btn.disabled=true; btn.textContent='…';
  try{
    const url=mode==='login'?'/api/auth/login':'/api/auth/register';
    const body=mode==='login'?{login:username,password}:{username,email,password};
    const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const d=await r.json();
    if(!r.ok){ err.textContent=d.error||'Something went wrong'; return; }
    localStorage.setItem(TOKEN_KEY,d.token);
    currentUser=d.user; renderAccountUI(); closeAccountModal();
    showToast(`Welcome, ${currentUser.username}! 🎮`,2500);
    if(_pendingBank){ _pendingBank=false;
      const sm=$$('score-modal');
      if(sm&&!sm.classList.contains('hidden')){
        $$('score-modal-submit').textContent='Done'; $$('score-modal-submit').dataset.mode='done';
        bankScore();
      }
    }
  }catch{ err.textContent='Network error'; }
  finally{ btn.disabled=false; btn.textContent = mode==='login'?'Log in':'Create account'; }
  // NB: don't call setAuthMode() here — it clears #am-error and would swallow
  // the validation/duplicate message we just showed.
}
async function logout(){
  try{ await authFetch('/api/auth/logout',{method:'DELETE'}); }catch{}
  localStorage.removeItem(TOKEN_KEY); currentUser=null; renderAccountUI();
  showToast('Logged out',1800);
}
$$('am-submit')?.addEventListener('click',submitAuth);
$$('am-close')?.addEventListener('click',closeAccountModal);
$$('account-modal')?.addEventListener('click',e=>{ if(e.target===$$('account-modal')) closeAccountModal(); });
$$('am-password')?.addEventListener('keydown',e=>{ if(e.key==='Enter') submitAuth(); });
renderAccountUI();
loadMe();

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
