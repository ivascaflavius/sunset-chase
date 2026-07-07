/* =========================================================================
   SUNSET CHASE — world.js
   Procedural pseudo-3D road world: segment-based road generator (in the
   tradition of classic OutRun-style renderers), parallax scenery layers,
   zone theming, weather variants, ambient particles and rare scenic events.

   Exposes the `World` object used by game.js to update & render everything
   "outside the car".
   ========================================================================= */

const World = (() => {

  // ---------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------
  const SEGMENT_LENGTH = 200;     // world units per road segment
  const ROAD_WIDTH = 1600;        // half-width of road in world units
  const RUMBLE_LENGTH = 3;        // segments per rumble-strip stripe
  const DRAW_DISTANCE = 220;      // segments rendered ahead
  const CAMERA_HEIGHT = 900;
  const CAMERA_DEPTH = 0.84;      // 1 / tan(fov/2)
  const FIELD_OF_VIEW_Y = 1;

  const ZONES = ['Palm Zone', 'Desert Zone', 'Coastal Zone', 'Nightfall Zone'];
  const ZONE_LENGTH_KM = 1.2; // distance per zone before cycling to next

  // Per-zone color palettes (grass, rumble, road alternate lightness handled in render)
  const ZONE_THEMES = {
    'Palm Zone':      { grass: '#1c6b5e', rumbleA: '#e8e8e8', rumbleB: '#c0392b', road: '#2b2540', sky: ['#2b0d45', '#7a2e6b', '#ff7657'], objDensity: 0.8, objType: 'palm' },
    'Desert Zone':     { grass: '#7a5230', rumbleA: '#e8d8b0', rumbleB: '#b5651d', road: '#3a2a3a', sky: ['#3a1030', '#a3406b', '#ffb56b'], objDensity: 0.55, objType: 'cactus' },
    'Coastal Zone':    { grass: '#123a4a', rumbleA: '#e8e8e8', rumbleB: '#2472a4', road: '#20263f', sky: ['#0f2a4a', '#3d6ea5', '#ffd166'], objDensity: 0.4, objType: 'palm' },
    'Nightfall Zone':  { grass: '#0c0c1c', rumbleA: '#dadada', rumbleB: '#6a2fbf', road: '#141225', sky: ['#050014', '#1c0a3a', '#5b2a86'], objDensity: 0.3, objType: 'skyline' },
  };

  let segments = [];
  let trackLength = 0;
  let zoneIndex = 0;
  let zonesVisited = new Set();
  // Tracks how many segments have ever been spliced off the front, so that
  // "distance -> array index" math stays correct after trimming old segments.
  let trimmedOffset = 0;

  // Parallax scroll offsets
  let hillOffset = 0;
  let skylineOffset = 0;
  let cloudOffset = 0;

  // Particle system (dust motes / fog wisps / horizon glints)
  let particles = [];

  // Rare scenic events state
  let scenicEvent = null; // { type, x, y, life, ... }
  let scenicTimer = 6 + Math.random() * 10;

  // Weather
  let weather = 'clear'; // clear | rain | fog
  let weatherTimer = 20 + Math.random() * 20;

  // Landmarks placed sparsely along the track
  let landmarks = [];
  // Persistent counter (never reset by trimming) used for stable rumble-strip striping
  let segmentCreationCounter = 0;

  let rng = Math.random;

  function seedRandom(seed) {
    // simple deterministic PRNG (mulberry32) so runs can be reproduced if needed
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---------------------------------------------------------------------
  // Segment generation
  // ---------------------------------------------------------------------
  function lastY() { return segments.length ? segments[segments.length - 1].y : 0; }

  function addSegment(curve, y) {
    segments.push({
      index: segmentCreationCounter++,
      curve,
      y,
      sprites: [],
    });
  }

  function addRoad(enterLen, holdLen, leaveLen, curve, y0, y1) {
    const startY = lastY();
    const endY = startY + y1 * SEGMENT_LENGTH;
    const total = enterLen + holdLen + leaveLen;
    for (let i = 0; i < enterLen; i++) addSegment(easeIn(0, curve, i / enterLen), easeInOutY(startY, endY, i / total));
    for (let i = 0; i < holdLen; i++) addSegment(curve, easeInOutY(startY, endY, (enterLen + i) / total));
    for (let i = 0; i < leaveLen; i++) addSegment(easeOut(curve, 0, i / leaveLen), easeInOutY(startY, endY, (enterLen + holdLen + i) / total));
  }

  function easeIn(a, b, t) { return a + (b - a) * t * t; }
  function easeOut(a, b, t) { return a + (b - a) * (1 - (1 - t) * (1 - t)); }
  function easeInOutY(a, b, t) { return a + (b - a) * ((1 - Math.cos(Math.PI * t)) / 2); }

  // Procedurally extends the track with a random mix of curves & hills,
  // biased by a "curvature" difficulty setting (0..1) from Settings.
  function proceduralExtend(count, curvatureSetting) {
    for (let i = 0; i < count; i++) {
      const roll = rng();
      const curveMag = (2.2 + curvatureSetting * 4) * (rng() < 0.5 ? -1 : 1);
      const hillMag = rng() < 0.35 ? (rng() < 0.5 ? -1.4 : 1.4) : 0;
      if (roll < 0.35) {
        addRoad(40, 60, 40, 0, 0, hillMag); // straight-ish with gentle elevation
      } else if (roll < 0.75) {
        addRoad(40, 80, 40, curveMag, 0, hillMag); // curve
      } else {
        addRoad(30, 50, 30, curveMag * 1.6, 0, hillMag * 1.6); // sharper curve/hill combo
      }
    }
  }

  // Place roadside sprites (palms/cacti/skyline bits) and rare landmarks
  function scatterSprites(fromIndex, toIndex, theme) {
    for (let i = fromIndex; i < toIndex; i++) {
      const seg = segments[i];
      if (!seg) continue;
      if (rng() < theme.objDensity * 0.5) {
        const side = rng() < 0.5 ? -1 : 1;
        seg.sprites.push({ side, offset: 1.1 + rng() * 1.8, type: theme.objType, scale: 0.7 + rng() * 0.6, lean: rng() * 2 - 1 });
      }
      // Rare landmark (neon diner, pyramid, radio tower) roughly every ~900 segments
      if (i % 900 === Math.floor(rng() * 20)) {
        const kinds = ['diner', 'pyramid', 'tower'];
        const kind = kinds[Math.floor(rng() * kinds.length)];
        seg.sprites.push({ side: rng() < 0.5 ? -1 : 1, offset: 2.4, type: 'landmark-' + kind, scale: 2.2 });
      }
    }
  }

  function reset(seed, curvatureSetting = 0.5) {
    rng = seedRandom(seed || Date.now());
    segments = [];
    trimmedOffset = 0;
    segmentCreationCounter = 0;
    zoneIndex = 0;
    zonesVisited = new Set([ZONES[0]]);
    particles = [];
    landmarks = [];
    scenicEvent = null;
    weather = 'clear';
    weatherTimer = 20 + rng() * 20;

    // Flat starting stretch so the player has a calm on-ramp
    for (let i = 0; i < 60; i++) addSegment(0, 0);
    proceduralExtend(160, curvatureSetting);
    scatterSprites(0, segments.length, ZONE_THEMES[ZONES[0]]);
    trackLength = segments.length * SEGMENT_LENGTH;

    // Seed a light dust-mote particle field
    for (let i = 0; i < 40; i++) spawnParticle(true);
  }

  function ensureAhead(playerSegmentIndex, curvatureSetting) {
    const localPlayerIndex = playerSegmentIndex - trimmedOffset;
    while (segments.length < localPlayerIndex + DRAW_DISTANCE + 200) {
      const before = segments.length;
      proceduralExtend(20, curvatureSetting);
      const zoneDistM = (before + trimmedOffset) * SEGMENT_LENGTH;
      const theme = ZONE_THEMES[getZoneForDistance(zoneDistM)];
      scatterSprites(before, segments.length, theme);
    }
    // Trim segments far behind the player to keep memory bounded. Critically,
    // `trimmedOffset` is bumped by the same amount so that any later
    // `globalIndex - trimmedOffset` lookup still lands on the correct segment.
    if (localPlayerIndex > 400) {
      const removeCount = localPlayerIndex - 200;
      segments.splice(0, removeCount);
      trimmedOffset += removeCount;
    }
  }

  function getZoneForDistance(distanceUnits) {
    const km = distanceUnits / 100000; // world-unit to km scale factor (tuned for pacing)
    const idx = Math.floor(km / ZONE_LENGTH_KM) % ZONES.length;
    return ZONES[idx];
  }

  // ---------------------------------------------------------------------
  // Particles (dust motes / horizon glints / fog wisps)
  // ---------------------------------------------------------------------
  function spawnParticle(initial = false) {
    particles.push({
      x: Math.random(),
      y: 0.5 + Math.random() * 0.45,
      speed: 0.02 + Math.random() * 0.05,
      size: 0.6 + Math.random() * 1.8,
      alpha: 0.15 + Math.random() * 0.25,
      life: initial ? Math.random() * 10 : 0,
    });
  }

  function updateParticles(dt) {
    particles.forEach((p) => {
      p.x -= p.speed * dt * 0.3;
      p.life += dt;
      if (p.x < -0.05) p.x = 1.05;
    });
    if (particles.length < 40 && Math.random() < 0.02) spawnParticle();
  }

  // ---------------------------------------------------------------------
  // Rare scenic events & weather
  // ---------------------------------------------------------------------
  function updateScenicEvents(dt) {
    scenicTimer -= dt;
    if (!scenicEvent && scenicTimer <= 0) {
      const roll = Math.random();
      if (roll < 0.4) scenicEvent = { type: 'bird', x: -0.1, y: 0.15 + Math.random() * 0.15, life: 0 };
      else if (roll < 0.7) scenicEvent = { type: 'shootingstar', x: 0.9, y: 0.05 + Math.random() * 0.15, life: 0 };
      else scenicEvent = { type: 'lightning', life: 0, flashAt: 0.3 + Math.random() * 0.4, flashX: 0.15 + Math.random() * 0.7 };
      scenicTimer = 14 + Math.random() * 18;
    }
    if (scenicEvent) {
      scenicEvent.life += dt;
      if (scenicEvent.type === 'bird') {
        scenicEvent.x += dt * 0.09;
        if (scenicEvent.x > 1.15) scenicEvent = null;
      } else if (scenicEvent.type === 'shootingstar') {
        scenicEvent.x -= dt * 0.6;
        scenicEvent.y += dt * 0.3;
        if (scenicEvent.life > 1.4) scenicEvent = null;
      } else if (scenicEvent.type === 'lightning') {
        if (scenicEvent.life > 1.0) scenicEvent = null;
      }
    }

    weatherTimer -= dt;
    if (weatherTimer <= 0) {
      const options = ['clear', 'clear', 'rain', 'fog'];
      weather = options[Math.floor(Math.random() * options.length)];
      weatherTimer = 25 + Math.random() * 25;
    }
  }

  // ---------------------------------------------------------------------
  // Update — advances parallax scroll based on player speed
  // ---------------------------------------------------------------------
  function update(dt, speed01) {
    hillOffset += speed01 * dt * 18;
    skylineOffset += speed01 * dt * 6;
    cloudOffset += dt * 2.5;
    updateParticles(dt);
    updateScenicEvents(dt);
  }

  // ---------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------
  function project(seg, camX, camY, camZ, width, height, roadWidth) {
    const scale = CAMERA_DEPTH / Math.max(1, (seg.z - camZ));
    const screenX = Math.round((width / 2) + (scale * (seg.x - camX) * width / 2));
    const screenY = Math.round((height / 2) - (scale * (seg.y - camY) * height / 2));
    const screenW = Math.round(scale * roadWidth * width / 2);
    return { screenX, screenY, screenW, scale };
  }

  // Draws the sky gradient, sun, hills, skyline and clouds (background parallax)
  function renderBackground(ctx, w, h, theme, sunset01, sunStyle, flow01, horizonY) {
    // Sky gradient with slow hue drift baked into ZONE_THEMES + sunset darkening
    const t = performance.now() / 8000;
    const hueDrift = Math.sin(t) * 6;
    const grad = ctx.createLinearGradient(0, 0, 0, horizonY);
    const [c1, c2, c3] = theme.sky;
    grad.addColorStop(0, shadeColor(c1, -sunset01 * 40 + hueDrift));
    grad.addColorStop(0.55, shadeColor(c2, -sunset01 * 30));
    grad.addColorStop(1, shadeColor(c3, -sunset01 * 20));
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, horizonY);

    // Soft clouds drifting slowly
    ctx.save();
    ctx.globalAlpha = 0.18;
    ctx.fillStyle = '#fff';
    for (let i = 0; i < 4; i++) {
      const cx = ((i * 260 + cloudOffset * 4) % (w + 300)) - 150;
      const cy = horizonY * (0.18 + i * 0.12);
      ctx.beginPath();
      ctx.ellipse(cx, cy, 70, 14, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // Sun: position rises with sunset01 inverted (0 = high, 1 = set below horizon)
    const sunY = horizonY - (1 - sunset01) * horizonY * 0.85 - horizonY * 0.05;
    const sunX = w / 2;
    const sunR = h * 0.16 * (1 + flow01 * 0.12);
    drawSun(ctx, sunX, sunY, sunR, horizonY, sunset01, flow01, sunStyle);

    // Distant hills silhouette (midground), gentle sine-based ridge, parallax-scrolled
    ctx.fillStyle = shadeColor(theme.grass, -18);
    ctx.beginPath();
    ctx.moveTo(0, horizonY);
    const hillH = h * 0.05;
    for (let x = 0; x <= w; x += 20) {
      const yy = horizonY - hillH - Math.sin((x + hillOffset * 20) * 0.008) * hillH * 0.6;
      ctx.lineTo(x, yy);
    }
    ctx.lineTo(w, horizonY);
    ctx.closePath();
    ctx.fill();

    // Skyline silhouette (further back, slower parallax) — only really shows in Nightfall/Coastal
    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = '#000';
    for (let i = -1; i < 10; i++) {
      const bx = ((i * 90 - skylineOffset * 6) % (w + 180)) - 90;
      const bw = 40 + (i % 3) * 14;
      const bh = 30 + (i % 5) * 18;
      ctx.fillRect(bx, horizonY - bh, bw, bh);
    }
    ctx.restore();
  }

  function drawSun(ctx, x, y, r, horizonY, sunset01, flow01, style) {
    ctx.save();
    // Clip so the sun is cut off by the horizon line for the classic look
    ctx.beginPath();
    ctx.rect(0, 0, ctx.canvas.width, horizonY);
    ctx.clip();

    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.clip();

    if (style === 'pastel') {
      const g = ctx.createLinearGradient(x, y - r, x, y + r);
      g.addColorStop(0, '#ffe1f0');
      g.addColorStop(1, '#ffb3c6');
      ctx.fillStyle = g;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    } else if (style === 'purple') {
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, '#c9a3ff');
      g.addColorStop(1, '#2b0a4a');
      ctx.fillStyle = g;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    } else if (style === 'vaporwave') {
      const g = ctx.createLinearGradient(x, y - r, x, y + r);
      g.addColorStop(0, '#ff71ce');
      g.addColorStop(1, '#01cdfe');
      ctx.fillStyle = g;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
      // grid lines inside sun
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.lineWidth = 2;
      for (let i = -4; i <= 4; i++) {
        ctx.beginPath(); ctx.moveTo(x + i * (r / 4), y - r); ctx.lineTo(x + i * (r / 4), y + r); ctx.stroke();
      }
    } else {
      // classic synthwave stripes
      const g = ctx.createLinearGradient(x, y - r, x, y + r);
      g.addColorStop(0, '#ffe27a');
      g.addColorStop(0.5, '#ff8c42');
      g.addColorStop(1, '#ff3ea5');
      ctx.fillStyle = g;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }

    if (style !== 'vaporwave') {
      // Horizontal retro stripes cut across the lower half of the sun
      ctx.fillStyle = 'rgba(10,0,20,0.55)';
      const stripeCount = 6;
      for (let i = 0; i < stripeCount; i++) {
        const sy = y + r * (0.05 + i * 0.13);
        const sh = r * 0.045;
        ctx.fillRect(x - r, sy, r * 2, sh);
      }
    }
    ctx.restore();

    // Glow / shimmer, brighter during flow streaks
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.35 + flow01 * 0.35;
    const glow = ctx.createRadialGradient(x, y, r * 0.5, x, y, r * 2.1);
    glow.addColorStop(0, 'rgba(255,180,120,0.55)');
    glow.addColorStop(1, 'rgba(255,180,120,0)');
    ctx.fillStyle = glow;
    ctx.beginPath(); ctx.arc(x, y, r * 2.1, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  function shadeColor(hex, percent) {
    const num = parseInt(hex.replace('#', ''), 16);
    let r = (num >> 16) + Math.round(2.55 * percent);
    let g = ((num >> 8) & 0x00ff) + Math.round(2.55 * percent);
    let b = (num & 0x0000ff) + Math.round(2.55 * percent);
    r = Math.max(0, Math.min(255, r));
    g = Math.max(0, Math.min(255, g));
    b = Math.max(0, Math.min(255, b));
    return `rgb(${r},${g},${b})`;
  }

  // Tall, slender coconut/LA-boulevard-style palm: a gently leaning curved trunk
  // topped with a crown of long fronds that arc up and out, then droop down at
  // their tips (the classic silhouette), plus a few coconuts nestled in the crown.
  // Fronds are filled tapered blade shapes (not thin strokes) so the canopy
  // reads as a solid, full silhouette rather than a spidery wireframe.
  function drawCoconutPalm(ctx, size, lean) {
    const trunkH = size * 1.9; // tall & slender, taller than the old version
    const leanX = size * (0.18 + lean * 0.15);

    // Trunk: gentle S-curve so it doesn't look like a stiff pole
    ctx.beginPath();
    ctx.moveTo(-size * 0.05, 0);
    ctx.quadraticCurveTo(leanX * 0.5, -trunkH * 0.5, leanX, -trunkH);
    ctx.lineTo(leanX + size * 0.09, -trunkH);
    ctx.quadraticCurveTo(leanX * 0.5 + size * 0.09, -trunkH * 0.5, size * 0.05, 0);
    ctx.closePath();
    ctx.fill();

    // Crown sits at the top of the leaning trunk
    const crownX = leanX + size * 0.045;
    const crownY = -trunkH;

    ctx.save();
    ctx.translate(crownX, crownY);

    // A solid hub fill beneath the fronds merges their bases into one clump
    // (avoids gaps between individual blades showing through to the sky).
    ctx.beginPath();
    ctx.ellipse(0, size * 0.06, size * 0.22, size * 0.16, 0, 0, Math.PI * 2);
    ctx.fill();

    // Fronds: solid tapered leaf-blade shapes that rise from the crown then
    // droop back down at the tip — full width near the base, narrowing to a
    // point at the tip, like a real coconut/queen palm frond.
    const frondAngles = [-72, -42, -16, 8, 32, 58, 90, 122];
    frondAngles.forEach((deg, i) => {
      const a = (deg * Math.PI) / 180;
      const len = size * (0.95 + Math.abs(Math.sin(a)) * 0.3);
      const dirX = Math.sin(a);
      const dirY = -Math.abs(Math.cos(a)) * 0.7 - 0.3;
      const dLen = Math.hypot(dirX, dirY) || 1;
      const ndx = dirX / dLen, ndy = dirY / dLen;
      const perpX = -ndy, perpY = ndx; // perpendicular direction, for blade width

      const midX = dirX * len * 0.55;
      const midY = dirY * len * 0.55;
      const endX = dirX * len * 1.05;
      const endY = midY + len * 0.5; // droop back downward at the tip

      // Slightly vary blade width per-frond for a more organic, less uniform canopy
      const baseW = size * (0.15 + (i % 3) * 0.02);
      const midW = size * 0.09;

      ctx.beginPath();
      ctx.moveTo(perpX * baseW * 0.5, perpY * baseW * 0.5);
      ctx.quadraticCurveTo(midX + perpX * midW * 0.5, midY + perpY * midW * 0.5, endX, endY);
      ctx.quadraticCurveTo(midX - perpX * midW * 0.5, midY - perpY * midW * 0.5, -perpX * baseW * 0.5, -perpY * baseW * 0.5);
      ctx.closePath();
      ctx.fill();
    });

    // A few coconuts clustered under the crown
    for (let i = 0; i < 3; i++) {
      ctx.beginPath();
      ctx.arc((i - 1) * size * 0.07, size * 0.06, size * 0.05, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // Draws roadside sprite silhouettes (palms, cacti, landmarks) at a projected position
  function drawSprite(ctx, sprite, sx, sy, scale, roadScreenW) {
    const size = roadScreenW * 0.55 * sprite.scale * scale * 1.6;
    if (size < 1.5) return;
    ctx.save();
    ctx.translate(sx, sy);
    ctx.fillStyle = 'rgba(5,2,12,0.9)';
    if (sprite.type === 'palm') {
      drawCoconutPalm(ctx, size, sprite.lean || 0);
    } else if (sprite.type === 'cactus') {
      ctx.fillRect(-size * 0.08, -size, size * 0.16, size);
      ctx.fillRect(-size * 0.32, -size * 0.6, size * 0.24, size * 0.14);
      ctx.fillRect(size * 0.08, -size * 0.75, size * 0.24, size * 0.14);
    } else if (sprite.type === 'skyline') {
      ctx.fillRect(-size * 0.25, -size, size * 0.5, size);
    } else if (sprite.type === 'landmark-diner') {
      ctx.fillStyle = 'rgba(20,4,30,0.95)';
      ctx.fillRect(-size * 0.6, -size * 0.6, size * 1.2, size * 0.6);
      ctx.fillStyle = '#ff3ea5';
      ctx.fillRect(-size * 0.55, -size * 0.55, size * 1.1, size * 0.08);
    } else if (sprite.type === 'landmark-pyramid') {
      ctx.beginPath();
      ctx.moveTo(0, -size); ctx.lineTo(size * 0.6, 0); ctx.lineTo(-size * 0.6, 0);
      ctx.closePath(); ctx.fill();
    } else if (sprite.type === 'landmark-tower') {
      ctx.fillRect(-size * 0.06, -size, size * 0.12, size);
      ctx.fillStyle = '#2de2e6';
      ctx.beginPath(); ctx.arc(0, -size, size * 0.06, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  // Main render entry point called by game.js each frame.
  // playerDist: world-unit distance traveled; playerX: lateral offset -1..1 (road-relative)
  function render(ctx, w, h, playerDist, playerX, sunset01, flow01, sunStyle, weatherOverride) {
    const horizonY = h * 0.52;
    const globalSegIdx = Math.floor(playerDist / SEGMENT_LENGTH) - trimmedOffset;
    const baseSegIdx = ((globalSegIdx % segments.length) + segments.length) % segments.length;
    const zoneName = getZoneForDistance(playerDist);
    zonesVisited.add(zoneName);
    const theme = ZONE_THEMES[zoneName];

    renderBackground(ctx, w, h, theme, sunset01, sunStyle, flow01, horizonY);
    renderScenicEvents(ctx, w, h, horizonY);

    // ---- Road (segment projection & scanline trapezoids) ----
    ctx.fillStyle = theme.grass;
    ctx.fillRect(0, horizonY, w, h - horizonY);

    const camHeight = CAMERA_HEIGHT;
    const playerSegment = segments[baseSegIdx];
    const camY = (playerSegment ? playerSegment.y : 0) + camHeight;
    // Fractional progress through the current segment. Without this, the
    // camera would only appear to move once per full SEGMENT_LENGTH of
    // travel (a visible "pop" every 200 world units) instead of scrolling
    // smoothly — this is what caused the road to look like it snapped/
    // turned abruptly. Subtracting this from each segment's Z distance
    // keeps the projection continuous frame-to-frame.
    const segFloat = playerDist / SEGMENT_LENGTH - trimmedOffset;
    const segPercent = segFloat - Math.floor(segFloat);
    let x = 0, dx = 0;
    let maxY = h;

    for (let n = 0; n < DRAW_DISTANCE; n++) {
      const idx = (baseSegIdx + n) % segments.length;
      const seg = segments[idx];
      if (!seg) continue;

      const segWorldZ = (n - segPercent) * SEGMENT_LENGTH;
      const segWorldZ2 = (n + 1 - segPercent) * SEGMENT_LENGTH;

      // Clamp to a small positive minimum (never divide by ~0 or negative Z,
      // which happens for the segment currently under/behind the camera).
      const scale1 = CAMERA_DEPTH / Math.max(1, segWorldZ);
      const scale2 = CAMERA_DEPTH / Math.max(1, segWorldZ2);

      x += dx;
      dx += seg.curve;

      const roadCenterX1 = w / 2 + scale1 * x * w / 2 - scale1 * playerX * ROAD_WIDTH * w / 2;
      const roadCenterX2 = w / 2 + scale2 * (x + dx) * w / 2 - scale2 * playerX * ROAD_WIDTH * w / 2;

      const y1raw = h / 2 - scale1 * ((seg.y - camY)) * h / 2;
      const y2 = h / 2 - scale2 * ((segments[(idx + 1) % segments.length].y - camY)) * h / 2;

      const w1 = scale1 * ROAD_WIDTH * w / 2;
      const w2 = scale2 * ROAD_WIDTH * w / 2;

      if (y2 < horizonY - 4 || y2 > h + 4) continue;
      // Segments very close to the camera project to enormous Y values
      // (far below the screen). Clamp the near edge to the bottom of the
      // canvas so the polygon always reaches all the way down — otherwise
      // a gap was left at the bottom edge where the road should be, and
      // the raw unshaded fallback grass color showed through instead.
      const y1 = Math.min(y1raw, h + 2);
      if (y1 <= y2) continue;
      if (y1 > maxY) continue;
      maxY = Math.min(maxY, y1);

      const rumbleOn = Math.floor(seg.index / RUMBLE_LENGTH) % 2;
      const grassShade = idx % 2 === 0 ? theme.grass : shadeColor(theme.grass, -6);
      const roadShade = idx % 2 === 0 ? theme.road : shadeColor(theme.road, 6);

      // grass strip for this scanline band
      ctx.fillStyle = grassShade;
      ctx.fillRect(0, y2, w, y1 - y2);

      // rumble strips
      const rumbleW1 = w1 * 1.12, rumbleW2 = w2 * 1.12;
      ctx.fillStyle = rumbleOn ? theme.rumbleA : theme.rumbleB;
      polygon(ctx, roadCenterX1 - rumbleW1, y1, roadCenterX1 + rumbleW1, y1, roadCenterX2 + rumbleW2, y2, roadCenterX2 - rumbleW2, y2);

      // road surface
      ctx.fillStyle = roadShade;
      polygon(ctx, roadCenterX1 - w1, y1, roadCenterX1 + w1, y1, roadCenterX2 + w2, y2, roadCenterX2 - w2, y2);

      // lane divider (center dashed line) — skip during rumble-off segments for dash effect
      if (rumbleOn) {
        ctx.fillStyle = 'rgba(255,255,255,0.75)';
        const laneW1 = w1 * 0.03, laneW2 = w2 * 0.03;
        polygon(ctx, roadCenterX1 - laneW1, y1, roadCenterX1 + laneW1, y1, roadCenterX2 + laneW2, y2, roadCenterX2 - laneW2, y2);
      }

      // Wet-road reflection during rain
      if (weatherOverride === 'rain') {
        ctx.save();
        ctx.globalAlpha = 0.12;
        ctx.fillStyle = '#bfe9ff';
        polygon(ctx, roadCenterX1 - w1, y1, roadCenterX1 + w1, y1, roadCenterX2 + w2, y2, roadCenterX2 - w2, y2);
        ctx.restore();
      }

      // roadside sprites
      seg.sprites.forEach((sprite) => {
        const sx = roadCenterX1 + sprite.side * (w1 * sprite.offset);
        drawSprite(ctx, sprite, sx, y1, scale1 * 900, w1);
      });
    }

    renderParticles(ctx, w, h);
    renderWeatherOverlay(ctx, w, h, weatherOverride, horizonY);

    return { zoneName, zonesVisitedCount: zonesVisited.size };
  }

  function polygon(ctx, x1, y1, x2, y2, x3, y3, x4, y4) {
    ctx.beginPath();
    ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.lineTo(x3, y3); ctx.lineTo(x4, y4);
    ctx.closePath();
    ctx.fill();
  }

  function renderParticles(ctx, w, h) {
    ctx.save();
    particles.forEach((p) => {
      ctx.globalAlpha = p.alpha;
      ctx.fillStyle = '#ffe9f3';
      ctx.beginPath();
      ctx.arc(p.x * w, p.y * h, p.size, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.restore();
  }

  function renderScenicEvents(ctx, w, h, horizonY) {
    if (!scenicEvent) return;
    ctx.save();
    if (scenicEvent.type === 'bird') {
      ctx.strokeStyle = 'rgba(20,10,30,0.8)';
      ctx.lineWidth = 2;
      const bx = scenicEvent.x * w, by = scenicEvent.y * h;
      ctx.beginPath();
      ctx.moveTo(bx - 10, by); ctx.lineTo(bx, by - 6); ctx.lineTo(bx + 10, by);
      ctx.stroke();
    } else if (scenicEvent.type === 'shootingstar') {
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 2;
      const sx = scenicEvent.x * w, sy = scenicEvent.y * h;
      ctx.beginPath();
      ctx.moveTo(sx, sy); ctx.lineTo(sx + 40, sy - 16);
      ctx.stroke();
    } else if (scenicEvent.type === 'lightning') {
      // A brief, localized glow low on the horizon — reads as a distant storm
      // flash rather than a full-screen tint. Confined to a small rect around
      // the flash point (not the whole top half) and kept dim so it never
      // washes out the sky/sun.
      const flashProgress = scenicEvent.life;
      const dt1 = flashProgress - scenicEvent.flashAt;
      // Double-pulse: a quick bright flicker followed by a softer afterglow.
      let intensity = 0;
      if (dt1 > 0 && dt1 < 0.09) intensity = 1;
      else if (dt1 >= 0.09 && dt1 < 0.24) intensity = 0.35 * (1 - (dt1 - 0.09) / 0.15);
      if (intensity > 0) {
        const fx = scenicEvent.flashX * w;
        const fy = horizonY - h * 0.06;
        const radius = w * 0.2;
        const g = ctx.createRadialGradient(fx, fy, 0, fx, fy, radius);
        g.addColorStop(0, `rgba(223,233,255,${0.12 * intensity})`);
        g.addColorStop(1, 'rgba(223,233,255,0)');
        ctx.globalAlpha = 1;
        ctx.fillStyle = g;
        // Only fill the gradient's own bounding box, not the entire top half —
        // keeps the effect a small localized flash instead of a screen-wide tint.
        ctx.fillRect(Math.max(0, fx - radius), Math.max(0, fy - radius), radius * 2, radius * 2);
      }
    }
    ctx.restore();
  }

  function renderWeatherOverlay(ctx, w, h, weatherOverride, horizonY) {
    if (weatherOverride === 'fog') {
      // A soft, low haze hugging the horizon line — kept tight and low-opacity
      // so it reads as gentle ground mist, not a stark white band washing out
      // the upper sky/sun.
      const g = ctx.createLinearGradient(0, horizonY - h * 0.03, 0, horizonY + h * 0.07);
      g.addColorStop(0, 'rgba(220,225,235,0)');
      g.addColorStop(1, 'rgba(220,225,235,0.16)');
      ctx.fillStyle = g;
      ctx.fillRect(0, horizonY - h * 0.03, w, h * 0.1);
    } else if (weatherOverride === 'rain') {
      ctx.save();
      ctx.strokeStyle = 'rgba(190,220,255,0.25)';
      ctx.lineWidth = 1;
      for (let i = 0; i < 40; i++) {
        const rx = (i * 53 + (performance.now() / 8)) % w;
        const ry = (i * 91 + (performance.now() / 3)) % h;
        ctx.beginPath();
        ctx.moveTo(rx, ry); ctx.lineTo(rx - 4, ry + 14);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  function getCurrentWeather() { return weather; }
  function getZonesVisitedCount() { return zonesVisited.size; }
  function getRoadCurvatureAt(distance) {
    const globalIdx = Math.floor(distance / SEGMENT_LENGTH) - trimmedOffset;
    const idx = ((globalIdx % Math.max(1, segments.length)) + segments.length) % Math.max(1, segments.length);
    const seg = segments[idx];
    return seg ? seg.curve : 0;
  }

  return {
    reset,
    ensureAhead,
    update,
    render,
    getCurrentWeather,
    getZonesVisitedCount,
    getRoadCurvatureAt,
    getZoneForDistance,
    ZONES,
    SEGMENT_LENGTH,
    ROAD_WIDTH,
  };
})();
