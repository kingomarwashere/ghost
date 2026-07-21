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

const MODEL_DIR = '/cars3d/';

// Tunable orientation/scale (adjust live via window.Car3D._tune if needed)
const TUNE = {
  scaleMeters: 6.0,   // apparent car length in metres on the map (chunky = readable)
  baseDeg: 180,       // model faces +Z; align "forward" with north-up
  sign: 1,            // heading rotation direction
};

// ── Shared GLTF loader + model cache ────────────────────────────────────────
const loader = new GLTFLoader();
const modelCache = new Map(); // file -> Promise<THREE.Group>

function loadModel(file) {
  if (!modelCache.has(file)) {
    modelCache.set(file, new Promise((resolve, reject) => {
      loader.load(MODEL_DIR + file, (gltf) => {
        const root = gltf.scene;
        root.traverse((o) => {
          if (o.isMesh) {
            o.castShadow = false;
            o.receiveShadow = false;
            if (o.material) {
              o.material.metalness = 0.1;
              o.material.roughness = 0.6;
            }
          }
        });
        resolve(root);
      }, undefined, reject);
    }));
  }
  // Return a fresh clone each time so map + showroom don't share a node
  return modelCache.get(file).then((root) => root.clone(true));
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
  lng: 151.2093, lat: -33.8688, headingDeg: 0,
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
      swapModel(player.modelFile);
    },
    render(_gl, matrix) {
      if (!player.visible || !player.pivot) { return; }
      const Merc = MERC();
      const merc = Merc.fromLngLat([player.lng, player.lat], 0);
      const s = merc.meterInMercatorCoordinateUnits() * TUNE.scaleMeters;
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
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  const scene = new THREE.Scene();
  addLights(scene);
  const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
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
  const add = () => { if (!map.getLayer('player-car-3d')) map.addLayer(makeCustomLayer(map)); };
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
