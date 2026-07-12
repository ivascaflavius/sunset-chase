/* =========================================================================
   SUNSET CHASE — ui.js
   All DOM-facing UI: screen navigation, main menu, license plate editor,
   journey log / stats, settings, help, pause & game-over screens, and the
   portrait-mode blocking overlay. Persists progression data to LocalStorage.

   game.js calls into UI.* to show the HUD, update stats, and react to
   button clicks (via a small pub/sub `onAction` callback registry).
   ========================================================================= */

const UI = (() => {

  const STORAGE_KEY = 'sunsetchase_save_v1';

  const PLATE_COLORS = ['#ffffff', '#ffe27a', '#ff8c42', '#2de2e6', '#7b2ff7', '#111111'];
  const PLATE_ICONS = ['🌴', '🌵', '☀️', '🏙️'];
  const CAR_MODELS = [
    { id: 'testarossa', label: 'Testarossa Style', icon: 'assets/car-testarossa.svg' },
    { id: 'countach', label: 'Countach Style', icon: 'assets/car-countach.svg' },
    { id: '944', label: 'Porsche 944 Style', icon: 'assets/car-944.svg' },
    { id: 'delorean', label: 'DeLorean Style', icon: 'assets/car-delorean.svg' },
  ];
  const VISUAL_FILTERS = [
    { id: 'none', label: 'None', icon: '◻' },
    { id: 'bloom', label: 'Neon Bloom', icon: '✨' },
    { id: 'midnight', label: 'Midnight', icon: '🌙' },
    { id: 'scanlines', label: 'VHS', icon: '📼' },
    { id: 'pastel', label: 'Pastel', icon: '🌸' },
    { id: 'purple', label: 'Deep Purple', icon: '🔮' },
  ];

  const ACHIEVEMENT_DEFS = [
    { id: 'first_sunset', label: 'First Sunset Saved', check: (s) => s.suspensionBest > 0 },
    { id: 'ten_km', label: '10 KM Driven', check: (s) => s.lifetimeKm >= 10 },
    { id: 'palm_zone', label: 'Palm Zone Explorer', check: (s) => s.zonesEverVisited && s.zonesEverVisited.includes('Palm Zone') },
    { id: 'flow_master', label: 'Longest Flow Streak', check: (s) => s.streakBest >= 30 },
    { id: 'nightfall', label: 'Nightfall Survivor', check: (s) => s.zonesEverVisited && s.zonesEverVisited.includes('Nightfall Zone') },
  ];

  let save = null;
  let actionHandlers = {};
  let previewFilter = null; // in-progress (unsaved) filter selection while Settings is open

  // ----- Persistence ------------------------------------------------------
  function defaultSave() {
    return {
      plate: { text: 'SUNSET1', color: PLATE_COLORS[0], icon: PLATE_ICONS[0] },
      settings: { soundOn: true, filter: 'none', car: 'testarossa' },
      bestDistanceKm: 0,
      lifetimeKm: 0,
      suspensionBest: 0, // seconds
      streakBest: 0,     // seconds
      zonesEverVisited: [],
      achievements: [],
    };
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      save = raw ? Object.assign(defaultSave(), JSON.parse(raw)) : defaultSave();
      // Nested-merge settings so older saves (which may lack newer fields, or
      // still carry now-removed ones like "music"/"curvature") don't clobber
      // the current settings shape.
      save.settings = Object.assign(defaultSave().settings, save.settings);
    } catch (e) {
      save = defaultSave();
    }
    return save;
  }

  function persist() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(save)); } catch (e) { /* ignore quota errors */ }
  }

  function getSave() { return save; }

  function recordRunResult({ distanceKm, suspensionSeconds, streakSeconds, zonesVisited }) {
    save.lifetimeKm += distanceKm;
    if (distanceKm > save.bestDistanceKm) save.bestDistanceKm = distanceKm;
    if (suspensionSeconds > save.suspensionBest) save.suspensionBest = suspensionSeconds;
    if (streakSeconds > save.streakBest) save.streakBest = streakSeconds;
    zonesVisited.forEach((z) => { if (!save.zonesEverVisited.includes(z)) save.zonesEverVisited.push(z); });
    ACHIEVEMENT_DEFS.forEach((a) => {
      if (!save.achievements.includes(a.id) && a.check(save)) save.achievements.push(a.id);
    });
    persist();
  }

  // ----- Screen navigation -------------------------------------------------
  const screens = ['menu', 'plate', 'journey', 'settings', 'help', 'pause', 'gameover'];

  function showScreen(name) {
    screens.forEach((s) => {
      const el = document.getElementById('screen-' + s);
      if (el) el.classList.toggle('active', s === name);
    });
  }

  function hideAllScreens() {
    screens.forEach((s) => document.getElementById('screen-' + s).classList.remove('active'));
  }

  // ----- Wiring -------------------------------------------------------------
  function on(action, handler) { actionHandlers[action] = handler; }

  function bindButtons() {
    document.querySelectorAll('[data-action]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const action = btn.getAttribute('data-action');
        handleAction(action);
      });
    });
  }

  function handleAction(action) {
    switch (action) {
      case 'start-drive': showScreen(null); actionHandlers.startDrive && actionHandlers.startDrive(); break;
      case 'open-plate': renderPlateEditor(); showScreen('plate'); break;
      case 'open-journey': renderJourneyLog(); showScreen('journey'); break;
      case 'open-settings': loadSettingsIntoForm(); showScreen('settings'); break;
      case 'open-help': showScreen('help'); break;
      case 'toggle-sound': toggleSound(); break;
      case 'back-menu': applyVisualFilter(save.settings.filter); renderMenu(); showScreen('menu'); break;
      case 'save-plate': savePlateFromForm(); renderMenu(); showScreen('menu'); break;
      case 'save-settings': saveSettingsFromForm(); actionHandlers.settingsChanged && actionHandlers.settingsChanged(save.settings); renderMenu(); showScreen('menu'); break;
      case 'pause': actionHandlers.pauseRequested && actionHandlers.pauseRequested(); break;
      case 'resume': actionHandlers.resumeRequested && actionHandlers.resumeRequested(); break;
      case 'quit-to-menu': actionHandlers.quitRequested && actionHandlers.quitRequested(); renderMenu(); showScreen('menu'); break;
      case 'restart': showScreen(null); actionHandlers.restartRequested && actionHandlers.restartRequested(); break;
      default: break;
    }
  }

  // ----- Main menu -----------------------------------------------------------
  function renderMenu() {
    document.getElementById('menu-best-distance').textContent = save.bestDistanceKm.toFixed(1);
  }

  // ----- License plate editor -------------------------------------------------
  function renderPlateEditor() {
    const textInput = document.getElementById('plate-text-input');
    textInput.value = save.plate.text;
    updatePlatePreview();

    const colorRow = document.getElementById('plate-color-row');
    colorRow.innerHTML = '';
    PLATE_COLORS.forEach((c) => {
      const sw = document.createElement('div');
      sw.className = 'swatch' + (c === save.plate.color ? ' selected' : '');
      sw.style.background = c;
      sw.addEventListener('click', () => {
        save.plate.color = c;
        [...colorRow.children].forEach((el) => el.classList.remove('selected'));
        sw.classList.add('selected');
        updatePlatePreview();
      });
      colorRow.appendChild(sw);
    });

    const iconRow = document.getElementById('plate-icon-row');
    iconRow.innerHTML = '';
    PLATE_ICONS.forEach((ic) => {
      const sw = document.createElement('div');
      sw.className = 'swatch' + (ic === save.plate.icon ? ' selected' : '');
      sw.textContent = ic;
      sw.addEventListener('click', () => {
        save.plate.icon = ic;
        [...iconRow.children].forEach((el) => el.classList.remove('selected'));
        sw.classList.add('selected');
        updatePlatePreview();
      });
      iconRow.appendChild(sw);
    });

    textInput.oninput = () => {
      save.plate.text = textInput.value.toUpperCase().slice(0, 7);
      updatePlatePreview();
    };
  }

  function updatePlatePreview() {
    const preview = document.getElementById('plate-preview');
    preview.style.background = save.plate.color;
    preview.style.color = (save.plate.color === '#111111') ? '#eee' : '#111';
    document.getElementById('plate-icon').textContent = save.plate.icon;
    document.getElementById('plate-text').textContent = save.plate.text || 'SUNSET1';
  }

  function savePlateFromForm() {
    const textInput = document.getElementById('plate-text-input');
    save.plate.text = (textInput.value || 'SUNSET1').toUpperCase().slice(0, 7);
    persist();
  }

  // Formats seconds as m:ss for HUD/stat display.
  function formatTime(totalSeconds) {
    const s = Math.max(0, Math.round(totalSeconds));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return m + ':' + String(r).padStart(2, '0');
  }

  // ----- Journey log ------------------------------------------------------
  function renderJourneyLog() {
    document.getElementById('stat-best').textContent = save.bestDistanceKm.toFixed(1) + ' km';
    document.getElementById('stat-lifetime').textContent = save.lifetimeKm.toFixed(1) + ' km';
    document.getElementById('stat-suspension').textContent = formatTime(save.suspensionBest);
    document.getElementById('stat-zones').textContent = save.zonesEverVisited.length + ' / ' + World.ZONES.length;
    document.getElementById('stat-streak').textContent = Math.round(save.streakBest) + 's';

    const list = document.getElementById('achievement-list');
    list.innerHTML = '';
    ACHIEVEMENT_DEFS.forEach((a) => {
      const li = document.createElement('li');
      li.textContent = a.label;
      li.className = save.achievements.includes(a.id) ? 'unlocked' : '';
      list.appendChild(li);
    });
  }

  // ----- Settings ----------------------------------------------------------
  function loadSettingsIntoForm() {
    renderSoundToggle();
    renderFilterRow();
    renderCarModelRow();
  }

  // Updates the sound toggle button's label/state to reflect save.settings.soundOn.
  function renderSoundToggle() {
    const btn = document.getElementById('setting-sound-toggle');
    btn.textContent = save.settings.soundOn ? '🔊 Sound On' : '🔇 Sound Off';
    btn.classList.toggle('sound-off', !save.settings.soundOn);
  }

  // Instantly flips the mute state — takes effect immediately (not gated
  // behind the Save button) since it's a simple, low-stakes on/off toggle.
  function toggleSound() {
    save.settings.soundOn = !save.settings.soundOn;
    renderSoundToggle();
    persist();
    actionHandlers.settingsChanged && actionHandlers.settingsChanged(save.settings);
  }

  // Renders the visual-filter picker as color/gradient swatches with a
  // representative icon, so players can see a hint of each look instead of
  // picking a name from a plain dropdown.
  function renderFilterRow() {
    previewFilter = save.settings.filter;
    const row = document.getElementById('filter-row');
    row.innerHTML = '';
    VISUAL_FILTERS.forEach((f) => {
      const sw = document.createElement('div');
      sw.className = `filter-swatch filter-swatch-${f.id}` + (f.id === save.settings.filter ? ' selected' : '');
      sw.title = f.label;
      sw.innerHTML = `<span>${f.icon}</span><span class="label">${f.label}</span>`;
      sw.addEventListener('click', () => {
        previewFilter = f.id;
        [...row.children].forEach((el) => el.classList.remove('selected'));
        sw.classList.add('selected');
        applyVisualFilter(f.id); // live preview while in Settings, not yet persisted
      });
      row.appendChild(sw);
    });
  }

  // Renders the visual car-model picker using the SVG side-profile icons from
  // assets/, so players can actually see the silhouette they're choosing
  // instead of picking a name from a plain dropdown.
  function renderCarModelRow() {
    const row = document.getElementById('car-model-row');
    row.innerHTML = '';
    CAR_MODELS.forEach((m) => {
      const sw = document.createElement('div');
      sw.className = 'car-swatch' + (m.id === save.settings.car ? ' selected' : '');
      sw.title = m.label;
      const img = document.createElement('img');
      img.src = m.icon;
      img.alt = m.label;
      sw.appendChild(img);
      sw.addEventListener('click', () => {
        save.settings.car = m.id;
        [...row.children].forEach((el) => el.classList.remove('selected'));
        sw.classList.add('selected');
      });
      row.appendChild(sw);
    });
  }

  function saveSettingsFromForm() {
    save.settings.filter = previewFilter;
    persist();
    applyVisualFilter(save.settings.filter);
  }

  function applyVisualFilter(filter) {
    const stage = document.getElementById('stage');
    stage.className = stage.className.replace(/filter-\S+/g, '').trim();
    if (filter && filter !== 'none') stage.classList.add('filter-' + filter);
  }

  // ----- HUD ----------------------------------------------------------------
  // Touch controls should only appear on devices that actually use touch as
  // their primary input (phones/tablets) — desktop users have keyboard/mouse
  // and gamepad, so overlaying big translucent touch zones on top of the
  // driving view would just be visual clutter for them.
  function isTouchPrimaryDevice() {
    const hasTouch = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
    const coarsePointer = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    return hasTouch && coarsePointer;
  }

  function showHud(show) {
    document.getElementById('hud').classList.toggle('hidden', !show);
    document.getElementById('touch-controls').classList.toggle('hidden', !show || !isTouchPrimaryDevice());
  }

  function updateHud(distanceKm, zoneName, sunHeight01, speedKmh, timeSeconds, lineProximity01) {
    document.getElementById('hud-distance').textContent = distanceKm.toFixed(1);
    document.getElementById('hud-speed').textContent = Math.round(speedKmh);
    document.getElementById('hud-time').textContent = formatTime(timeSeconds);
    document.getElementById('hud-zone').textContent = zoneName;
    document.getElementById('hud-sun-fill').style.width = Math.round(sunHeight01 * 100) + '%';
    document.getElementById('hud-line-fill').style.width = Math.round((lineProximity01 || 0) * 100) + '%';
    document.getElementById('hud-line-meter').classList.toggle('locked', lineProximity01 >= 0.999);
  }

  // ----- Game over -----------------------------------------------------------
  function showGameOver({ distanceKm, zonesVisited, streakSeconds, timeSeconds, isNewBest }) {
    document.getElementById('go-distance').textContent = distanceKm.toFixed(1) + ' km';
    document.getElementById('go-zones').textContent = zonesVisited;
    document.getElementById('go-streak').textContent = Math.round(streakSeconds) + 's';
    document.getElementById('go-time').textContent = formatTime(timeSeconds);
    document.getElementById('go-newbest').textContent = isNewBest ? 'Yes! 🌟' : '—';
    showScreen('gameover');
  }

  // ----- Portrait overlay ------------------------------------------------------
  function checkOrientation() {
    const overlay = document.getElementById('portrait-overlay');
    const isPortrait = window.innerHeight > window.innerWidth;
    overlay.classList.toggle('visible', isPortrait);
    actionHandlers.orientationChanged && actionHandlers.orientationChanged(!isPortrait);
  }

  function initOrientationWatch() {
    checkOrientation();
    window.addEventListener('resize', checkOrientation);
    window.addEventListener('orientationchange', checkOrientation);
  }

  // ----- Init -----------------------------------------------------------------
  function init() {
    load();
    bindButtons();
    renderMenu();
    applyVisualFilter(save.settings.filter);
    initOrientationWatch();
    showScreen('menu');
  }

  return {
    init, on, showScreen, hideAllScreens,
    getSave, recordRunResult, persist,
    showHud, updateHud, showGameOver,
    applyVisualFilter, checkOrientation,
    renderMenu,
  };
})();
