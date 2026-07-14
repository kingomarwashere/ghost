/* ── Map init ─────────────────────────────────── */
const map = L.map('map', {
  center: [-27.5, 133.5],  // Australia center
  zoom: 5,
  zoomControl: false,
});

L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
  attribution: '©OpenStreetMap ©CartoDB',
  subdomains: 'abcd',
  maxZoom: 20,
}).addTo(map);

L.control.zoom({ position: 'bottomleft' }).addTo(map);

// Try to geolocate user to Australia or wherever they are
map.locate({ setView: true, maxZoom: 13, timeout: 8000 });

/* ── Layer groups ─────────────────────────────── */
const reportCluster = L.markerClusterGroup({ maxClusterRadius: 40, disableClusteringAtZoom: 15 });
const cameraCluster = L.markerClusterGroup({ maxClusterRadius: 60, disableClusteringAtZoom: 14 });
map.addLayer(reportCluster);
map.addLayer(cameraCluster);

/* ── Icons ────────────────────────────────────── */
function makeIcon(emoji, color = '#ff4545') {
  return L.divIcon({
    html: `<div style="background:${color};width:34px;height:34px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:16px;box-shadow:0 2px 8px rgba(0,0,0,0.5);border:2px solid rgba(255,255,255,0.2)">${emoji}</div>`,
    className: '',
    iconSize: [34, 34],
    iconAnchor: [17, 17],
    popupAnchor: [0, -20],
  });
}

const ICONS = {
  police:     makeIcon('🚔', '#ff4545'),
  speed_trap: makeIcon('📸', '#ff8c00'),
  accident:   makeIcon('⚠️', '#ffcc00'),
  hazard:     makeIcon('🚧', '#ff8c00'),
  speed:      makeIcon('📷', '#3b82f6'),
  red_light:  makeIcon('🔴', '#ef4444'),
  average_speed: makeIcon('📡', '#8b5cf6'),
};

/* ── State ────────────────────────────────────── */
let visibleLayers = { police: true, speed: true, red_light: true };
let pendingLat = null, pendingLng = null;
let selectedType = 'police';
let activeReports = new Map();   // id → marker
let fetchTimeout = null;

/* ── Fetch & render reports ─────────────────────── */
async function loadReports() {
  if (map.getZoom() < 10) return;
  const b = map.getBounds();
  const params = new URLSearchParams({
    swlat: b.getSouth(), swlng: b.getWest(),
    nelat: b.getNorth(), nelng: b.getEast(),
  });

  try {
    const res = await fetch(`/api/reports?${params}`);
    if (!res.ok) return;
    const data = await res.json();

    reportCluster.clearLayers();
    activeReports.clear();

    const reportTypes = ['police', 'speed_trap', 'accident', 'hazard'];
    for (const r of data) {
      if (!visibleLayers.police && reportTypes.includes(r.type)) continue;

      const icon = ICONS[r.type] ?? ICONS.police;
      const age = Math.round((Date.now() - r.created_at) / 60000);
      const marker = L.marker([r.lat, r.lng], { icon })
        .bindPopup(reportPopupHtml(r, age));
      reportCluster.addLayer(marker);
      activeReports.set(r.id, marker);
    }

    document.getElementById('report-count').textContent = `${data.length} report${data.length !== 1 ? 's' : ''}`;
  } catch (e) {
    console.error('load reports failed', e);
  }
}

function reportPopupHtml(r, ageMin) {
  const label = { police: '🚔 Police', speed_trap: '📸 Speed trap', accident: '⚠️ Accident', hazard: '🚧 Hazard' }[r.type] ?? r.type;
  const ageStr = ageMin < 60 ? `${ageMin}m ago` : `${Math.round(ageMin / 60)}h ago`;
  return `
    <strong>${label}</strong>
    ${r.description ? `<p>${escHtml(r.description)}</p>` : ''}
    <p>${ageStr} · ✅ ${r.confirms} 👎 ${r.denies}</p>
    <div class="popup-actions">
      <button class="popup-confirm" onclick="vote('${r.id}','confirm')">✅ Still there</button>
      <button class="popup-deny" onclick="vote('${r.id}','deny')">👎 Gone</button>
    </div>
  `;
}

function escHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

window.vote = async function(id, action) {
  try {
    await fetch(`/api/reports/${id}/${action}`, { method: 'POST' });
    loadReports();
  } catch {}
};

/* ── Fetch & render cameras ─────────────────────── */
async function loadCameras() {
  if (map.getZoom() < 11) { cameraCluster.clearLayers(); return; }
  const b = map.getBounds();
  const params = new URLSearchParams({
    swlat: b.getSouth(), swlng: b.getWest(),
    nelat: b.getNorth(), nelng: b.getEast(),
  });

  try {
    const res = await fetch(`/api/cameras?${params}`);
    if (!res.ok) return;
    const data = await res.json();

    cameraCluster.clearLayers();

    for (const cam of data) {
      if (cam.type === 'speed' && !visibleLayers.speed) continue;
      if ((cam.type === 'red_light' || cam.type === 'average_speed') && !visibleLayers.red_light) continue;

      const icon = ICONS[cam.type] ?? ICONS.speed;
      const label = { speed: '📷 Speed camera', red_light: '🔴 Red light camera', average_speed: '📡 Avg speed' }[cam.type] ?? cam.type;
      const popup = `
        <strong>${label}</strong>
        ${cam.road ? `<p>📍 ${escHtml(cam.road)}</p>` : ''}
        ${cam.speed_limit ? `<p>⚡ ${cam.speed_limit} km/h zone</p>` : ''}
        ${cam.state ? `<p>📌 ${cam.state}</p>` : ''}
        <p style="color:#555;font-size:0.7rem">Source: ${cam.source.toUpperCase()}</p>
      `;
      L.marker([cam.lat, cam.lng], { icon }).bindPopup(popup);
      cameraCluster.addLayer(L.marker([cam.lat, cam.lng], { icon }).bindPopup(popup));
    }
  } catch (e) {
    console.error('load cameras failed', e);
  }
}

/* ── Map events ─────────────────────────────────── */
function scheduleFetch() {
  clearTimeout(fetchTimeout);
  fetchTimeout = setTimeout(() => { loadReports(); loadCameras(); }, 300);
}

map.on('moveend', scheduleFetch);
map.on('zoomend', scheduleFetch);
map.on('load', scheduleFetch);
scheduleFetch();

// Auto-refresh reports every 90s
setInterval(loadReports, 90_000);

/* ── Layer filter buttons ───────────────────────── */
document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const layer = btn.dataset.layer;
    visibleLayers[layer] = !visibleLayers[layer];
    btn.classList.toggle('active', visibleLayers[layer]);
    loadReports();
    loadCameras();
  });
});

/* ── Report flow ─────────────────────────────────── */
const reportBtn = document.getElementById('report-btn');
const modalOverlay = document.getElementById('modal-overlay');
const cancelBtn = document.getElementById('cancel-btn');
const submitBtn = document.getElementById('submit-btn');
const modalCoords = document.getElementById('modal-coords');
const descInput = document.getElementById('desc-input');

reportBtn.addEventListener('click', () => {
  // Use map center as default location
  const c = map.getCenter();
  pendingLat = c.lat;
  pendingLng = c.lng;
  modalCoords.textContent = `📍 ${c.lat.toFixed(5)}, ${c.lng.toFixed(5)} (map centre)`;
  descInput.value = '';
  // Reset type selection
  document.querySelectorAll('.type-btn').forEach(b => b.classList.remove('active'));
  document.querySelector('.type-btn[data-type="police"]').classList.add('active');
  selectedType = 'police';
  modalOverlay.classList.remove('hidden');
});

// Also allow clicking map to set pin location
map.on('click', (e) => {
  if (!modalOverlay.classList.contains('hidden')) {
    pendingLat = e.latlng.lat;
    pendingLng = e.latlng.lng;
    modalCoords.textContent = `📍 ${pendingLat.toFixed(5)}, ${pendingLng.toFixed(5)} (tap location)`;
  }
});

document.querySelectorAll('.type-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.type-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    selectedType = btn.dataset.type;
  });
});

cancelBtn.addEventListener('click', () => { modalOverlay.classList.add('hidden'); });
modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) modalOverlay.classList.add('hidden'); });

submitBtn.addEventListener('click', async () => {
  if (pendingLat == null) return;
  submitBtn.disabled = true;
  submitBtn.textContent = 'Submitting…';

  try {
    const res = await fetch('/api/reports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lat: pendingLat,
        lng: pendingLng,
        type: selectedType,
        description: descInput.value.trim() || undefined,
      }),
    });

    if (res.ok) {
      modalOverlay.classList.add('hidden');
      map.setView([pendingLat, pendingLng], Math.max(map.getZoom(), 14));
      await loadReports();
    } else {
      const err = await res.json();
      alert(err.error ?? 'Failed to submit report');
    }
  } catch {
    alert('Network error, please try again');
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Submit';
  }
});
