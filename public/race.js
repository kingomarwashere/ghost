/* ═══════════════════════════════════════════════════════════════════════════
   GHOST — Race mode (classic script, loaded after app.js)
   Two players link via a 4-char code / share link and race to the same finish.
   Backed by /api/race (D1, polled). Bridges to app.js via window.ghostRace.
═══════════════════════════════════════════════════════════════════════════ */
(() => {
  const B = () => window.ghostRace;
  const $ = (id) => document.getElementById(id);
  const R = 6371000;
  const haversine = (a, b, c, d) => {
    const p = Math.PI / 180, la = a * p, lc = c * p;
    const x = Math.sin((c - a) * p / 2) ** 2 + Math.cos(la) * Math.cos(lc) * Math.sin((d - b) * p / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  };
  const fmtKm = (m) => m >= 1000 ? (m / 1000).toFixed(1) + ' km' : Math.round(m) + ' m';
  const api = (path, body) => fetch('/api/race' + path, body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : {}).then(r => r.json());

  let race = null; // {code, playerId, isHost, dest, oppMarker, starts:{}, finished, resultShown}
  let _lastPush = 0, _lastPoll = 0, _polling = false;

  // ── UI (injected) ───────────────────────────────────────────────────────────
  function ui() {
    if ($('race-invite')) return;
    const el = document.createElement('div');
    el.innerHTML = `
      <div id="race-invite" class="race-modal hidden">
        <div class="race-card">
          <div class="race-card-head"><span>🏁 Race a friend</span><button id="race-invite-close" class="race-x">✕</button></div>
          <p class="race-sub">Send this to a mate. First to the finish wins. Loser gets roasted.</p>
          <div id="race-code" class="race-code">----</div>
          <div class="race-btns">
            <button id="race-copy" class="race-btn race-btn-pink">🔗 Copy link</button>
            <button id="race-share" class="race-btn">📤 Share</button>
          </div>
          <div id="race-players" class="race-players"></div>
          <button id="race-start-btn" class="race-btn race-btn-pink" style="width:100%;margin-top:6px;display:none">🚦 START RACE</button>
          <div id="race-hint" class="race-hint">Share the code — a START button appears once they join.</div>
        </div>
      </div>
      <div id="race-countdown" class="hidden"></div>
      <div id="race-vs" class="hidden">
        <div class="race-vs-title">🏁 <span id="race-vs-name">Race</span></div>
        <div class="race-vs-row" data-who="me"><span class="race-vs-lbl" id="race-vs-me-lbl">You</span><div class="race-vs-bar"><span id="race-vs-me"></span></div><span class="race-vs-d" id="race-vs-me-d">–</span></div>
        <div class="race-vs-row" data-who="opp"><span class="race-vs-lbl" id="race-vs-opp-lbl">Rival</span><div class="race-vs-bar"><span id="race-vs-opp"></span></div><span class="race-vs-d" id="race-vs-opp-d">–</span></div>
      </div>
      <div id="race-result" class="race-modal hidden">
        <div class="race-card race-result-card">
          <div id="race-result-emoji" class="race-result-emoji">🏆</div>
          <div id="race-result-title" class="race-result-title">YOU WON</div>
          <div id="race-result-line" class="race-result-line"></div>
          <button id="race-result-close" class="race-btn race-btn-pink" style="margin-top:14px">Done</button>
        </div>
      </div>`;
    document.body.appendChild(el);
    $('race-invite-close').onclick = () => $('race-invite').classList.add('hidden');
    $('race-copy').onclick = copyLink;
    $('race-share').onclick = shareLink;
    $('race-start-btn').onclick = startRace;
    $('race-result-close').onclick = () => $('race-result').classList.add('hidden');
  }

  async function startRace() {
    if (!race) return;
    $('race-start-btn').disabled = true;
    const res = await api(`/${race.code}/start`, {});
    if (res.started_at) beginCountdown(res.started_at);
  }

  // Synced 3-2-1-GO countdown, then auto-launch nav for both racers.
  function beginCountdown(startAt) {
    if (race.cdActive) return;
    race.cdActive = true; race.startAt = startAt;
    $('race-invite')?.classList.add('hidden');
    const cd = $('race-countdown'); cd.classList.remove('hidden');
    let lastShown = null;
    const tick = () => {
      const left = (race.startAt - Date.now()) / 1000;
      if (left > 0.05) {
        const n = Math.ceil(left);
        cd.textContent = n; cd.className = 'cd-num';
        if (n !== lastShown) { lastShown = n; void cd.offsetWidth; cd.classList.add('cd-pop'); if (window.prefs?.haptic && navigator.vibrate) navigator.vibrate(40); }
        setTimeout(tick, 90);
      } else {
        cd.textContent = 'GO!'; cd.className = 'cd-num cd-go';
        if (!race.launched) { race.launched = true; B()?.go?.(); if (window.prefs?.haptic && navigator.vibrate) navigator.vibrate([80, 40, 160]); }
        setTimeout(() => cd.classList.add('hidden'), 1000);
      }
    };
    tick();
  }

  const link = () => `${location.origin}/?race=${race?.code}`;
  function copyLink() {
    navigator.clipboard?.writeText(link()).then(() => toast('Link copied')).catch(() => {});
  }
  async function shareLink() {
    const text = `Race me on GHOST 🏁 — code ${race.code}`;
    if (navigator.share) { try { await navigator.share({ title: 'GHOST race', text, url: link() }); return; } catch {} }
    copyLink();
  }
  function toast(msg) {
    if (window.Game?.openDaily) {} // noop guard
    let t = $('race-toast');
    if (!t) { t = document.createElement('div'); t.id = 'race-toast'; document.body.appendChild(t); }
    t.textContent = msg; t.classList.add('show');
    clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 2500);
  }

  // ── Create / join ─────────────────────────────────────────────────────────
  async function createFromRoute() {
    const dest = B()?.dest();
    if (!dest) { toast('Pick a destination first'); return; }
    ui();
    const res = await api('', { dest_lat: dest.lat, dest_lng: dest.lng, dest_name: dest.name, name: myName(), car: B().car() });
    if (!res.code) { toast('Could not start race'); return; }
    race = { code: res.code, playerId: res.player_id, isHost: true, dest, starts: {}, finished: false };
    $('race-code').textContent = race.code;
    $('race-invite').classList.remove('hidden');
    renderPlayers([]);
    startPolling();
  }

  async function join(code) {
    ui();
    const res = await api(`/${code}/join`, { name: myName(), car: B()?.car() || '' });
    if (res.error || !res.dest) { toast('Race not found'); return; }
    race = { code: res.code, playerId: res.player_id, isHost: false, dest: res.dest, starts: {}, finished: false };
    // route the joiner to the finish + show the preview so they can hit "Go now"
    B().routeTo(res.dest.lat, res.dest.lng, res.dest.name || 'Finish');
    toast(`🏁 Joined race ${race.code} — drive to the finish!`);
    startPolling();
  }

  const myName = () => (localStorage.getItem('radar_name') || localStorage.getItem('ghost_name') || 'You').slice(0, 16);

  // ── Live loop ─────────────────────────────────────────────────────────────
  function tick(lat, lng) {
    if (!race || B()?.navState() !== 'navigating') return;
    const now = Date.now();
    const distToFinish = haversine(lat, lng, race.dest.lat, race.dest.lng);
    if (now - _lastPush > 2000) {
      _lastPush = now;
      api(`/${race.code}/update`, { player_id: race.playerId, lat, lng, dist: Math.round(distToFinish) });
    }
    if (now - _lastPoll > 2000) poll();
  }

  function startPolling() { if (!_polling) { _polling = true; poll(); } }
  async function poll() {
    if (!race) return;
    _lastPoll = Date.now();
    let s; try { s = await api(`/${race.code}`); } catch { schedulePoll(); return; }
    if (!s || s.error) { schedulePoll(); return; }
    race.host_id = s.host_id;
    const me = s.players.find(p => p.player_id === race.playerId);
    const opp = s.players.find(p => p.player_id !== race.playerId);
    if ($('race-invite') && !$('race-invite').classList.contains('hidden')) renderPlayers(s.players);
    // Host pressed START → synced countdown for everyone
    if (s.started_at && Date.now() < s.started_at + 1500 && !race.cdActive && !race.launched) beginCountdown(s.started_at);
    updateVs(me, opp);
    updateOppMarker(opp);
    if (s.winner_id && !race.resultShown) showResult(s.winner_id === race.playerId, opp);
    schedulePoll();
  }
  let _pt = null;
  function schedulePoll() {
    clearTimeout(_pt);
    if (!race || race.resultShown) return;
    // poll faster while racing / in the lobby so START is caught for a full countdown
    const racing = B()?.navState() === 'navigating';
    _pt = setTimeout(poll, racing ? 2200 : 1400);
  }

  function renderPlayers(players) {
    const box = $('race-players'); if (!box) return;
    box.innerHTML = players.length
      ? players.map(p => `<div class="race-player">${p.player_id === race.playerId ? '🫵' : '🏎️'} ${escapeHtml(p.name || 'Racer')}${p.player_id === race.host_id ? ' <span class="race-host">host</span>' : ''}</div>`).join('')
      : '<div class="race-wait">Waiting for a challenger…</div>';
    const startBtn = $('race-start-btn');
    if (startBtn) {
      const ready = race.isHost && players.length >= 2 && !race.cdActive;
      startBtn.style.display = ready ? 'block' : 'none';
      startBtn.disabled = false;
      if (ready && $('race-hint')) $('race-hint').textContent = 'Everyone in? Hit START — 3·2·1·GO for both of you.';
    }
  }

  // ── VS bar ────────────────────────────────────────────────────────────────
  function updateVs(me, opp) {
    const bar = $('race-vs'); if (!bar) return;
    if (!opp || B()?.navState() !== 'navigating') { bar.classList.add('hidden'); return; }
    bar.classList.remove('hidden');
    $('race-vs-name').textContent = 'vs ' + (opp.name || 'Rival');
    $('race-vs-opp-lbl').textContent = (opp.name || 'Rival').slice(0, 12);
    const pct = (p) => {
      if (!p || p.dist == null) return 0;
      const start = race.starts[p.player_id] = Math.max(race.starts[p.player_id] || 0, p.dist);
      return start > 0 ? Math.max(0, Math.min(1, 1 - p.dist / start)) : 0;
    };
    const mePct = pct(me), oppPct = pct(opp);
    $('race-vs-me').style.width = Math.round(mePct * 100) + '%';
    $('race-vs-opp').style.width = Math.round(oppPct * 100) + '%';
    $('race-vs-me-d').textContent = me?.dist != null ? fmtKm(me.dist) : '–';
    $('race-vs-opp-d').textContent = opp?.dist != null ? fmtKm(opp.dist) : '–';
    const meLead = (me?.dist ?? 1e9) <= (opp?.dist ?? 1e9);
    bar.querySelector('[data-who="me"]').classList.toggle('leader', meLead);
    bar.querySelector('[data-who="opp"]').classList.toggle('leader', !meLead);
  }

  function updateOppMarker(opp) {
    const map = window.ghostMap, mgl = window.maplibregl;
    if (!map || !mgl) return;
    if (!opp || opp.lat == null) { race.oppMarker?.remove(); race.oppMarker = null; return; }
    if (!race.oppMarker) {
      const el = document.createElement('div');
      el.className = 'race-opp-marker';
      el.innerHTML = `<div class="race-opp-dot">🏎️</div><div class="race-opp-name">${escapeHtml((opp.name || 'Rival').slice(0, 10))}</div>`;
      race.oppMarker = new mgl.Marker({ element: el, anchor: 'bottom' }).setLngLat([opp.lng, opp.lat]).addTo(map);
    } else {
      race.oppMarker.setLngLat([opp.lng, opp.lat]);
    }
  }

  // ── Finish ────────────────────────────────────────────────────────────────
  function onArrive() {
    if (!race || race.finished) return;
    race.finished = true;
    api(`/${race.code}/update`, { player_id: race.playerId, dist: 0, finished: true });
    startPolling(); // pick up the winner_id
  }

  const LOSE_LINES = [
    'Dead last, little bitch. 🐌',
    'You got smoked. Embarrassing.',
    'Slower than a wet weekend. 💀',
    'GG — you drive like a little bitch.',
    'Not even close. Try walking next time.',
  ];
  function showResult(won, opp) {
    if (race.resultShown) return;
    race.resultShown = true;
    ui();
    $('race-result-emoji').textContent = won ? '🏆' : '😤';
    $('race-result-title').textContent = won ? 'YOU WON' : 'YOU LOST';
    $('race-result-title').className = 'race-result-title ' + (won ? 'win' : 'lose');
    $('race-result-line').textContent = won
      ? `You smoked ${opp?.name || 'them'}. Absolute weapon. 🔥`
      : LOSE_LINES[Math.floor(Math.random() * LOSE_LINES.length)];
    $('race-result').classList.remove('hidden');
    if (window.prefs?.haptic && navigator.vibrate) navigator.vibrate(won ? [60, 40, 60, 40, 200] : [400]);
    race.oppMarker?.remove(); race.oppMarker = null;
    clearTimeout(_pt);
  }

  function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  // ── Public + wiring ─────────────────────────────────────────────────────────
  window.Race = { createFromRoute, join, tick, onArrive, active: () => !!race };

  function wire() {
    $('race-route-btn')?.addEventListener('click', createFromRoute);
    // Auto-join from a share link ?race=CODE
    const code = new URLSearchParams(location.search).get('race');
    if (code && /^[A-Za-z0-9]{4}$/.test(code)) {
      const go = () => join(code.toUpperCase());
      if (window.ghostRace) setTimeout(go, 1200); else window.addEventListener('ghostmap-ready', () => setTimeout(go, 1200), { once: true });
      history.replaceState(null, '', location.pathname); // clean the URL
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire); else wire();
})();
