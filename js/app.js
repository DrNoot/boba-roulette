/**
 * app.js - Boba Roulette main controller
 * Ties together BobaData, BobaWheel, BobaAudio, and BobaConfetti.
 * Manages views, state, localStorage persistence, and all user interactions.
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------
  const STORAGE_KEY = 'boba-roulette';

  const CHIP_COLORS = [
    '#f97316','#ec4899','#a855f7','#14b8a6',
    '#f59e0b','#ef4444','#8b5cf6','#06b6d4','#10b981','#f43f5e',
  ];

  const CARPOOL_CONFIG = [
    { label: 'No carpool',      icon: '🚗', sublabel: 'Tap to set carpool mode' },
    { label: 'They pick me up', icon: '🚘', sublabel: 'Friend drives to you first' },
    { label: 'I pick them up',  icon: '🚙', sublabel: 'You drive to friend first' },
  ];

  // ---------------------------------------------------------------------------
  // Default state
  // ---------------------------------------------------------------------------
  function defaultState() {
    const allIds = (window.BobaData && window.BobaData.places)
      ? window.BobaData.places.map(p => p.id)
      : [];
    return {
      selectedPlaceIds: [...allIds],
      startKey: 'daniels',
      venueKey: 'aaniin',
      carpoolState: 0,
      settings: {
        weights: {},
        weightByRoute: false,
        maxDetour: 30,
        soundEnabled: true,
        confettiEnabled: true,
        vetoes: { Daniel: 2, Alex: 2, Sam: 2, Jordan: 2, Riley: 2 },
      },
      history: [],
    };
  }

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  let state = defaultState();
  let audioInitialized = false;
  let lastWinner = null; // {place, detourMin}
  let toastTimer = null;

  // ---------------------------------------------------------------------------
  // localStorage helpers
  // ---------------------------------------------------------------------------
  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      // Merge saved onto defaults to handle new fields gracefully
      state = Object.assign(defaultState(), saved);
      state.settings = Object.assign(defaultState().settings, saved.settings || {});
      state.settings.vetoes = Object.assign(defaultState().settings.vetoes, (saved.settings || {}).vetoes || {});
    } catch (e) {
      console.warn('Boba Roulette: failed to load state', e);
    }
  }

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      console.warn('Boba Roulette: failed to save state', e);
    }
  }

  // ---------------------------------------------------------------------------
  // View navigation
  // ---------------------------------------------------------------------------
  function showView(viewId, animClass) {
    document.querySelectorAll('.view').forEach(v => {
      v.classList.remove('active', 'slide-right', 'slide-left');
    });
    const target = document.getElementById(viewId);
    if (!target) return;
    if (animClass) target.classList.add(animClass);
    target.classList.add('active');
  }

  // ---------------------------------------------------------------------------
  // Toast
  // ---------------------------------------------------------------------------
  function showToast(msg, durationMs) {
    const toast = document.getElementById('toast');
    if (!toast) return;
    if (toastTimer) clearTimeout(toastTimer);
    toast.textContent = msg;
    toast.classList.add('show');
    toastTimer = setTimeout(() => toast.classList.remove('show'), durationMs || 2500);
  }

  // ---------------------------------------------------------------------------
  // Chip grid (main screen)
  // ---------------------------------------------------------------------------
  function buildChipsGrid() {
    const grid = document.getElementById('chips-grid');
    if (!grid || !window.BobaData) return;
    grid.innerHTML = '';
    window.BobaData.places.forEach((place, i) => {
      const btn = document.createElement('button');
      btn.className = 'chip' + (state.selectedPlaceIds.includes(place.id) ? ' selected' : '');
      btn.dataset.ci = String(i % 10);
      btn.dataset.placeId = place.id;
      btn.setAttribute('aria-pressed', state.selectedPlaceIds.includes(place.id) ? 'true' : 'false');
      btn.innerHTML = `<span class="chip-dot"></span><span class="chip-name">${place.name}</span>`;
      if (state.settings.weightByRoute) {
        const detour = getDetourForPlace(place);
        if (detour !== null) {
          const badge = document.createElement('span');
          badge.className = 'chip-detour';
          badge.style.cssText = 'font-size:0.65rem;color:var(--text-dim);margin-left:auto;flex-shrink:0;';
          badge.textContent = `+${detour}m`;
          btn.appendChild(badge);
        }
      }
      btn.addEventListener('click', () => onChipClick(place.id, btn));
      grid.appendChild(btn);
    });
  }

  function onChipClick(placeId, btn) {
    const idx = state.selectedPlaceIds.indexOf(placeId);
    if (idx === -1) {
      state.selectedPlaceIds.push(placeId);
      btn.classList.add('selected');
      btn.setAttribute('aria-pressed', 'true');
    } else {
      state.selectedPlaceIds.splice(idx, 1);
      btn.classList.remove('selected');
      btn.setAttribute('aria-pressed', 'false');
    }
    saveState();
  }

  function getDetourForPlace(place) {
    if (!window.BobaData || !window.BobaData.calcDetour) return null;
    try {
      const result = window.BobaData.calcDetour(place.id, state.startKey, state.venueKey, state.carpoolState);
      return (result !== null && result !== undefined) ? Math.round(result) : null;
    } catch (e) {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Settings: preference sliders
  // ---------------------------------------------------------------------------
  function buildPrefList() {
    const list = document.getElementById('pref-list');
    if (!list || !window.BobaData) return;
    list.innerHTML = '';
    window.BobaData.places.forEach((place, i) => {
      const weight = state.settings.weights[place.id] !== undefined
        ? state.settings.weights[place.id] : 50;
      const color = CHIP_COLORS[i % 10];
      const item = document.createElement('div');
      item.className = 'pref-item';
      item.innerHTML = `
        <div class="pref-row">
          <div class="pref-name">
            <span class="pref-dot" style="background:${color}"></span>
            ${place.name}
          </div>
          <div class="pref-value" id="pref-val-${place.id}">${weight}</div>
        </div>
        <input type="range" min="0" max="100" value="${weight}"
               data-place-id="${place.id}"
               aria-label="Weight for ${place.name}" />
      `;
      const slider = item.querySelector('input[type="range"]');
      slider.addEventListener('input', () => {
        const val = parseInt(slider.value, 10);
        document.getElementById(`pref-val-${place.id}`).textContent = val;
        state.settings.weights[place.id] = val;
        saveState();
      });
      list.appendChild(item);
    });
  }

  // ---------------------------------------------------------------------------
  // Sync UI to state
  // ---------------------------------------------------------------------------
  function syncRouteControls() {
    const startSel = document.getElementById('select-start');
    const venueSel = document.getElementById('select-venue');
    if (startSel) startSel.value = state.startKey;
    if (venueSel) venueSel.value = state.venueKey;
  }

  function syncCarpoolButton() {
    const btn = document.getElementById('btn-carpool');
    const icon = document.getElementById('carpool-icon');
    const label = document.getElementById('carpool-label');
    const sublabel = document.getElementById('carpool-sublabel');
    if (!btn) return;
    const cfg = CARPOOL_CONFIG[state.carpoolState];
    btn.dataset.state = String(state.carpoolState);
    if (icon) icon.textContent = cfg.icon;
    if (label) label.textContent = cfg.label;
    if (sublabel) sublabel.textContent = cfg.sublabel;
  }

  function syncSettingsToggles() {
    const soundEl = document.getElementById('toggle-sound');
    const confettiEl = document.getElementById('toggle-confetti');
    const routeEl = document.getElementById('toggle-weight-route');
    const detourSlider = document.getElementById('slider-detour');
    const detourVal = document.getElementById('detour-value');
    if (soundEl) soundEl.checked = state.settings.soundEnabled;
    if (confettiEl) confettiEl.checked = state.settings.confettiEnabled;
    if (routeEl) routeEl.checked = state.settings.weightByRoute;
    if (detourSlider) {
      detourSlider.value = state.settings.maxDetour;
      if (detourVal) detourVal.textContent = formatDetourLabel(state.settings.maxDetour);
    }
  }

  function syncVetoCounts() {
    Object.entries(state.settings.vetoes).forEach(([person, count]) => {
      const el = document.getElementById(`veto-count-${person.toLowerCase()}`);
      if (el) el.textContent = count;
    });
  }

  function formatDetourLabel(val) {
    if (val === 0) return '0 min (no boba)';
    if (val === 60) return '60 min (no limit)';
    return `${val} min`;
  }

  // ---------------------------------------------------------------------------
  // Weighted random pick
  // ---------------------------------------------------------------------------
  function pickWinner(selectedPlaces) {
    const weights = selectedPlaces.map(place => {
      let w = state.settings.weights[place.id] !== undefined
        ? state.settings.weights[place.id] : 50;
      if (state.settings.weightByRoute) {
        const detour = getDetourForPlace(place);
        if (detour !== null) {
          const maxD = state.settings.maxDetour || 30;
          const factor = maxD > 0
            ? Math.max(0.5, 2.0 - (detour / maxD) * 1.5)
            : 1.0;
          w *= factor;
        }
      }
      return Math.max(0, w);
    });

    const total = weights.reduce((a, b) => a + b, 0);
    if (total === 0) return 0;

    let rnd = Math.random() * total;
    for (let i = 0; i < weights.length; i++) {
      rnd -= weights[i];
      if (rnd <= 0) return i;
    }
    return weights.length - 1;
  }

  // ---------------------------------------------------------------------------
  // Spin flow
  // ---------------------------------------------------------------------------
  function onSpinClick() {
    const selected = window.BobaData.places.filter(p =>
      state.selectedPlaceIds.includes(p.id)
    );
    if (selected.length < 2) {
      showToast('Select at least 2 places');
      return;
    }

    // Initialize audio on first user gesture
    if (!audioInitialized) {
      window.BobaAudio.init();
      audioInitialized = true;
    }

    showView('view-wheel', 'slide-right');
    startSpin(selected);
  }

  function startSpin(selected) {
    const winnerIdx = pickWinner(selected);
    const winner = selected[winnerIdx];
    const detourMin = getDetourForPlace(winner);
    lastWinner = { place: winner, detourMin };

    // Map selected places to wheel segments (use original palette index)
    const segments = selected.map(place => {
      const origIdx = window.BobaData.places.findIndex(p => p.id === place.id);
      return { name: place.name, color: CHIP_COLORS[origIdx % 10] };
    });

    window.BobaWheel.setSegments(segments);

    // Hide result, show spinning label
    document.getElementById('result-overlay').classList.remove('visible');
    document.getElementById('wheel-post-spin').style.display = 'none';
    document.getElementById('spinning-label').classList.add('visible');

    window.BobaAudio.playSpinStart();
    window.BobaWheel.spin(winnerIdx, onSpinComplete);
  }

  function onSpinComplete() {
    document.getElementById('spinning-label').classList.remove('visible');
    if (!lastWinner) return;

    const { place, detourMin } = lastWinner;
    document.getElementById('result-place').textContent = place.name;
    document.getElementById('result-detour').textContent =
      detourMin !== null ? `+${detourMin} min detour` : 'Detour unknown';
    document.getElementById('result-overlay').classList.add('visible');
    document.getElementById('wheel-post-spin').style.display = 'flex';

    window.BobaAudio.playCelebration();
    window.BobaConfetti.launch(120);
  }

  // ---------------------------------------------------------------------------
  // Post-spin actions
  // ---------------------------------------------------------------------------
  function onLogBoba() {
    if (!lastWinner) return;
    const { place, detourMin } = lastWinner;
    const entry = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2),
      placeId: place.id,
      placeName: place.name,
      date: new Date().toISOString(),
      startKey: state.startKey,
      venueKey: state.venueKey,
      detourMin: detourMin,
    };
    state.history.unshift(entry);
    saveState();
    showToast('Logged!');
    document.getElementById('wheel-post-spin').style.display = 'none';
  }

  function onJustTesting() {
    document.getElementById('result-overlay').classList.remove('visible');
    document.getElementById('wheel-post-spin').style.display = 'none';
    showToast('Not logged');
  }

  function onSpinAgain() {
    const selected = window.BobaData.places.filter(p =>
      state.selectedPlaceIds.includes(p.id)
    );
    if (selected.length < 2) {
      showView('view-main', 'slide-left');
      showToast('Select at least 2 places');
      return;
    }
    startSpin(selected);
  }

  // ---------------------------------------------------------------------------
  // History rendering
  // ---------------------------------------------------------------------------
  function renderHistory() {
    const list = document.getElementById('visit-list');
    const empty = document.getElementById('empty-history');
    if (!list) return;

    // Clear existing visit items (keep empty state)
    list.querySelectorAll('.visit-item').forEach(el => el.remove());

    if (state.history.length === 0) {
      if (empty) empty.style.display = '';
      renderStats([]);
      return;
    }

    if (empty) empty.style.display = 'none';
    state.history.forEach(entry => list.appendChild(buildVisitItem(entry)));
    renderStats(state.history);
  }

  function buildVisitItem(entry) {
    const item = document.createElement('div');
    item.className = 'visit-item';
    item.dataset.entryId = entry.id;

    const dateStr = formatDate(entry.date);
    const startLabel = getLabelForKey('start', entry.startKey);
    const venueLabel = getLabelForKey('venue', entry.venueKey);
    const detourText = entry.detourMin !== null && entry.detourMin !== undefined
      ? `+${entry.detourMin} min` : '';

    item.innerHTML = `
      <div class="visit-header">
        <div class="visit-place">${entry.placeName}</div>
        <div class="visit-meta">
          <div class="visit-date">${dateStr}</div>
          ${detourText ? `<div class="visit-badge">${detourText}</div>` : ''}
        </div>
      </div>
      <div class="visit-details">
        <span class="visit-tag">${startLabel} → ${venueLabel}</span>
      </div>
      <button class="visit-delete" aria-label="Delete this entry">✕</button>
    `;

    item.addEventListener('click', (e) => {
      if (e.target.closest('.visit-delete')) return;
      item.classList.toggle('expanded');
    });

    item.querySelector('.visit-delete').addEventListener('click', (e) => {
      e.stopPropagation();
      deleteHistoryEntry(entry.id);
    });

    return item;
  }

  function deleteHistoryEntry(entryId) {
    state.history = state.history.filter(e => e.id !== entryId);
    saveState();
    renderHistory();
    showToast('Entry deleted');
  }

  function renderStats(history) {
    const totalEl = document.getElementById('stat-total');
    const favEl   = document.getElementById('stat-fav');
    const leastEl = document.getElementById('stat-least');

    if (totalEl) totalEl.textContent = history.length;

    if (!history.length) {
      if (favEl)   favEl.textContent   = '—';
      if (leastEl) leastEl.textContent = '—';
      return;
    }

    const counts = {};
    history.forEach(e => { counts[e.placeName] = (counts[e.placeName] || 0) + 1; });
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    if (favEl)   favEl.textContent   = sorted[0][0];
    if (leastEl) leastEl.textContent = sorted[sorted.length - 1][0];
  }

  function formatDate(iso) {
    try {
      const d = new Date(iso);
      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    } catch (e) {
      return iso;
    }
  }

  function getLabelForKey(type, key) {
    if (!window.BobaData) return key;
    const map = type === 'start'
      ? (window.BobaData.starts || window.BobaData.routes || {})
      : (window.BobaData.venues || window.BobaData.routes || {});
    const entry = map[key];
    if (!entry) return key;
    return entry.label || entry.name || key;
  }

  // ---------------------------------------------------------------------------
  // Event wiring
  // ---------------------------------------------------------------------------
  function attachEventListeners() {
    // Back buttons
    document.getElementById('btn-wheel-back')
      ?.addEventListener('click', () => showView('view-main', 'slide-left'));
    document.getElementById('btn-settings-back')
      ?.addEventListener('click', () => showView('view-main', 'slide-left'));
    document.getElementById('btn-history-back')
      ?.addEventListener('click', () => showView('view-main', 'slide-left'));

    // Nav
    document.getElementById('btn-settings')
      ?.addEventListener('click', () => { syncSettingsToggles(); showView('view-settings', 'slide-right'); });
    document.getElementById('btn-history')
      ?.addEventListener('click', () => { renderHistory(); showView('view-history', 'slide-right'); });

    // Chip select/clear
    document.getElementById('btn-select-all')?.addEventListener('click', () => {
      state.selectedPlaceIds = window.BobaData.places.map(p => p.id);
      saveState();
      buildChipsGrid();
    });
    document.getElementById('btn-clear-all')?.addEventListener('click', () => {
      state.selectedPlaceIds = [];
      saveState();
      buildChipsGrid();
    });

    // Route selects
    document.getElementById('select-start')?.addEventListener('change', e => {
      state.startKey = e.target.value;
      saveState();
      if (state.settings.weightByRoute) buildChipsGrid();
    });
    document.getElementById('select-venue')?.addEventListener('change', e => {
      state.venueKey = e.target.value;
      saveState();
      if (state.settings.weightByRoute) buildChipsGrid();
    });

    // Carpool
    document.getElementById('btn-carpool')?.addEventListener('click', () => {
      state.carpoolState = (state.carpoolState + 1) % 3;
      saveState();
      syncCarpoolButton();
      if (state.settings.weightByRoute) buildChipsGrid();
    });

    // Spin
    document.getElementById('btn-spin')?.addEventListener('click', onSpinClick);

    // Post-spin
    document.getElementById('btn-log-boba')?.addEventListener('click', onLogBoba);
    document.getElementById('btn-just-testing')?.addEventListener('click', onJustTesting);
    document.getElementById('btn-spin-again')?.addEventListener('click', onSpinAgain);

    attachSettingsListeners();
    attachVetoListeners();
  }

  function attachSettingsListeners() {
    // Route weighting toggle
    document.getElementById('toggle-weight-route')?.addEventListener('change', e => {
      state.settings.weightByRoute = e.target.checked;
      saveState();
      buildChipsGrid();
    });

    // Max detour slider
    const detourSlider = document.getElementById('slider-detour');
    const detourVal    = document.getElementById('detour-value');
    detourSlider?.addEventListener('input', () => {
      const val = parseInt(detourSlider.value, 10);
      state.settings.maxDetour = val;
      if (detourVal) detourVal.textContent = formatDetourLabel(val);
      saveState();
    });

    // Sound toggle
    document.getElementById('toggle-sound')?.addEventListener('change', e => {
      state.settings.soundEnabled = e.target.checked;
      window.BobaAudio.setEnabled(e.target.checked);
      saveState();
    });

    // Confetti toggle
    document.getElementById('toggle-confetti')?.addEventListener('change', e => {
      state.settings.confettiEnabled = e.target.checked;
      window.BobaConfetti.setEnabled(e.target.checked);
      saveState();
    });
  }

  function attachVetoListeners() {
    document.querySelectorAll('.veto-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const person = btn.dataset.person;
        const action = btn.dataset.action;
        if (!person || !state.settings.vetoes) return;
        const cur = state.settings.vetoes[person] || 0;
        if (action === 'inc') state.settings.vetoes[person] = Math.min(5, cur + 1);
        if (action === 'dec') state.settings.vetoes[person] = Math.max(0, cur - 1);
        saveState();
        const countEl = document.getElementById(`veto-count-${person.toLowerCase()}`);
        if (countEl) countEl.textContent = state.settings.vetoes[person];
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Initialization
  // ---------------------------------------------------------------------------
  document.addEventListener('DOMContentLoaded', () => {
    loadState();

    buildChipsGrid();
    buildPrefList();

    syncRouteControls();
    syncCarpoolButton();
    syncSettingsToggles();
    syncVetoCounts();

    // Init wheel
    const wheelCanvas = document.getElementById('wheel-canvas');
    if (wheelCanvas) {
      window.BobaWheel.init(wheelCanvas);
      window.BobaWheel.setTickCallback(() => window.BobaAudio.playTick());
    }

    // Init confetti on document.body (global overlay)
    window.BobaConfetti.init(document.body);

    // Apply persisted enabled states to modules
    window.BobaAudio.setEnabled(state.settings.soundEnabled);
    window.BobaConfetti.setEnabled(state.settings.confettiEnabled);

    attachEventListeners();

    // Handle confetti canvas resize
    window.addEventListener('resize', () => window.BobaConfetti.resize());
  });

})();
