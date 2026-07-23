// ═══════════════════════════════════════════════════════════════════════════
//  GHOST — 3D car system (Three.js)
//  • Player car: real glTF model rendered inside the map's 3D space via a
//    MapLibre custom layer. Sits at the GPS point, rotates to heading, lit.
//  • Garage: a standalone "showroom" canvas that auto-spins the selected car
//    so you can view all sides.
//  Assets: Kenney Car Kit (CC0 / public domain).
// ═══════════════════════════════════════════════════════════════════════════
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const MODEL_DIR = '/cars3d/';

// Tunable orientation/scale (adjust live via window.Car3D._tune if needed)
const TUNE = {
  scaleMeters: 14.0,  // apparent car length in metres on the map (smaller = tidier)
  baseDeg: 180,       // model faces +Z; align "forward" with north-up
  sign: -1,           // heading rotation direction (−1 counters the mercator Y-flip)
  refZoom: 18.4,      // car keeps a steady screen size around this zoom
};

// Normalized footprint (map units) for models that need auto-scaling.
const CANON = 2.6;

// Per-model config: tint (recolour body), face (character face sprite),
// normalize (auto scale/centre off-scale models), sizeMul (relative size),
// lift (hover altitude, metres), yaw (orientation offset, degrees).
const MODEL_CFG = {
  // Mario = character already sitting in a kart (single model, footprint-scaled)
  'char-mario.glb':   { normalize: true, sizeMul: 1.15, yaw: 90 },
  // Others = standing character composed INTO a kart (kart hides the legs)
  'char-luigi.glb':   { kart: 'kart-base.glb', kartMul: 1.1, charH: 2.1, charY: 0.0,  charZ: -0.15, yaw: 0 },
  'char-peach.glb':   { kart: 'kart-base.glb', kartMul: 1.1, charH: 2.1, charY: 0.05, charZ: -0.15, yaw: 0 },
  'char-bowser.glb':  { kart: 'kart-base.glb', kartMul: 1.2, charH: 2.2, charY: 0.05, charZ: -0.1,  charYaw: 180, yaw: 0 },
  'char-pikachu.glb': { kart: 'kart-base.glb', kartMul: 1.1, charH: 1.8, charY: 0.1,  charZ: -0.1,  yaw: 0 },
  // Planes — normalize (varied source scales); they hover
  'plane-prop.glb':  { normalize: true, sizeMul: 1.9, lift: 32, yaw: 0 },
  'plane-liner.glb': { normalize: true, sizeMul: 2.3, lift: 40, yaw: 0 },
  'plane-paper.glb': { normalize: true, sizeMul: 1.3, lift: 22, yaw: 180 },
  // Novelty + realistic
  'food/eggplant.glb':    { normalize: true, sizeMul: 1.35, pitch: -90, yaw: 0 }, // lie flat, tip forward
  'ferrari.glb':     { normalize: true, sizeMul: 1.3, yaw: 0 },
  // Realistic fleet (Sketchfab, CC-BY) — normalized; yaw tuned per model
  'sk-pony.glb':       { normalize: true, sizeMul: 1.1,  yaw: 0 },
  'sk-f40.glb':        { normalize: true, sizeMul: 1.1,  yaw: 0 },
  'sk-koenigsegg.glb': { normalize: true, sizeMul: 1.1,  yaw: 0 },
  'sk-phoenix.glb':    { normalize: true, sizeMul: 1.1,  yaw: 90 },
  'sk-copcruiser.glb': { normalize: true, sizeMul: 1.1,  yaw: 90 },
  'sk-cyber.glb':      { normalize: true, sizeMul: 1.1,  yaw: 90 },
  'sk-volvo130.glb':   { normalize: true, sizeMul: 1.05, yaw: 0 },
  'sk-c10pickup.glb':  { normalize: true, sizeMul: 1.15, yaw: 0 },
  'sk-cadillac.glb':   { normalize: true, sizeMul: 1.1,  yaw: 0 },
  'sk-karlmann.glb':   { normalize: true, sizeMul: 1.15, yaw: 90 },
};
const cfgOf = (f) => MODEL_CFG[f] || {};

// ── Shared GLTF loader + model cache ────────────────────────────────────────
const loader = new GLTFLoader();
// Draco support for compressed (often higher-detail/realistic) models
const _draco = new DRACOLoader();
_draco.setDecoderPath('https://unpkg.com/three@0.160.0/examples/jsm/libs/draco/');
loader.setDRACOLoader(_draco);
const modelCache = new Map(); // file -> Promise<THREE.Group>

// ── Character faces — drawn as SVG → texture → sprite on the kart's head ─────
function faceSVG(kind) {
  // Each character is a "bust" (torso drawn first, then head) so the sprite
  // reads as a whole driver sitting in the kart. viewBox 120 x 150.
  const marioLike = (cap, capDark, letter) => {
    const torso = `
      <path d="M28 118 Q60 100 92 118 Q98 138 96 150 L24 150 Q22 138 28 118Z" fill="${cap}"/>
      <path d="M40 116 L46 150" stroke="#2a49a0" stroke-width="8" stroke-linecap="round"/>
      <path d="M80 116 L74 150" stroke="#2a49a0" stroke-width="8" stroke-linecap="round"/>
      <path d="M40 128 Q60 122 80 128 L80 150 L40 150Z" fill="#2a49a0"/>
      <circle cx="49" cy="128" r="3.4" fill="#f7d21a"/><circle cx="71" cy="128" r="3.4" fill="#f7d21a"/>
      <path d="M42 116 Q60 128 78 116" stroke="${capDark}" stroke-width="3" fill="none"/>`;
    const head = `
      <ellipse cx="31" cy="70" rx="8" ry="10" fill="#ffcc99"/><ellipse cx="89" cy="70" rx="8" ry="10" fill="#ffcc99"/>
      <ellipse cx="60" cy="68" rx="30" ry="32" fill="#ffcc99"/>
      <path d="M32 64 Q30 88 42 96 L46 76 Z" fill="#3a2412"/><path d="M88 64 Q90 88 78 96 L74 76 Z" fill="#3a2412"/>
      <path d="M24 56 Q60 12 96 56 Q60 38 24 56 Z" fill="${cap}"/>
      <path d="M22 56 Q60 44 98 56 Q100 65 88 66 Q60 54 32 66 Q20 65 22 56Z" fill="${capDark}"/>
      <circle cx="60" cy="37" r="11" fill="#fff"/>
      <text x="60" y="43" font-size="14" font-weight="900" text-anchor="middle" fill="${cap}" font-family="Arial">${letter}</text>
      <ellipse cx="50" cy="65" rx="5" ry="8" fill="#fff"/><ellipse cx="70" cy="65" rx="5" ry="8" fill="#fff"/>
      <circle cx="51" cy="67" r="3" fill="#2a3a6a"/><circle cx="69" cy="67" r="3" fill="#2a3a6a"/>
      <circle cx="60" cy="78" r="8" fill="#ffb88a"/>
      <path d="M40 84 Q50 94 60 88 Q70 94 80 84 Q74 96 60 94 Q46 96 40 84Z" fill="#3a2412"/>`;
    return torso + head;
  };
  const inner = {
    mario: marioLike('#e11d1d', '#b81212', 'M'),
    luigi: marioLike('#25a025', '#1c7c1c', 'L'),
    peach: `
      <path d="M26 120 Q60 102 94 120 Q100 138 100 150 L20 150 Q20 138 26 120Z" fill="#f6a5c0"/>
      <circle cx="60" cy="124" r="4.5" fill="#2a6ad0"/>
      <path d="M28 52 Q28 104 46 108 Q40 74 60 70 Q80 74 74 108 Q92 104 92 52 Q60 22 28 52Z" fill="#f4d03f"/>
      <ellipse cx="60" cy="68" rx="26" ry="30" fill="#ffe0c0"/>
      <path d="M34 54 Q40 66 46 56 Q52 68 60 56 Q68 68 74 56 Q80 66 86 54 Q60 40 34 54Z" fill="#f6d64a"/>
      <path d="M44 32 L48 42 L60 36 L72 42 L76 32 L72 24 L66 30 L60 22 L54 30 L48 24Z" fill="#ffd24a" stroke="#e0a500" stroke-width="1"/>
      <circle cx="60" cy="32" r="2.6" fill="#e74c9b"/><circle cx="50" cy="32" r="2" fill="#4aa3e7"/><circle cx="70" cy="32" r="2" fill="#4aa3e7"/>
      <ellipse cx="51" cy="66" rx="4.5" ry="7" fill="#fff"/><ellipse cx="69" cy="66" rx="4.5" ry="7" fill="#fff"/>
      <circle cx="51" cy="68" r="3" fill="#2a6ad0"/><circle cx="69" cy="68" r="3" fill="#2a6ad0"/>
      <circle cx="44" cy="76" r="4" fill="#ffb0c0" opacity=".7"/><circle cx="76" cy="76" r="4" fill="#ffb0c0" opacity=".7"/>
      <path d="M54 84 Q60 89 66 84 Q60 86 54 84Z" fill="#e0507a"/>`,
    bowser: `
      <path d="M28 120 Q60 104 92 120 L98 150 L22 150Z" fill="#3a9a3a"/>
      <ellipse cx="60" cy="140" rx="22" ry="14" fill="#e2c24a"/>
      <path d="M60 26 Q26 32 24 68 Q20 98 44 102 Q30 72 60 68 Q90 72 76 102 Q100 98 96 68 Q94 32 60 26Z" fill="#e2622a"/>
      <ellipse cx="60" cy="68" rx="30" ry="30" fill="#8bd24a"/>
      <path d="M36 46 L28 30 L46 42Z" fill="#f2ead2"/><path d="M84 46 L92 30 L74 42Z" fill="#f2ead2"/>
      <path d="M42 56 L56 62" stroke="#2a6a1a" stroke-width="4" stroke-linecap="round"/><path d="M78 56 L64 62" stroke="#2a6a1a" stroke-width="4" stroke-linecap="round"/>
      <ellipse cx="50" cy="64" rx="4" ry="5" fill="#fff"/><ellipse cx="70" cy="64" rx="4" ry="5" fill="#fff"/>
      <circle cx="51" cy="65" r="2.4" fill="#c0202a"/><circle cx="69" cy="65" r="2.4" fill="#c0202a"/>
      <ellipse cx="60" cy="81" rx="16" ry="11" fill="#c8e88a"/>
      <circle cx="54" cy="79" r="1.6" fill="#3a5a2a"/><circle cx="66" cy="79" r="1.6" fill="#3a5a2a"/>
      <path d="M48 87 Q60 95 72 87" stroke="#2a4a1a" stroke-width="2" fill="none"/>
      <path d="M52 87 L50 93 L56 87Z" fill="#fff"/><path d="M68 87 L70 93 L64 87Z" fill="#fff"/>`,
    pikachu: `
      <path d="M32 122 Q60 108 88 122 L90 150 L30 150Z" fill="#f6c915"/>
      <path d="M40 46 L26 14 Q22 10 30 14 L48 42Z" fill="#f6c915"/><path d="M22 22 L26 14 L34 20Z" fill="#2a2a2a"/>
      <path d="M80 46 L94 14 Q98 10 90 14 L72 42Z" fill="#f6c915"/><path d="M98 22 L94 14 L86 20Z" fill="#2a2a2a"/>
      <ellipse cx="60" cy="72" rx="32" ry="28" fill="#f6c915"/>
      <circle cx="40" cy="78" r="8" fill="#e2402a"/><circle cx="80" cy="78" r="8" fill="#e2402a"/>
      <circle cx="50" cy="68" r="6" fill="#2a2a2a"/><circle cx="70" cy="68" r="6" fill="#2a2a2a"/>
      <circle cx="52" cy="66" r="2" fill="#fff"/><circle cx="72" cy="66" r="2" fill="#fff"/>
      <circle cx="60" cy="74" r="1.8" fill="#2a2a2a"/>
      <path d="M54 80 Q60 86 66 80" stroke="#2a2a2a" stroke-width="2" fill="none"/>`,
  }[kind] || '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 150">${inner}</svg>`;
}

const _faceCache = new Map();
function faceTexture(kind) {
  if (_faceCache.has(kind)) return _faceCache.get(kind);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const img = new Image();
  img.onload = () => {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, 256, 256);
    ctx.drawImage(img, 0, 0, 256, 256);
    tex.needsUpdate = true;
    if (player.map) player.map.triggerRepaint();
  };
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(faceSVG(kind));
  _faceCache.set(kind, tex);
  return tex;
}
function addFaceSprite(group, kind) {
  // A forward-facing plane (NOT a billboard) so the character turns WITH the kart
  // and faces the driving direction. Double-sided so it's visible from behind too.
  const mat = new THREE.MeshBasicMaterial({ map: faceTexture(kind), transparent: true, side: THREE.DoubleSide, depthWrite: false, toneMapped: false });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.86, 1.08), mat);
  mesh.position.set(0, 0.42, -0.02);  // seated at head height, facing +Z (kart forward)
  mesh.renderOrder = 5;
  group.add(mesh);
}

// Reflective materials on every mesh.
function applyMats(obj) {
  obj.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    o.castShadow = false; o.receiveShadow = false;
    const m = o.material;
    if ('metalness' in m) m.metalness = Math.max(m.metalness ?? 0, 0.3);
    if ('roughness' in m) m.roughness = Math.min(m.roughness ?? 1, 0.5);
    m.envMapIntensity = 1.2;
  });
}
// Scale an object so its footprint (or height) == target, centre x/z, sit on ground.
function fitObj(obj, target, mode) {
  obj.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(obj);
  const size = box.getSize(new THREE.Vector3());
  const ctr = box.getCenter(new THREE.Vector3());
  const ref = (mode === 'height' ? size.y : Math.max(size.x, size.z)) || 1;
  obj.position.set(-ctr.x, -box.min.y, -ctr.z);
  const g = new THREE.Group();
  g.add(obj);
  g.scale.setScalar(target / ref);
  return g;
}
const loadRaw = (file) => new Promise((res, rej) => loader.load(MODEL_DIR + file, (g) => res(g.scene), undefined, rej));

function loadModel(file) {
  if (!modelCache.has(file)) {
    const cfg = cfgOf(file);
    let promise;

    if (cfg.kart) {
      // Compose: seat a standing character into a kart (kart hides the legs).
      promise = Promise.all([loadRaw(cfg.kart), loadRaw(file)]).then(([kart, char]) => {
        // Hide the kart's built-in blank driver — our character replaces it
        kart.traverse((o) => { if (o.isMesh && /character|driver/i.test(o.name || '')) o.visible = false; });
        applyMats(kart); applyMats(char);
        const kartG = fitObj(kart, CANON * (cfg.kartMul || 1), 'foot');
        const charG = fitObj(char, (cfg.charH || 1.6), 'height');
        if (cfg.charYaw) charG.rotation.y += cfg.charYaw * Math.PI / 180;
        charG.position.set(cfg.charX || 0, cfg.charY || 0, cfg.charZ || 0);
        let out = new THREE.Group();
        out.add(kartG); out.add(charG);
        if (cfg.yaw) { const w = new THREE.Group(); w.add(out); w.rotation.y = cfg.yaw * Math.PI / 180; out = w; }
        return out;
      });
    } else {
      promise = new Promise((resolve, reject) => {
        loader.load(MODEL_DIR + file, (gltf) => {
          let out = gltf.scene;
          if (cfg.pitch || cfg.yaw) {
            const g = new THREE.Group();
            g.add(out);
            if (cfg.pitch) g.rotation.x = cfg.pitch * Math.PI / 180;
            if (cfg.yaw)   g.rotation.y = cfg.yaw * Math.PI / 180;
            out = g;
          }
          if (cfg.normalize) {
            const ref = cfg.normMode || 'foot';
            out = fitObj(out, CANON * (cfg.sizeMul || 1), ref === 'height' ? 'height' : 'foot');
          }
          applyMats(out);
          resolve(out);
        }, undefined, reject);
      });
    }
    modelCache.set(file, promise);
  }
  // Return a fresh clone each time so map + showroom don't share a node
  return modelCache.get(file).then((root) => root.clone(true));
}

// PMREM environment → soft reflections that make the paint read as real.
let _envTex = null;
function ensureEnv(renderer, scene) {
  if (!_envTex) {
    try { _envTex = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture; }
    catch (e) { return; }
  }
  scene.environment = _envTex;
}

function addLights(scene) {
  const hemi = new THREE.HemisphereLight(0xffffff, 0x2a3550, 1.1);
  scene.add(hemi);
  const key = new THREE.DirectionalLight(0xffffff, 1.7);
  key.position.set(0.6, 1.2, 0.8);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x88bbff, 0.6);
  rim.position.set(-0.7, 0.5, -0.9);
  scene.add(rim);
}

// ═══════════════════════════════════════════════════════════════════════════
//  MAP LAYER — player car in the map's 3D world
// ═══════════════════════════════════════════════════════════════════════════
const MERC = () => window.maplibregl.MercatorCoordinate;

const player = {
  lng: 151.2093, lat: -33.8688, headingDeg: 0, lift: 0,
  visible: false, modelFile: 'sedan-sports.glb',
  pivot: null, scene: null, camera: null, renderer: null, map: null,
  loadingToken: 0,
};

function makeCustomLayer(map) {
  return {
    id: 'player-car-3d',
    type: 'custom',
    renderingMode: '3d',
    onAdd(_map, gl) {
      player.map = _map;
      player.camera = new THREE.Camera();
      player.scene = new THREE.Scene();
      addLights(player.scene);
      player.pivot = new THREE.Group();
      player.scene.add(player.pivot);
      player.renderer = new THREE.WebGLRenderer({
        canvas: _map.getCanvas(),
        context: gl,
        antialias: true,
      });
      player.renderer.autoClear = false;
      ensureEnv(player.renderer, player.scene);
      swapModel(player.modelFile);
    },
    render(_gl, matrix) {
      if (!player.visible || !player.pivot) { return; }
      const Merc = MERC();
      const merc = Merc.fromLngLat([player.lng, player.lat], player.lift || 0);
      // Keep the car a steady on-screen size as the map zooms with speed
      // (map screen-scale ∝ 2^zoom, so counter it around a reference zoom).
      const zoomComp = Math.min(2.0, Math.max(0.45, Math.pow(2, TUNE.refZoom - player.map.getZoom())));
      const s = merc.meterInMercatorCoordinateUnits() * TUNE.scaleMeters * zoomComp;
      const headingRad = (TUNE.sign * player.headingDeg + TUNE.baseDeg) * Math.PI / 180;
      const l = new THREE.Matrix4()
        .makeTranslation(merc.x, merc.y, merc.z)
        .multiply(new THREE.Matrix4().makeScale(s, -s, s))
        .multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2))
        .multiply(new THREE.Matrix4().makeRotationY(headingRad));
      player.camera.projectionMatrix = new THREE.Matrix4().fromArray(matrix).multiply(l);
      player.renderer.resetState();
      player.renderer.render(player.scene, player.camera);
      // keep animating while visible (heading/pos interpolation happens in app.js)
    },
  };
}

function swapModel(file) {
  player.lift = cfgOf(file).lift || 0;
  if (!player.pivot) { player.modelFile = file; return; }
  const token = ++player.loadingToken;
  loadModel(file).then((model) => {
    if (token !== player.loadingToken || !player.pivot) { return; }
    // clear old
    for (let i = player.pivot.children.length - 1; i >= 0; i--) {
      player.pivot.remove(player.pivot.children[i]);
    }
    player.pivot.add(model);
    player.modelFile = file;
    if (player.map) { player.map.triggerRepaint(); }
  }).catch((e) => console.warn('[Car3D] model load failed', file, e));
}

// ═══════════════════════════════════════════════════════════════════════════
//  SHOWROOM — standalone spinning preview (garage)
// ═══════════════════════════════════════════════════════════════════════════
function mountShowroom(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  const scene = new THREE.Scene();
  addLights(scene);
  ensureEnv(renderer, scene);
  const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 200);
  camera.position.set(3.4, 2.4, 4.2);
  camera.lookAt(0, 0.4, 0);

  const pivot = new THREE.Group();
  scene.add(pivot);

  let raf = null, dragging = false, lastX = 0, spin = true, yaw = 0, token = 0;
  let _lastW = 0, _lastH = 0;

  function resize() {
    const w = canvas.clientWidth || 300, h = canvas.clientHeight || 200;
    _lastW = w; _lastH = h;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  function setModel(file) {
    const t = ++token;
    for (let i = pivot.children.length - 1; i >= 0; i--) pivot.remove(pivot.children[i]);
    loadModel(file).then((m) => {
      if (t !== token) return;
      pivot.add(m);
      // Auto-frame: fit the camera to whatever model this is (cars vs big planes).
      const box = new THREE.Box3().setFromObject(m);
      const size = box.getSize(new THREE.Vector3());
      const ctr = box.getCenter(new THREE.Vector3());
      m.position.x -= ctr.x; m.position.z -= ctr.z; // centre horizontally
      const r = Math.max(size.x, size.y, size.z) || 2.5;
      const d = r * 1.9;
      camera.position.set(d * 0.62, d * 0.42, d * 0.85);
      camera.lookAt(0, size.y * 0.35, 0);
      camera.updateProjectionMatrix();
    });
  }

  function frame() {
    // Auto-resize when the (initially hidden) garage panel becomes visible
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (w && h && (w !== _lastW || h !== _lastH)) resize();
    if (spin && !dragging) yaw += 0.012;
    pivot.rotation.y = yaw;
    renderer.render(scene, camera);
    raf = requestAnimationFrame(frame);
  }

  // drag to rotate
  const onDown = (e) => { dragging = true; spin = false; lastX = (e.touches ? e.touches[0].clientX : e.clientX); };
  const onMove = (e) => {
    if (!dragging) return;
    const x = (e.touches ? e.touches[0].clientX : e.clientX);
    yaw += (x - lastX) * 0.01; lastX = x;
  };
  const onUp = () => { dragging = false; };
  canvas.addEventListener('mousedown', onDown);
  canvas.addEventListener('touchstart', onDown, { passive: true });
  window.addEventListener('mousemove', onMove);
  canvas.addEventListener('touchmove', onMove, { passive: true });
  window.addEventListener('mouseup', onUp);
  canvas.addEventListener('touchend', onUp);

  resize();
  window.addEventListener('resize', resize);
  frame();

  return {
    setModel,
    resize,
    setSpin(v) { spin = v; },
    setYaw(v) { yaw = v; },
    render() { renderer.render(scene, camera); },
    dispose() {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('resize', resize);
      renderer.dispose();
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
//  PUBLIC API
// ═══════════════════════════════════════════════════════════════════════════
let _initDone = false;

function init(map) {
  if (_initDone) return;
  _initDone = true;
  const add = () => {
    if (!map.getLayer('player-car-3d')) map.addLayer(makeCustomLayer(map));
    else try { map.moveLayer('player-car-3d'); } catch (_) {}
  };
  if (map.isStyleLoaded()) add(); else map.once('load', add);
  // re-add layer after any style swap (basemap change removes custom layers)
  map.on('styledata', () => { try { add(); } catch (_) {} });
}

window.Car3D = {
  init,
  setModel(file) { swapModel(file); },
  setPos(lng, lat, headingDeg) {
    player.lng = lng; player.lat = lat;
    if (headingDeg != null) player.headingDeg = headingDeg;
    if (player.visible && player.map) player.map.triggerRepaint();
  },
  show() { player.visible = true; if (player.map) player.map.triggerRepaint(); },
  hide() { player.visible = false; if (player.map) player.map.triggerRepaint(); },
  isVisible() { return player.visible; },
  mountShowroom,
  _tune: TUNE,
};

// Auto-init against the map created by app.js
if (window.ghostMap) init(window.ghostMap);
else window.addEventListener('ghostmap-ready', () => init(window.ghostMap), { once: true });
