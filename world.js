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

  const ZONES = ['Palm Zone', 'Desert Zone', 'Meadow Zone', 'Coastal Zone', 'Nightfall Zone'];
  const ZONE_LENGTH_KM = 1.2; // distance per zone before cycling to next

  // Per-zone biome theming: palette, weighted roadside-object mix, and a
  // weighted local weather table so each biome has characteristic skies
  // (dust storms only in the desert, drizzle in the green zones, etc).
  const ZONE_THEMES = {
    'Palm Zone': {
      grass: '#1c6b5e', rumbleA: '#e8e8e8', rumbleB: '#c0392b', road: '#2b2540',
      sky: ['#2b0d45', '#7a2e6b', '#ff7657'], objDensity: 1.25,
      objTypes: [['palm', 0.42], ['bush', 0.2], ['shrub', 0.16], ['tree', 0.1], ['rock', 0.12]],
      weathers: [['clear', 0.6], ['rain', 0.25], ['fog', 0.15]],
    },
    'Desert Zone': {
      grass: '#7a5230', rumbleA: '#e8d8b0', rumbleB: '#b5651d', road: '#3a2a3a',
      sky: ['#3a1030', '#a3406b', '#ffb56b'], objDensity: 0.95,
      objTypes: [['cactus', 0.4], ['rock', 0.22], ['drybush', 0.22], ['shrub', 0.16]],
      weathers: [['clear', 0.6], ['dust', 0.4]],
    },
    'Meadow Zone': {
      grass: '#295c31', rumbleA: '#e8e8e8', rumbleB: '#4d7c2a', road: '#2c2b3d',
      sky: ['#1d2a52', '#63589e', '#ff9e6b'], objDensity: 1.5,
      objTypes: [['tree', 0.32], ['pine', 0.24], ['bush', 0.2], ['shrub', 0.24]],
      weathers: [['clear', 0.4], ['rain', 0.35], ['fog', 0.25]],
    },
    'Coastal Zone': {
      grass: '#123a4a', rumbleA: '#e8e8e8', rumbleB: '#2472a4', road: '#20263f',
      sky: ['#0f2a4a', '#3d6ea5', '#ffd166'], objDensity: 0.9,
      objTypes: [['palm', 0.4], ['rock', 0.2], ['bush', 0.18], ['shrub', 0.14], ['tree', 0.08]],
      weathers: [['clear', 0.5], ['fog', 0.3], ['rain', 0.2]],
    },
    'Nightfall Zone': {
      grass: '#0c0c1c', rumbleA: '#dadada', rumbleB: '#6a2fbf', road: '#141225',
      sky: ['#050014', '#1c0a3a', '#5b2a86'], objDensity: 0.6,
      objTypes: [['skyline', 0.55], ['pine', 0.15], ['rock', 0.12], ['shrub', 0.18]],
      weathers: [['clear', 0.8], ['fog', 0.2]],
    },
  };

  // Picks a value from a [[value, weight], ...] table given a 0..1 roll.
  function pickWeighted(table, roll) {
    const total = table.reduce((s, e) => s + e[1], 0);
    let acc = 0;
    for (const [value, wgt] of table) {
      acc += wgt;
      if (roll < acc / total) return value;
    }
    return table[table.length - 1][0];
  }

  let segments = [];
  let trackLength = 0;
  let zoneIndex = 0;
  let zonesVisited = new Set();
  // Tracks how many segments have ever been spliced off the front, so that
  // "distance -> array index" math stays correct after trimming old segments.
  let trimmedOffset = 0;

  // Parallax scroll offsets
  let hillOffset = 0;
  let cloudOffset = 0;

  // Particle system (dust motes / fog wisps / horizon glints)
  let particles = [];

  // Rare scenic events state
  let scenicEvent = null; // { type, x, y, life, ... }
  let scenicTimer = 6 + Math.random() * 10;

  // Weather: clear | rain | fog | dust. Changes cross-fade over a few seconds
  // (weatherBlend ramps 0→1) so rain/dust roll in and out instead of popping.
  let weather = 'clear';
  let prevWeather = 'clear';
  let weatherBlend = 1;
  let weatherTimer = 20 + Math.random() * 20;
  let currentZoneName = ZONES[0]; // updated each render; picks the local weather table

  // Pre-generated background props (rebuilt on reset)
  let clouds = [];        // puffy multi-lobe clouds
  let cityBuildings = []; // distant skyline silhouetted against the sunset

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

  // Place roadside sprites (palms/cacti/trees/etc) and rare landmarks.
  // The theme is resolved per segment (not per chunk) so scenery always
  // matches the biome the segment actually sits in — a single procedural
  // extension can span multiple zones.
  function scatterSprites(fromIndex, toIndex) {
    for (let i = fromIndex; i < toIndex; i++) {
      const seg = segments[i];
      if (!seg) continue;
      const theme = ZONE_THEMES[getZoneForDistance((i + trimmedOffset) * SEGMENT_LENGTH)];
      if (rng() < theme.objDensity * 0.5) {
        const side = rng() < 0.5 ? -1 : 1;
        seg.sprites.push({
          side,
          offset: 1.1 + rng() * 1.8,
          type: pickWeighted(theme.objTypes, rng()),
          scale: 0.7 + rng() * 0.6,
          lean: rng() * 2 - 1,
          v: rng(), // per-instance variation seed (arm heights, window patterns…)
        });
        // Undergrowth companion: a smaller bush/shrub clumped nearby, so the
        // roadside reads as layered vegetation rather than lone specimens.
        if (rng() < 0.55) {
          seg.sprites.push({
            side: rng() < 0.75 ? side : -side,
            offset: 1.05 + rng() * 2.2,
            type: rng() < 0.5 ? 'shrub' : (theme.objTypes.some(([t]) => t === 'drybush') ? 'drybush' : 'bush'),
            scale: 0.5 + rng() * 0.45,
            lean: rng() * 2 - 1,
            v: rng(),
          });
        }
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
    prevWeather = 'clear';
    weatherBlend = 1;
    weatherTimer = 20 + rng() * 20;
    currentZoneName = ZONES[0];
    makeClouds();
    makeCity();

    // Flat starting stretch so the player has a calm on-ramp
    for (let i = 0; i < 60; i++) addSegment(0, 0);
    proceduralExtend(160, curvatureSetting);
    scatterSprites(0, segments.length);
    trackLength = segments.length * SEGMENT_LENGTH;
  }

  function ensureAhead(playerSegmentIndex, curvatureSetting) {
    const localPlayerIndex = playerSegmentIndex - trimmedOffset;
    while (segments.length < localPlayerIndex + DRAW_DISTANCE + 200) {
      const before = segments.length;
      proceduralExtend(20, curvatureSetting);
      scatterSprites(before, segments.length);
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
  // Background prop generation (clouds & distant city)
  // ---------------------------------------------------------------------
  // Each cloud is a cluster of overlapping puff ellipses, so it renders as a
  // lumpy cumulus shape with a lit underside instead of a single flat ellipse.
  function makeClouds() {
    clouds = [];
    for (let i = 0; i < 12; i++) {
      const puffs = [];
      const n = 4 + Math.floor(rng() * 4);
      for (let p = 0; p < n; p++) {
        puffs.push({ dx: (rng() - 0.5) * 2.4, dy: (rng() - 0.45) * 0.55, r: 0.45 + rng() * 0.55 });
      }
      clouds.push({
        x: rng(),                     // 0..1 across (wraps)
        y: 0.08 + rng() * 0.35,       // fraction of sky height
        s: 0.045 + rng() * 0.07,      // scale as fraction of screen width
        speed: 0.005 + rng() * 0.011, // per-cloud drift rate
        puffs,
      });
    }
  }

  // A distant metropolis on the horizon, dead ahead toward the sunset (like
  // the sun it sits at "infinity", so it doesn't parallax-scroll sideways).
  // Buildings are taller near the middle of the cluster, some with spires,
  // each with a fixed pattern of lit windows that glow brighter as dusk falls.
  function makeCity() {
    cityBuildings = [];
    const count = 26;
    for (let i = 0; i < count; i++) {
      const u = (i / (count - 1)) * 2 - 1; // -1..1 across the cluster
      const centerBoost = 1 - Math.abs(u) * 0.8;
      const bw = 0.014 + rng() * 0.018;    // width, fraction of screen width
      const bh = (0.3 + rng() * 0.7) * centerBoost + 0.12; // relative height
      const windows = [];
      const cols = 2 + Math.floor(rng() * 2);
      const rows = 3 + Math.floor(bh * 7);
      for (let c = 0; c < cols; c++) {
        for (let r = 0; r < rows; r++) {
          if (rng() < 0.38) windows.push([(c + 0.3) / cols, (r + 0.35) / (rows + 0.8)]);
        }
      }
      cityBuildings.push({
        u: u * 0.42 + (rng() - 0.5) * 0.05, // horizontal spot, fraction of half-width
        bw, bh, windows,
        spire: rng() < 0.18,
      });
    }
  }

  // ---------------------------------------------------------------------
  // Particles — wind-blown dust, only during desert dust storms (there is no
  // longer a permanent ambient mote field; particles are a storm effect).
  // ---------------------------------------------------------------------
  function spawnParticle() {
    particles.push({
      x: 1.05 + Math.random() * 0.1,        // enter from the right edge
      y: 0.15 + Math.random() * 0.8,
      speed: 0.35 + Math.random() * 0.5,     // fast, wind-driven drift
      wobble: Math.random() * Math.PI * 2,
      size: 1.2 + Math.random() * 3.2,
      alpha: 0.25 + Math.random() * 0.35,
      life: 0,
    });
  }

  function updateParticles(dt) {
    const dust = weatherAmount('dust');
    particles.forEach((p) => {
      p.x -= p.speed * dt;
      p.wobble += dt * 6;
      p.y += Math.sin(p.wobble) * dt * 0.02;
      p.life += dt;
    });
    particles = particles.filter((p) => p.x > -0.08);
    // Population tracks storm strength: heavy churn mid-storm, none when clear
    const targetCount = Math.floor(110 * dust);
    while (particles.length < targetCount) spawnParticle();
    if (dust < 0.02 && particles.length > 0 && Math.random() < 0.3) particles.pop();
  }

  // ---------------------------------------------------------------------
  // Rare scenic events & weather
  // ---------------------------------------------------------------------
  // Builds a jagged lightning-bolt polyline from the given sky point down
  // toward the horizon, used for storm strikes during heavy rain.
  function makeBoltPoints(x0) {
    const pts = [[x0, 0.08 + Math.random() * 0.08]];
    let x = x0;
    const steps = 5 + Math.floor(Math.random() * 3);
    for (let i = 1; i <= steps; i++) {
      x += (Math.random() - 0.5) * 0.06;
      pts.push([x, pts[0][1] + (i / steps) * (0.32 + Math.random() * 0.08)]);
    }
    return pts;
  }

  function updateScenicEvents(dt) {
    scenicTimer -= dt;
    const rainNow = weatherAmount('rain');
    if (!scenicEvent && scenicTimer <= 0) {
      const roll = Math.random();
      if (rainNow > 0.4) {
        // Storm mode: frequent, bright lightning strikes with visible bolts
        scenicEvent = {
          type: 'lightning', life: 0,
          flashAt: 0.15 + Math.random() * 0.3,
          flashX: 0.15 + Math.random() * 0.7,
          strength: 0.7 + rainNow * 0.5,
          bolt: makeBoltPoints(0.15 + Math.random() * 0.7),
          thunderQueued: false,
        };
        scenicTimer = 5 + Math.random() * 8;
      } else {
        if (roll < 0.4) scenicEvent = { type: 'bird', x: -0.1, y: 0.15 + Math.random() * 0.15, life: 0 };
        else if (roll < 0.7) scenicEvent = { type: 'shootingstar', x: 0.9, y: 0.05 + Math.random() * 0.15, life: 0 };
        else scenicEvent = { type: 'lightning', life: 0, flashAt: 0.3 + Math.random() * 0.4, flashX: 0.15 + Math.random() * 0.7, strength: 0.35 };
        scenicTimer = 14 + Math.random() * 18;
      }
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
        // Fire a thunder rumble (via the audio engine) once, as the flash hits
        if (!scenicEvent.thunderQueued && scenicEvent.life >= scenicEvent.flashAt && scenicEvent.strength > 0.5) {
          scenicEvent.thunderQueued = true;
          if (typeof Audio_ !== 'undefined' && Audio_.thunder) Audio_.thunder(scenicEvent.strength);
        }
        if (scenicEvent.life > 1.0) scenicEvent = null;
      }
    }

    weatherTimer -= dt;
    if (weatherTimer <= 0) {
      const table = (ZONE_THEMES[currentZoneName] || ZONE_THEMES[ZONES[0]]).weathers;
      const next = pickWeighted(table, Math.random());
      if (next !== weather) {
        prevWeather = weather;
        weather = next;
        weatherBlend = 0;
      }
      weatherTimer = 25 + Math.random() * 25;
    }
    weatherBlend = Math.min(1, weatherBlend + dt / 5); // ~5s cross-fade
  }

  // Current strength (0..1) of a weather kind, accounting for the cross-fade
  // between the previous and current weather states.
  function weatherAmount(kind) {
    let a = 0;
    if (weather === kind) a += weatherBlend;
    if (prevWeather === kind) a += 1 - weatherBlend;
    return a;
  }

  // ---------------------------------------------------------------------
  // Update — advances parallax scroll based on player speed
  // ---------------------------------------------------------------------
  function update(dt, speed01) {
    hillOffset += speed01 * dt * 18;
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

  // Draws the sky gradient, sun, clouds, layered mountain ranges, the distant
  // city skyline and near hills (all parallax background behind the road).
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

    // Weather moods over the sky: storm gloom / rising dust tint
    const rain = weatherAmount('rain');
    const dust = weatherAmount('dust');
    if (rain > 0.01) {
      // Storm gloom: noticeably darker, colder sky under rain clouds
      ctx.fillStyle = `rgba(22,28,48,${0.42 * rain})`;
      ctx.fillRect(0, 0, w, horizonY);
    }
    if (dust > 0.01) {
      const dg = ctx.createLinearGradient(0, horizonY * 0.2, 0, horizonY);
      dg.addColorStop(0, 'rgba(198,126,60,0)');
      dg.addColorStop(1, `rgba(198,126,60,${0.5 * dust})`);
      ctx.fillStyle = dg;
      ctx.fillRect(0, 0, w, horizonY);
    }

    // Sun: position rises with sunset01 inverted (0 = high, 1 = set below horizon)
    const sunY = horizonY - (1 - sunset01) * horizonY * 0.85 - horizonY * 0.05;
    const sunX = w / 2;
    const sunR = h * 0.16 * (1 + flow01 * 0.12);
    drawSun(ctx, sunX, sunY, sunR, horizonY, sunset01, flow01, sunStyle);

    drawClouds(ctx, w, horizonY, theme);

    // Far mountain range — tall, hazy (close to the sky color), slow parallax
    drawMountainRange(ctx, w, horizonY, {
      parallax: hillOffset * 4,
      freq: 0.004,
      amp: h * 0.105,
      base: h * 0.012,
      color: mixColor(shadeColor(c2, -sunset01 * 25), shadeColor(c3, -sunset01 * 15), 0.45),
      seed: 0.8,
    });

    drawCity(ctx, w, h, horizonY, theme, sunset01);

    // Near ridge of hills — darker, faster parallax, grounds the city cluster
    drawMountainRange(ctx, w, horizonY, {
      parallax: hillOffset * 11,
      freq: 0.0072,
      amp: h * 0.055,
      base: h * 0.004,
      color: shadeColor(theme.grass, -22),
      seed: 4.7,
    });
  }

  // A jagged ridgeline built from folded sines at irrational frequency ratios,
  // so peaks look mountainous and never visibly repeat — replaces the old
  // single-sine "band" of hills.
  function ridgeProfile(u) {
    const p1 = 1 - Math.abs(Math.sin(u));
    const p2 = 1 - Math.abs(Math.sin(u * 2.37 + 1.7));
    const p3 = Math.sin(u * 5.13 + 0.6);
    const p4 = Math.abs(Math.sin(u * 11.7 + 3.2));
    return p1 * 0.5 + p2 * 0.28 + p3 * p3 * 0.14 + p4 * 0.08;
  }

  function drawMountainRange(ctx, w, horizonY, opts) {
    ctx.fillStyle = opts.color;
    ctx.beginPath();
    ctx.moveTo(0, horizonY + 1);
    for (let x = 0; x <= w; x += 6) {
      const u = (x + opts.parallax) * opts.freq + opts.seed;
      ctx.lineTo(x, horizonY - opts.base - ridgeProfile(u) * opts.amp);
    }
    ctx.lineTo(w, horizonY + 1);
    ctx.closePath();
    ctx.fill();
  }

  // Puffy cumulus clouds: each is a cluster of ellipse puffs with a darker
  // body and a warm sunset-lit underside. Coverage reacts to weather —
  // overcast and gray in rain, sparse in clear skies, nearly gone in dust.
  //
  // Each cloud is composited opaquely on an offscreen scratch canvas first,
  // then blitted at the target alpha — drawing translucent puffs directly
  // would show every overlap seam and make the cloud look like soap bubbles.
  let cloudScratch = null;
  function drawClouds(ctx, w, horizonY, theme) {
    const rain = weatherAmount('rain');
    const dust = weatherAmount('dust');
    const coverage = Math.min(1, 0.5 + rain * 0.5 - dust * 0.45);
    if (coverage <= 0.02) return;
    const bodyCol = mixColor(mixColor(theme.sky[0], '#8d86a8', 0.4), '#3c4254', rain);
    const litCol = mixColor(theme.sky[2], '#5a6273', rain * 0.85);

    if (!cloudScratch) cloudScratch = document.createElement('canvas');
    clouds.forEach((c, i) => {
      if ((i + 1) / clouds.length > coverage) return;
      const cx = ((c.x + cloudOffset * c.speed) % 1.2) * w * 1.2 - w * 0.1;
      const cy = c.y * horizonY;
      const s = c.s * w;
      // scratch canvas sized to this cloud's bounding box (puff dx ≤ ±1.2+r)
      const bw = Math.ceil(s * 5), bh = Math.ceil(s * 2.6);
      if (bw < 4 || bh < 4) return;
      if (cloudScratch.width < bw) cloudScratch.width = bw;
      if (cloudScratch.height < bh) cloudScratch.height = bh;
      const sctx = cloudScratch.getContext('2d');
      sctx.clearRect(0, 0, cloudScratch.width, cloudScratch.height);
      const ox = bw / 2, oy = bh / 2;
      // opaque body puffs
      sctx.fillStyle = bodyCol;
      c.puffs.forEach((p) => {
        sctx.beginPath();
        sctx.ellipse(ox + p.dx * s, oy + p.dy * s, p.r * s, p.r * s * 0.62, 0, 0, Math.PI * 2);
        sctx.fill();
      });
      // sunset-lit undersides, clipped to the body so they never spill out
      sctx.save();
      sctx.globalCompositeOperation = 'source-atop';
      sctx.fillStyle = litCol;
      sctx.globalAlpha = 0.85 - rain * 0.5;
      c.puffs.forEach((p) => {
        sctx.beginPath();
        sctx.ellipse(ox + p.dx * s, oy + (p.dy + p.r * 0.38) * s, p.r * s * 0.95, p.r * s * 0.4, 0, 0, Math.PI * 2);
        sctx.fill();
      });
      sctx.restore();
      // blit the whole cloud at once at the target translucency
      ctx.save();
      ctx.globalAlpha = 0.55 + rain * 0.25;
      ctx.drawImage(cloudScratch, 0, 0, bw, bh, cx - ox, cy - oy, bw, bh);
      ctx.restore();
    });
  }

  // The distant city skyline, silhouetted against the sunset straight ahead.
  // Window lights flick brighter as the sun sinks.
  function drawCity(ctx, w, h, horizonY, theme, sunset01) {
    const halfSpread = w * 0.5;
    const baseCol = mixColor(theme.sky[1], '#120a20', 0.55 + sunset01 * 0.25);
    const windowAlpha = 0.2 + sunset01 * 0.6;
    ctx.save();
    ctx.globalAlpha = 0.9;
    cityBuildings.forEach((b) => {
      const bw = b.bw * w;
      const bx = w / 2 + b.u * halfSpread - bw / 2;
      const bh = b.bh * h * 0.1 + h * 0.008;
      ctx.fillStyle = baseCol;
      ctx.fillRect(bx, horizonY - bh, bw, bh + 1);
      if (b.spire) ctx.fillRect(bx + bw / 2 - 1, horizonY - bh - h * 0.022, 2, h * 0.022);
      ctx.fillStyle = `rgba(255,214,140,${windowAlpha})`;
      const ww = Math.max(1, bw * 0.14);
      const wh = Math.max(1, bh * 0.045);
      b.windows.forEach(([fx, fy]) => {
        ctx.fillRect(bx + fx * bw - ww / 2, horizonY - bh + fy * bh, ww, wh);
      });
    });
    ctx.restore();
  }

  // A realistic setting sun: a solid warm disc (no stripes, no banded
  // gradient) whose color slides from bright orange toward deep red — and
  // whose light output fades — as it sinks toward the horizon. A soft
  // blurred rim + atmospheric halo stand in for glare instead of hard edges.
  function drawSun(ctx, x, y, r, horizonY, sunset01, flow01, style) {
    ctx.save();
    // Clip so the sun is cut off by the horizon line
    ctx.beginPath();
    ctx.rect(0, 0, ctx.canvas.width, horizonY);
    ctx.clip();

    const warmth = Math.min(1, sunset01 * 1.15); // 0 = high & bright, 1 = nearly set & deep red
    const core = mixColor('#ffb347', '#ff4f2a', warmth);
    const rim = mixColor('#ff8c3c', '#d63317', warmth);

    // Atmospheric halo around the disc, dimming as the sun sinks
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = (0.4 + flow01 * 0.3) * (1 - warmth * 0.5);
    const glow = ctx.createRadialGradient(x, y, r * 0.55, x, y, r * 2.2);
    glow.addColorStop(0, 'rgba(255,150,80,0.5)');
    glow.addColorStop(1, 'rgba(255,110,60,0)');
    ctx.fillStyle = glow;
    ctx.beginPath(); ctx.arc(x, y, r * 2.2, 0, Math.PI * 2); ctx.fill();

    // Solid disc with a softly blurred rim (shadowBlur fakes the glare edge)
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.fillStyle = core;
    ctx.shadowColor = rim;
    ctx.shadowBlur = r * 0.35;
    ctx.beginPath();
    ctx.arc(x, y, r * 0.92, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.restore();
  }

  // Parses '#rrggbb' or 'rgb(r,g,b)' into [r,g,b]
  function parseCol(c) {
    if (c[0] === '#') {
      const n = parseInt(c.slice(1), 16);
      return [n >> 16, (n >> 8) & 255, n & 255];
    }
    const m = c.match(/(\d+)[, ]+(\d+)[, ]+(\d+)/);
    return m ? [+m[1], +m[2], +m[3]] : [0, 0, 0];
  }

  // Linear blend between two colors (hex or rgb strings), t = 0..1
  function mixColor(a, b, t) {
    const A = parseCol(a), B = parseCol(b);
    return `rgb(${Math.round(A[0] + (B[0] - A[0]) * t)},${Math.round(A[1] + (B[1] - A[1]) * t)},${Math.round(A[2] + (B[2] - A[2]) * t)})`;
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

  // Rounded-capsule path (x,y = top-left corner) used for cactus bodies/arms
  function capsulePath(ctx, x, y, cw, ch) {
    const r = Math.min(cw, ch) / 2;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + cw, y, x + cw, y + ch, r);
    ctx.arcTo(x + cw, y + ch, x, y + ch, r);
    ctx.arcTo(x, y + ch, x, y, r);
    ctx.arcTo(x, y, x + cw, y, r);
    ctx.closePath();
  }

  // Tall, slender coconut/LA-boulevard-style palm: a gently leaning curved trunk
  // topped with a crown of long fronds that arc up and out, then droop down at
  // their tips (the classic silhouette), plus a few coconuts nestled in the crown.
  // Fronds are filled tapered blade shapes (not thin strokes) so the canopy
  // reads as a solid, full silhouette rather than a spidery wireframe.
  // `C` maps a base color through the distance-haze blend.
  function drawCoconutPalm(ctx, size, lean, C) {
    const trunkH = size * 2.2; // tall Caribbean coconut proportions
    // Pronounced arcing lean — coconut palms on a shoreline bow well off
    // vertical rather than standing up like telephone poles.
    const leanX = size * (0.34 + lean * 0.28);

    // Trunk: strongly curved, wider at the base tapering toward the crown
    ctx.fillStyle = C('#4a3624');
    ctx.beginPath();
    ctx.moveTo(-size * 0.09, 0);
    ctx.quadraticCurveTo(leanX * 0.25, -trunkH * 0.55, leanX, -trunkH);
    ctx.lineTo(leanX + size * 0.07, -trunkH);
    ctx.quadraticCurveTo(leanX * 0.25 + size * 0.12, -trunkH * 0.52, size * 0.11, 0);
    ctx.closePath();
    ctx.fill();
    // Ring ridges up the trunk — the coconut palm's segmented bark
    ctx.strokeStyle = C('#3a2a1a');
    ctx.lineWidth = Math.max(0.6, size * 0.015);
    for (let i = 1; i <= 4; i++) {
      const t = i / 5;
      const rx = (-size * 0.09) * (1 - t) + leanX * t + leanX * 0.25 * t * (1 - t) * 2;
      ctx.beginPath();
      ctx.moveTo(rx - size * 0.02, -trunkH * t);
      ctx.lineTo(rx + size * (0.1 - t * 0.03), -trunkH * t);
      ctx.stroke();
    }

    // Crown sits at the top of the leaning trunk
    const crownX = leanX + size * 0.035;
    const crownY = -trunkH;

    ctx.save();
    ctx.translate(crownX, crownY);

    // A solid hub fill beneath the fronds merges their bases into one clump
    ctx.fillStyle = C('#173c25');
    ctx.beginPath();
    ctx.ellipse(0, size * 0.06, size * 0.22, size * 0.16, 0, 0, Math.PI * 2);
    ctx.fill();

    // Fronds: long blades that arch up and out, then droop hard at the tips —
    // the umbrella-like coconut crown, wider and droopier than before.
    const frondAngles = [-80, -52, -26, -4, 18, 42, 66, 96, 126];
    frondAngles.forEach((deg, i) => {
      const a = (deg * Math.PI) / 180;
      const len = size * (1.1 + Math.abs(Math.sin(a)) * 0.35);
      const dirX = Math.sin(a);
      const dirY = -Math.abs(Math.cos(a)) * 0.6 - 0.25;
      const dLen = Math.hypot(dirX, dirY) || 1;
      const ndx = dirX / dLen, ndy = dirY / dLen;
      const perpX = -ndy, perpY = ndx; // perpendicular direction, for blade width

      const midX = dirX * len * 0.6;
      const midY = dirY * len * 0.5;
      const endX = dirX * len * 1.12;
      const endY = midY + len * 0.68; // strong droop back downward at the tip

      const baseW = size * (0.14 + (i % 3) * 0.02);
      const midW = size * 0.085;

      // Alternate two green tones so overlapping fronds separate visually
      ctx.fillStyle = C(i % 2 === 0 ? '#1e5031' : '#173f27');
      ctx.beginPath();
      ctx.moveTo(perpX * baseW * 0.5, perpY * baseW * 0.5);
      ctx.quadraticCurveTo(midX + perpX * midW * 0.5, midY + perpY * midW * 0.5, endX, endY);
      ctx.quadraticCurveTo(midX - perpX * midW * 0.5, midY - perpY * midW * 0.5, -perpX * baseW * 0.5, -perpY * baseW * 0.5);
      ctx.closePath();
      ctx.fill();
    });

    // Coconut cluster nestled under the crown
    ctx.fillStyle = C('#2f2115');
    for (let i = 0; i < 4; i++) {
      ctx.beginPath();
      ctx.arc((i - 1.5) * size * 0.075, size * 0.07, size * 0.055, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // Classic saguaro: tall rounded trunk, two upward-curving capsule arms at
  // per-instance heights, vertical rib lines for the fluted surface.
  function drawSaguaro(ctx, size, v, C) {
    const bw = size * 0.17;
    const bh = size * 1.05;
    ctx.fillStyle = C('#2e6b3f');
    capsulePath(ctx, -bw / 2, -bh, bw, bh + bw / 2);
    ctx.fill();
    const armW = bw * 0.8;
    const reach = size * 0.2;
    const aY1 = -bh * (0.48 + v * 0.12);
    const aY2 = -bh * (0.64 + v * 0.12);
    // left arm: horizontal stub out, then riser up
    capsulePath(ctx, -bw / 2 - reach, aY1, reach + armW, armW);
    ctx.fill();
    capsulePath(ctx, -bw / 2 - reach, aY1 - size * 0.3, armW, size * 0.3 + armW);
    ctx.fill();
    // right arm, a little higher and shorter
    capsulePath(ctx, bw / 2 - armW * 0.4, aY2, reach + armW * 0.4, armW);
    ctx.fill();
    capsulePath(ctx, bw / 2 + reach - armW, aY2 - size * 0.24, armW, size * 0.24 + armW);
    ctx.fill();
    // ribs
    ctx.strokeStyle = C('#1e4a2c');
    ctx.lineWidth = Math.max(0.6, size * 0.014);
    for (let i = -1; i <= 1; i++) {
      ctx.beginPath();
      ctx.moveTo(i * bw * 0.26, -bw * 0.4);
      ctx.lineTo(i * bw * 0.26, -bh * 0.94);
      ctx.stroke();
    }
  }

  // Temperate deciduous tree: tapered trunk + a canopy of clustered leaf
  // blobs, with lighter highlight blobs so the crown reads as a lit volume.
  function drawLeafyTree(ctx, size, lean, C) {
    const trunkW = size * 0.09;
    const trunkH = size * 0.62;
    const topX = lean * size * 0.1;
    ctx.fillStyle = C('#3b2c1f');
    ctx.beginPath();
    ctx.moveTo(-trunkW, 0);
    ctx.quadraticCurveTo(lean * size * 0.06, -trunkH * 0.55, topX - trunkW * 0.4, -trunkH);
    ctx.lineTo(topX + trunkW * 0.4, -trunkH);
    ctx.quadraticCurveTo(trunkW * 0.7 + lean * size * 0.06, -trunkH * 0.5, trunkW, 0);
    ctx.closePath();
    ctx.fill();
    const cy = -trunkH - size * 0.1;
    ctx.fillStyle = C('#22482a');
    [[0, -0.08, 0.34], [-0.26, 0.04, 0.26], [0.26, 0.02, 0.27], [0, 0.14, 0.3], [-0.12, -0.22, 0.24], [0.15, -0.19, 0.23]].forEach(([bx, by, br]) => {
      ctx.beginPath();
      ctx.ellipse(topX + bx * size, cy + by * size, br * size, br * size * 0.85, 0, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.fillStyle = C('#36663c');
    [[-0.08, -0.18, 0.15], [0.18, -0.08, 0.12], [-0.22, -0.02, 0.11]].forEach(([bx, by, br]) => {
      ctx.beginPath();
      ctx.ellipse(topX + bx * size, cy + by * size, br * size, br * size * 0.8, 0, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  // Conifer: short trunk + three overlapping triangular tiers.
  function drawPine(ctx, size, C) {
    ctx.fillStyle = C('#2f2418');
    ctx.fillRect(-size * 0.035, -size * 0.2, size * 0.07, size * 0.2);
    ctx.fillStyle = C('#1d4430');
    for (let i = 0; i < 3; i++) {
      const half = size * (0.26 - i * 0.06);
      const yb = -size * (0.14 + i * 0.26);
      ctx.beginPath();
      ctx.moveTo(-half, yb);
      ctx.lineTo(half, yb);
      ctx.lineTo(0, yb - size * 0.4);
      ctx.closePath();
      ctx.fill();
    }
  }

  // Low shrub made of overlapping puffs; color varies (green vs dry sage).
  function drawBush(ctx, size, C, col) {
    ctx.fillStyle = C(col);
    [[-0.2, -0.1, 0.17], [0, -0.17, 0.21], [0.2, -0.09, 0.16]].forEach(([bx, by, br]) => {
      ctx.beginPath();
      ctx.ellipse(bx * size, by * size, br * size, br * size * 0.8, 0, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  // Larger rounded shrub: a mound of leaf lobes with a lighter lit top —
  // fills the middle ground between low bushes and full trees.
  function drawShrub(ctx, size, v, C) {
    ctx.fillStyle = C('#24512c');
    [[-0.3, -0.12, 0.22], [-0.1, -0.26, 0.26], [0.14, -0.22, 0.24], [0.32, -0.1, 0.2], [0, -0.08, 0.3]].forEach(([bx, by, br]) => {
      ctx.beginPath();
      ctx.ellipse(bx * size, by * size, br * size, br * size * 0.85, 0, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.fillStyle = C('#3a7040');
    [[-0.14, -0.3, 0.13], [0.1, -0.32, 0.12], [0.24, -0.2, 0.1]].forEach(([bx, by, br], i) => {
      if ((i + Math.floor(v * 10)) % 3 === 2) return; // per-instance variation
      ctx.beginPath();
      ctx.ellipse(bx * size, by * size, br * size, br * size * 0.8, 0, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  // Boulder with a lit facet toward the sunset.
  function drawRock(ctx, size, v, C) {
    ctx.fillStyle = C('#4f4759');
    ctx.beginPath();
    ctx.moveTo(-size * 0.42, 0);
    ctx.lineTo(-size * 0.3, -size * (0.3 + v * 0.12));
    ctx.lineTo(-size * 0.02, -size * (0.44 + v * 0.1));
    ctx.lineTo(size * 0.3, -size * 0.26);
    ctx.lineTo(size * 0.44, 0);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = C('#6b6178');
    ctx.beginPath();
    ctx.moveTo(-size * 0.02, -size * (0.44 + v * 0.1));
    ctx.lineTo(size * 0.3, -size * 0.26);
    ctx.lineTo(size * 0.12, 0);
    ctx.lineTo(-size * 0.05, 0);
    ctx.closePath();
    ctx.fill();
  }

  // Roadside tower block (Nightfall Zone): dark slab with a deterministic
  // pattern of lit windows derived from the sprite's variation seed.
  function drawRoadsideTower(ctx, size, v, C) {
    const bw = size * 0.5;
    const bh = size;
    ctx.fillStyle = C('#191233');
    ctx.fillRect(-bw / 2, -bh, bw, bh);
    ctx.fillStyle = 'rgba(255,208,130,0.75)';
    const key = Math.floor(v * 97);
    for (let c = 0; c < 3; c++) {
      for (let r = 0; r < 6; r++) {
        if ((c * 7 + r * 3 + key) % 5 < 2) {
          ctx.fillRect(-bw / 2 + bw * (0.14 + c * 0.3), -bh + bh * (0.08 + r * 0.15), bw * 0.14, bh * 0.07);
        }
      }
    }
  }

  // Roadside object size multipliers so filler objects stay low & small
  const SPRITE_SIZE_MULT = { bush: 0.5, drybush: 0.45, rock: 0.42, shrub: 0.62 };

  // Large flora gets a dark silhouette outline pass so trees stay readable
  // while flying past at speed instead of smearing into the grass color.
  const OUTLINED_TYPES = { palm: 1, tree: 1, pine: 1, cactus: 1 };

  // Renders one flora/rock shape with the given color mapper `C`. Called
  // twice for outlined types: once as a slightly enlarged dark silhouette,
  // then again with real colors on top.
  function drawFloraShape(ctx, type, size, lean, v, C) {
    if (type === 'palm') drawCoconutPalm(ctx, size, lean, C);
    else if (type === 'cactus') drawSaguaro(ctx, size * 1.5, v, C);
    else if (type === 'tree') drawLeafyTree(ctx, size * 1.35, lean, C);
    else if (type === 'pine') drawPine(ctx, size * 1.7, C);
  }

  // Draws a roadside sprite at a projected position. `haze` (0..1) blends the
  // sprite's colors toward the horizon color, giving atmospheric perspective —
  // far objects fade into the sunset instead of popping in fully dark.
  function drawSprite(ctx, sprite, sx, sy, scale, roadScreenW, theme, haze) {
    let size = roadScreenW * 0.55 * sprite.scale * scale * 1.6;
    size *= SPRITE_SIZE_MULT[sprite.type] || 1;
    if (size < 1.5) return;
    const hazeCol = theme.sky[2];
    const C = haze > 0.02 ? (col) => mixColor(col, hazeCol, haze * 0.8) : (col) => col;
    const v = sprite.v !== undefined ? sprite.v : 0.5;
    ctx.save();
    ctx.translate(sx, sy);
    ctx.fillStyle = 'rgba(5,2,12,0.9)'; // default for landmark shapes below
    if (OUTLINED_TYPES[sprite.type]) {
      // Outline pass: same shape, slightly enlarged, in a flat dark ink —
      // skipped for far-off (heavily hazed) sprites where it would just mud.
      if (size > 12 && haze < 0.45) {
        const O = () => 'rgba(9,4,16,0.8)';
        ctx.save();
        ctx.scale(1.08, 1.05);
        drawFloraShape(ctx, sprite.type, size, sprite.lean || 0, v, O);
        ctx.restore();
      }
      drawFloraShape(ctx, sprite.type, size, sprite.lean || 0, v, C);
    } else if (sprite.type === 'bush') {
      drawBush(ctx, size, C, '#2c5230');
    } else if (sprite.type === 'drybush') {
      drawBush(ctx, size, C, '#6b5a33');
    } else if (sprite.type === 'shrub') {
      drawShrub(ctx, size, v, C);
    } else if (sprite.type === 'rock') {
      drawRock(ctx, size, v, C);
    } else if (sprite.type === 'skyline') {
      drawRoadsideTower(ctx, size, v, C);
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
    currentZoneName = zoneName; // weather picker uses the zone we're actually in
    const theme = ZONE_THEMES[zoneName];
    // Base atmospheric haze; fog & dust storms thicken it considerably
    const hazeBase = Math.min(0.55, weatherAmount('fog') * 0.35 + weatherAmount('dust') * 0.5);
    const wetRoad = weatherAmount('rain');

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

      // Wet-road reflection, fading in/out with the rain cross-fade
      if (wetRoad > 0.03) {
        ctx.save();
        ctx.globalAlpha = 0.12 * wetRoad;
        ctx.fillStyle = '#bfe9ff';
        polygon(ctx, roadCenterX1 - w1, y1, roadCenterX1 + w1, y1, roadCenterX2 + w2, y2, roadCenterX2 - w2, y2);
        ctx.restore();
      }

      // roadside sprites, hazed out with distance (and weather)
      const spriteHaze = Math.min(1, hazeBase + Math.pow(n / DRAW_DISTANCE, 1.6) * 0.75);
      seg.sprites.forEach((sprite) => {
        const sx = roadCenterX1 + sprite.side * (w1 * sprite.offset);
        drawSprite(ctx, sprite, sx, y1, scale1 * 900, w1, theme, spriteHaze);
      });
    }

    renderParticles(ctx, w, h);
    renderWeatherOverlay(ctx, w, h, horizonY);

    return { zoneName, zonesVisitedCount: zonesVisited.size };
  }

  function polygon(ctx, x1, y1, x2, y2, x3, y3, x4, y4) {
    ctx.beginPath();
    ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.lineTo(x3, y3); ctx.lineTo(x4, y4);
    ctx.closePath();
    ctx.fill();
  }

  function renderParticles(ctx, w, h) {
    if (particles.length === 0) return;
    const dust = weatherAmount('dust');
    if (dust < 0.02) return;
    ctx.save();
    ctx.fillStyle = '#e7b478';
    particles.forEach((p) => {
      ctx.globalAlpha = p.alpha * dust;
      ctx.beginPath();
      // stretched horizontally so grains read as wind-blown streaking sand
      ctx.ellipse(p.x * w, p.y * h, p.size * 2.4, p.size, 0, 0, Math.PI * 2);
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
      const strength = scenicEvent.strength || 0.35;
      const dt1 = scenicEvent.life - scenicEvent.flashAt;
      // Double-pulse: a quick bright flicker followed by a softer afterglow.
      let intensity = 0;
      if (dt1 > 0 && dt1 < 0.09) intensity = 1;
      else if (dt1 >= 0.09 && dt1 < 0.28) intensity = 0.35 * (1 - (dt1 - 0.09) / 0.19);
      if (intensity > 0) {
        const fx = scenicEvent.flashX * w;
        const fy = horizonY - h * 0.06;
        const radius = w * (0.2 + strength * 0.2);
        const g = ctx.createRadialGradient(fx, fy, 0, fx, fy, radius);
        g.addColorStop(0, `rgba(223,233,255,${(0.12 + strength * 0.2) * intensity})`);
        g.addColorStop(1, 'rgba(223,233,255,0)');
        ctx.globalAlpha = 1;
        ctx.fillStyle = g;
        ctx.fillRect(Math.max(0, fx - radius), Math.max(0, fy - radius), radius * 2, radius * 2);

        // Storm strikes: whole-sky lift + a visible jagged bolt down to the horizon
        if (strength > 0.5) {
          ctx.fillStyle = `rgba(225,235,255,${0.1 * strength * intensity})`;
          ctx.fillRect(0, 0, w, horizonY + h * 0.05);
          if (scenicEvent.bolt && dt1 < 0.12) {
            ctx.strokeStyle = `rgba(240,246,255,${0.9 * intensity})`;
            ctx.lineWidth = Math.max(1.5, w * 0.0022);
            ctx.shadowColor = 'rgba(190,215,255,0.9)';
            ctx.shadowBlur = 14;
            ctx.beginPath();
            scenicEvent.bolt.forEach(([bx, by], i) => {
              if (i === 0) ctx.moveTo(bx * w, by * h);
              else ctx.lineTo(bx * w, by * h);
            });
            ctx.stroke();
            ctx.shadowBlur = 0;
          }
        }
      }
    }
    ctx.restore();
  }

  // Weather overlays cross-fade via weatherAmount() so rain, fog and dust
  // storms roll in gradually instead of switching on/off in a single frame.
  function renderWeatherOverlay(ctx, w, h, horizonY) {
    const fog = weatherAmount('fog');
    const rain = weatherAmount('rain');
    const dust = weatherAmount('dust');

    if (fog > 0.01) {
      // Ground mist hugging the horizon plus a faint overall veil
      const g = ctx.createLinearGradient(0, horizonY - h * 0.04, 0, horizonY + h * 0.08);
      g.addColorStop(0, 'rgba(220,225,235,0)');
      g.addColorStop(1, `rgba(220,225,235,${0.2 * fog})`);
      ctx.fillStyle = g;
      ctx.fillRect(0, horizonY - h * 0.04, w, h * 0.12);
      ctx.fillStyle = `rgba(205,212,226,${0.07 * fog})`;
      ctx.fillRect(0, 0, w, h);
    }

    if (rain > 0.01) {
      ctx.save();
      const now = performance.now();
      // Two layers of rain streaks — a fast bright near layer and a slower
      // dimmer far layer — so the downpour has visible depth.
      ctx.strokeStyle = `rgba(185,215,255,${0.28 * rain})`;
      ctx.lineWidth = 1;
      const farDrops = Math.floor(110 * rain);
      for (let i = 0; i < farDrops; i++) {
        const rx = (i * 53 + now / 7) % w;
        const ry = (i * 91 + now / 3.2) % h;
        ctx.beginPath();
        ctx.moveTo(rx, ry);
        ctx.lineTo(rx - 4, ry + 12);
        ctx.stroke();
      }
      ctx.strokeStyle = `rgba(205,230,255,${0.5 * rain})`;
      ctx.lineWidth = 1.6;
      const nearDrops = Math.floor(80 * rain);
      for (let i = 0; i < nearDrops; i++) {
        const rx = (i * 71 + now / 4.5) % w;
        const ry = (i * 113 + now / 1.8) % h;
        ctx.beginPath();
        ctx.moveTo(rx, ry);
        ctx.lineTo(rx - 7, ry + 24);
        ctx.stroke();
      }
      ctx.restore();
    }

    if (dust > 0.01) {
      // Heavy tan veil (thicker toward the horizon) + fast wind-blown streaks;
      // together with the sand-grain particles this reads as a real storm.
      const dg = ctx.createLinearGradient(0, 0, 0, h);
      dg.addColorStop(0, `rgba(201,132,66,${0.18 * dust})`);
      dg.addColorStop(0.5, `rgba(214,150,80,${0.34 * dust})`);
      dg.addColorStop(1, `rgba(201,132,66,${0.2 * dust})`);
      ctx.fillStyle = dg;
      ctx.fillRect(0, 0, w, h);
      ctx.save();
      ctx.strokeStyle = `rgba(232,182,120,${0.55 * dust})`;
      ctx.lineWidth = 2;
      const now = performance.now();
      const streaks = Math.floor(60 * dust);
      for (let i = 0; i < streaks; i++) {
        const raw = (i * 97 - now / 1.6) % (w + 160);
        const sx = ((raw % (w + 160)) + w + 160) % (w + 160) - 80;
        const sy = (i * 61.7) % h;
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(sx + 52, sy + 4);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  function getCurrentWeather() { return weather; }

  // Debug/testing hook: force a weather state immediately (no cross-fade).
  function forceWeather(kind) {
    weather = kind;
    prevWeather = kind;
    weatherBlend = 1;
    weatherTimer = 9999;
  }
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
    forceWeather,
    getZonesVisitedCount,
    getRoadCurvatureAt,
    getZoneForDistance,
    ZONES,
    SEGMENT_LENGTH,
    ROAD_WIDTH,
  };
})();
