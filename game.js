/* =========================================================================
   SUNSET CHASE — game.js
   Core game loop, car physics, the "Sunset Chase" mechanic, progression
   hooks, and rendering orchestration. Ties together World, Audio_, Controls
   and UI into a single running game.

   Uses a fixed-timestep update with render interpolation for smooth
   steering/camera motion regardless of display refresh rate.
   ========================================================================= */

(function () {

  // ---------------------------------------------------------------------
  // Canvas & stage sizing
  // ---------------------------------------------------------------------
  const canvas = document.getElementById('game-canvas');
  const ctx = canvas.getContext('2d');
  const stage = document.getElementById('stage');

  function resizeCanvas() {
    const rect = stage.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener('resize', resizeCanvas);

  // ---------------------------------------------------------------------
  // Car silhouette definitions (simple vector shapes, same physics for all)
  // ---------------------------------------------------------------------
  const CAR_STYLES = {
    testarossa: { color: '#ff3ea5', accent: '#ffe27a', bodyLen: 1.0, wedge: 0.25 },
    countach:   { color: '#2de2e6', accent: '#ffffff', bodyLen: 0.95, wedge: 0.4 },
    '944':      { color: '#ffd166', accent: '#111111', bodyLen: 0.85, wedge: 0.12 },
    delorean:   { color: '#c9d6e3', accent: '#7b2ff7', bodyLen: 0.9, wedge: 0.18 },
  };

  const SUN_STYLE_UNLOCKS = [
    { km: 0, style: 'classic' },
    { km: 15, style: 'pastel' },
    { km: 40, style: 'purple' },
    { km: 80, style: 'vaporwave' },
  ];

  // --- "Perfect line" tuning: stay this close to dead-center, at a decent
  // clip, and the sunset freezes completely. Wander off, slow down, or make
  // a mistake and it resumes sinking right away.
  const LINE_TOLERANCE = 0.14;
  const LINE_MIN_SPEED = 0.32;

  function unlockedSunStyle(lifetimeKm) {
    let style = 'classic';
    SUN_STYLE_UNLOCKS.forEach((u) => { if (lifetimeKm >= u.km) style = u.style; });
    return style;
  }

  // ---------------------------------------------------------------------
  // Game state
  // ---------------------------------------------------------------------
  const STATE = { MENU: 'menu', PLAYING: 'playing', PAUSED: 'paused', GAMEOVER: 'gameover' };
  let state = STATE.MENU;

  const car = {
    x: 0,          // lateral position, -1 (left edge) .. 1 (right edge) of road half-width
    lateralVel: 0, // momentum-based lateral velocity (units of road-half-width per second)
    speed: 0,      // 0..1 normalized speed
    distance: 0,   // world-unit distance traveled
    heading: 0,    // visual lean for rendering
    wheelAngle: 0, // visual front-wheel steering angle
    shake: 0,      // off-road rumble jitter magnitude
  };

  const sunset = {
    height01: 0.78,  // 1 = high noon-ish glow, 0 = fully set (game over)
    flow: 0,         // seconds of continuous smooth driving
    flowBest: 0,
    suspensionTime: 0, // seconds survived this run without the sun fully setting
  };

  let smoothnessScore = 1; // rolling estimate 0..1 of how "clean" driving currently is
  let lastSteer = 0;
  let lineProximity = 0; // 0..1 closeness to the perfect driving line, drives the HUD meter
  let neonTrail = []; // trail particle history {x, y, life}
  let wheelSpin = 0; // accumulated wheel rotation angle for spinning-wheel rendering

  // Interpolation buffers for smooth rendering between fixed steps
  let prevCarX = 0, curCarX = 0;
  let prevDistance = 0, curDistance = 0;

  const FIXED_DT = 1 / 60;
  let accumulator = 0;
  let lastFrameTime = 0;

  // ---------------------------------------------------------------------
  // Run lifecycle
  // ---------------------------------------------------------------------
  function startRun() {
    const save = UI.getSave();
    Audio_.init();
    Audio_.resume();
    Audio_.setEnabled(save.settings.soundOn);

    World.reset(Date.now(), 0.5); // fixed, moderate road curvature

    car.x = 0; car.speed = 0; car.distance = 0; car.heading = 0; car.lateralVel = 0; car.wheelAngle = 0; car.shake = 0;
    sunset.height01 = 0.78; sunset.flow = 0; sunset.flowBest = 0; sunset.suspensionTime = 0;
    smoothnessScore = 1; lastSteer = 0; neonTrail = []; wheelSpin = 0; lineProximity = 0;
    prevCarX = curCarX = 0; prevDistance = curDistance = 0;

    state = STATE.PLAYING;
    UI.showHud(true);
    UI.applyVisualFilter(save.settings.filter);
    resizeCanvas();
    accumulator = 0;
    lastFrameTime = performance.now();
  }

  function endRun() {
    state = STATE.GAMEOVER;
    UI.showHud(false);
    const distanceKm = car.distance / 100000;
    const save = UI.getSave();
    const isNewBest = distanceKm > save.bestDistanceKm;
    UI.recordRunResult({
      distanceKm,
      suspensionSeconds: sunset.suspensionTime,
      streakSeconds: sunset.flowBest,
      zonesVisited: zonesVisitedThisRun(),
    });
    UI.showGameOver({ distanceKm, zonesVisited: zonesVisitedThisRun().length, streakSeconds: sunset.flowBest, timeSeconds: sunset.suspensionTime, isNewBest });
  }

  let lastZoneSet = new Set();
  function zonesVisitedThisRun() { return [...lastZoneSet]; }

  function pauseRun() {
    if (state !== STATE.PLAYING) return;
    state = STATE.PAUSED;
    UI.showScreen('pause');
  }
  function resumeRun() {
    if (state !== STATE.PAUSED) return;
    state = STATE.PLAYING;
    UI.showScreen(null);
    lastFrameTime = performance.now();
  }
  function quitToMenu() {
    state = STATE.MENU;
    UI.showHud(false);
  }

  // ---------------------------------------------------------------------
  // Fixed-timestep physics update
  // ---------------------------------------------------------------------
  function update(dt) {
    Controls.update(dt);
    const input = Controls.state;

    prevCarX = curCarX;
    prevDistance = curDistance;

    // --- Steering & lateral physics (momentum + grip, not an instant teleport) ---
    // Road curvature applies a centrifugal-style pull whose strength depends on how
    // fast the car is actually consuming road segments (i.e. real speed), so the
    // pull matches how quickly the curve visually sweeps past on screen.
    const curveHere = World.getRoadCurvatureAt(car.distance);
    const speedUnitsPerSec = car.speed * 6000;
    const segmentsPerSec = speedUnitsPerSec / World.SEGMENT_LENGTH;
    const curveForce = curveHere * segmentsPerSec * 0.012;

    // Steering is a force, not a direct position set — low-speed steering is sluggish
    // (like a real car barely turning while stationary), and grip settles the slide.
    const steerForce = input.steer * (1.0 + car.speed * 2.6);
    const grip = 5.5; // higher = tires "bite" and settle sliding faster

    car.lateralVel += (steerForce - curveForce) * dt;
    car.lateralVel *= Math.max(0, 1 - grip * dt);
    car.x += car.lateralVel * dt;

    const offRoad = Math.abs(car.x) > 1;
    if (offRoad) {
      // Rough shoulder: car shudders and scrubs off speed & control, but doesn't "crash"
      car.lateralVel += (Math.random() - 0.5) * 1.2 * dt * 60;
      car.shake = Math.min(1, car.shake + dt * 4);
    } else {
      car.shake = Math.max(0, car.shake - dt * 3);
    }
    car.x = Math.max(-1.8, Math.min(1.8, car.x));

    // --- Speed physics: acceleration force vs. rolling/air drag & braking ---
    const accel = input.accel;
    const brake = input.brake;
    const rollingDrag = 0.1 + car.speed * 0.18; // more drag the faster you go (air resistance)
    car.speed += accel * 0.5 * dt;
    car.speed -= rollingDrag * dt;
    if (brake > 0) car.speed -= brake * 1.1 * dt;
    if (offRoad) car.speed -= dt * 0.45; // rough terrain scrubs speed hard
    car.speed = Math.max(0, Math.min(1, car.speed));

    car.distance += car.speed * dt * 6000; // world units/sec at full speed
    // Visual lean/heading follows lateral velocity (banking into the turn) rather than raw input
    const targetHeading = Math.max(-1, Math.min(1, car.lateralVel * 0.6 + input.steer * 0.25));
    car.heading += (targetHeading - car.heading) * Math.min(1, dt * 6);
    car.wheelAngle += (input.steer - car.wheelAngle) * Math.min(1, dt * 10);
    wheelSpin += car.speed * dt * 22;

    curCarX = car.x;
    curDistance = car.distance;

    // --- Smoothness / mistake evaluation ---
    const steerJerk = Math.abs(input.steer - lastSteer);
    lastSteer = input.steer;
    const harshBrake = brake > 0.6 && car.speed > 0.3;
    const isMistake = offRoad || harshBrake || steerJerk > 0.5;

    // Smoothness score eases toward 1 (clean) or drops on mistakes
    if (isMistake) smoothnessScore = Math.max(0, smoothnessScore - dt * 1.4);
    else smoothnessScore = Math.min(1, smoothnessScore + dt * 0.35);

    // --- Sunset Chase mechanic: a "perfect driving line" freezes the sunset ---
    // Staying close to dead-center at a reasonable speed holds the sun in
    // place entirely; drifting off-line, slowing down, or a mistake lets it
    // resume sinking immediately — no matter how fast you're otherwise going.
    const onPerfectLine = !isMistake && Math.abs(car.x) < LINE_TOLERANCE && car.speed > LINE_MIN_SPEED;
    // How close the car currently is to the perfect line, 0 (way off) .. 1 (dead center
    // & on-speed) — drives the HUD line-meter regardless of whether it's fully "locked".
    lineProximity = onPerfectLine
      ? 1
      : Math.max(0, 1 - Math.abs(car.x) / (LINE_TOLERANCE * 2.5)) * Math.min(1, car.speed / LINE_MIN_SPEED);

    let descentRate;
    if (onPerfectLine) {
      descentRate = 0; // dead-center & moving well: sunset holds completely still
    } else {
      descentRate = 0.004; // baseline slow descent so runs are finite but relaxed
      if (isMistake) descentRate += (offRoad ? 0.05 : 0.028);
      descentRate = Math.max(0.0015, descentRate);
    }
    sunset.height01 -= descentRate * dt * 30;

    // Flow streaks: sustained perfect-line driving raises the sun slightly & blooms audio/visuals
    if (onPerfectLine) {
      sunset.flow += dt;
      sunset.height01 = Math.min(1, sunset.height01 + dt * 0.006);
    } else {
      sunset.flowBest = Math.max(sunset.flowBest, sunset.flow);
      sunset.flow = Math.max(0, sunset.flow - dt * 2);
    }
    sunset.height01 = Math.max(0, Math.min(1, sunset.height01));
    sunset.suspensionTime += dt;

    // Track zone visits this run
    lastZoneSet.add(World.getZoneForDistance(car.distance));

    // World & audio reactive updates
    World.update(dt, car.speed);
    World.ensureAhead(Math.floor(car.distance / World.SEGMENT_LENGTH), 0.5);

    Audio_.updateFromDriving({
      accelAmount: accel,
      braking: brake > 0.3,
      turnAmount: input.steer,
      smoothness: smoothnessScore,
      sunset01: 1 - sunset.height01,
      flow01: Math.min(1, sunset.flow / 8),
    }, dt);

    // Neon trail spawn while accelerating smoothly
    if (accel > 0.5 && smoothnessScore > 0.6) {
      neonTrail.push({ age: 0, xOff: (Math.random() - 0.5) * 0.15 });
    }
    neonTrail.forEach((t) => (t.age += dt));
    neonTrail = neonTrail.filter((t) => t.age < 0.6);

    if (sunset.height01 <= 0) {
      sunset.flowBest = Math.max(sunset.flowBest, sunset.flow);
      endRun();
    }
  }

  // ---------------------------------------------------------------------
  // Rendering (interpolated between fixed steps for smoothness)
  // ---------------------------------------------------------------------
  function render(alpha) {
    const w = canvas.width / (Math.min(window.devicePixelRatio || 1, 2));
    const h = canvas.height / (Math.min(window.devicePixelRatio || 1, 2));
    ctx.clearRect(0, 0, w, h);

    const renderX = prevCarX + (curCarX - prevCarX) * alpha;
    const renderDist = prevDistance + (curDistance - prevDistance) * alpha;

    const save = UI.getSave();
    const sunStyle = unlockedSunStyle(save.lifetimeKm);
    const flow01 = Math.min(1, sunset.flow / 8);

    const result = World.render(ctx, w, h, renderDist, renderX, 1 - sunset.height01, flow01, sunStyle, World.getCurrentWeather());

    drawNeonTrail(w, h);
    drawCar(w, h, save.settings.car, flow01, Controls.state.brake);

    UI.updateHud(car.distance / 100000, result.zoneName, sunset.height01, car.speed * 220, sunset.suspensionTime, lineProximity);
  }

  // Lightens (positive percent) or darkens (negative percent) a '#rrggbb'
  // hex color by a flat amount per channel. Used for simple body shading.
  function shadeStyleColor(hex, percent) {
    const num = parseInt(hex.replace('#', ''), 16);
    const amt = Math.round(2.55 * percent);
    let r = Math.min(255, Math.max(0, (num >> 16) + amt));
    let g = Math.min(255, Math.max(0, ((num >> 8) & 0x00ff) + amt));
    let b = Math.min(255, Math.max(0, (num & 0x0000ff) + amt));
    return `rgb(${r}, ${g}, ${b})`;
  }

  function drawNeonTrail(w, h) {
    if (neonTrail.length === 0) return;
    const carScreenX = w / 2;
    const carScreenY = h * 0.86;
    ctx.save();
    neonTrail.forEach((t) => {
      const alpha = Math.max(0, 0.5 - t.age * 0.8);
      if (alpha <= 0) return;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = CAR_STYLES[UI.getSave().settings.car]?.color || '#ff3ea5';
      const yy = carScreenY + t.age * 220;
      ctx.beginPath();
      ctx.ellipse(carScreenX + t.xOff * w * 0.3, yy, 10, 3, 0, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.restore();
  }

  // Draws the player's car as a layered rear-view silhouette modeled on 80s
  // wedge supercars (Testarossa/Countach-style): a wide, low, flat rear deck
  // with fender flares that mostly conceal the wheels, horizontal engine-deck
  // louvers, a thin wraparound taillight strip, a small greenhouse/roof bump,
  // license plate + chosen icon, and a subtle lean/shake so it reads as a
  // real car rather than a static box.
  function drawCar(w, h, styleName, flow01, brakeAmount) {
    const style = CAR_STYLES[styleName] || CAR_STYLES.testarossa;
    const plate = UI.getSave().plate;
    const shakeX = car.shake > 0 ? (Math.random() - 0.5) * car.shake * 10 : 0;
    const cx = w / 2 + car.heading * 34 + shakeX;
    const cy = h * 0.86;
    // Wider and flatter than before — real wedge supercars read as low & broad
    // from behind, not tall and boxy.
    const carW = w * 0.19;
    const carH = carW * 0.46;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(car.heading * 0.14);

    // Soft ground shadow
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.ellipse(0, carH * 0.62, carW * 0.6, carH * 0.14, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;

    // --- Individual ground-contact shadows beneath each wheel: a small flat
    // ellipse that grounds the tire visually and reinforces its round shape
    // (distinct from the single big shadow under the whole car above).
    ctx.globalAlpha = 0.4;
    ctx.fillStyle = '#000';
    [-1, 1].forEach((side) => {
      ctx.beginPath();
      ctx.ellipse(side * carW * 0.39, carH * 0.62, carW * 0.15, carH * 0.05, 0, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.globalAlpha = 1;

    // --- Rear wheels: smaller & positioned low so the fender flares conceal
    // most of the tire — only a peek of tread shows beneath the body, as on
    // a real low-slung sports car (not two big black balls dominating the view).
    drawWheel(-carW * 0.39, carH * 0.5, carW * 0.115, car.wheelAngle);
    drawWheel(carW * 0.39, carH * 0.5, carW * 0.115, car.wheelAngle);

    // --- Body: wide flat rear deck with bulging fender flares over each wheel well ---
    if (flow01 > 0.05) { ctx.shadowColor = style.color; ctx.shadowBlur = 16 * flow01; }
    ctx.fillStyle = style.color;
    ctx.beginPath();
    ctx.moveTo(-carW * 0.5, carH * 0.02);
    // left fender flare bulges downward/outward to partially cover the wheel
    ctx.quadraticCurveTo(-carW * 0.58, carH * 0.24, -carW * 0.48, carH * 0.4);
    ctx.quadraticCurveTo(-carW * 0.4, carH * 0.46, -carW * 0.3, carH * 0.42);
    ctx.lineTo(carW * 0.3, carH * 0.42);
    // right fender flare
    ctx.quadraticCurveTo(carW * 0.4, carH * 0.46, carW * 0.48, carH * 0.4);
    ctx.quadraticCurveTo(carW * 0.58, carH * 0.24, carW * 0.5, carH * 0.02);
    ctx.quadraticCurveTo(carW * 0.5, -carH * 0.06, carW * 0.4, -carH * 0.09);
    ctx.lineTo(-carW * 0.4, -carH * 0.09);
    ctx.quadraticCurveTo(-carW * 0.5, -carH * 0.06, -carW * 0.5, carH * 0.02);
    ctx.closePath();
    ctx.fill();

    // Lower rocker/valance shading for depth along the flare bottoms
    ctx.globalAlpha = 0.2;
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.ellipse(-carW * 0.39, carH * 0.42, carW * 0.16, carH * 0.08, 0, 0, Math.PI * 2);
    ctx.ellipse(carW * 0.39, carH * 0.42, carW * 0.16, carH * 0.08, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;

    // Specular highlight streak across the upper body — sells a glossy,
    // curved painted surface instead of a flat-shaded block.
    ctx.save();
    ctx.globalAlpha = 0.16;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(-carW * 0.36, -carH * 0.06);
    ctx.quadraticCurveTo(0, -carH * 0.14, carW * 0.36, -carH * 0.06);
    ctx.lineTo(carW * 0.32, -carH * 0.01);
    ctx.quadraticCurveTo(0, -carH * 0.08, -carW * 0.32, -carH * 0.01);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // --- Engine-deck louvers: a bank of thin horizontal slats across the
    // upper rear deck, the signature Testarossa/Countach "vent" detail that
    // most reads as "a real car" rather than a plain painted box.
    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.strokeStyle = shadeStyleColor(style.color, -45);
    ctx.lineWidth = Math.max(1, carH * 0.018);
    const louverY0 = -carH * 0.07, louverY1 = carH * 0.0;
    for (let i = 0; i < 6; i++) {
      const ly = louverY0 + (louverY1 - louverY0) * (i / 5);
      ctx.beginPath();
      ctx.moveTo(-carW * 0.33, ly);
      ctx.lineTo(carW * 0.33, ly);
      ctx.stroke();
    }
    ctx.restore();

    // --- Roof / cabin silhouette: small greenhouse bump set well back &
    // narrower than the body, like a fastback rear window — not a tall cabin.
    ctx.beginPath();
    ctx.moveTo(-carW * 0.24, -carH * 0.09);
    ctx.quadraticCurveTo(-carW * 0.2, -carH * (0.32 + style.wedge), -carW * 0.14, -carH * (0.3 + style.wedge));
    ctx.lineTo(carW * 0.14, -carH * (0.3 + style.wedge));
    ctx.quadraticCurveTo(carW * 0.2, -carH * (0.32 + style.wedge), carW * 0.24, -carH * 0.09);
    ctx.closePath();
    ctx.fill();
    ctx.shadowBlur = 0;

    // Rear windshield accent
    ctx.fillStyle = style.accent;
    ctx.beginPath();
    ctx.moveTo(-carW * 0.11, -carH * 0.1);
    ctx.lineTo(-carW * 0.085, -carH * 0.24);
    ctx.lineTo(carW * 0.085, -carH * 0.24);
    ctx.lineTo(carW * 0.11, -carH * 0.1);
    ctx.closePath();
    ctx.fill();

    // --- Wraparound rear light bar: thin full-width strip (not a chunky
    // block), split into corner clusters — closer to the reference's slim
    // taillight strip than the earlier thick bar.
    const braking = brakeAmount > 0.08;
    const steerAmt = car.wheelAngle;
    ctx.save();
    if (braking) { ctx.shadowColor = '#ff1030'; ctx.shadowBlur = 22; }
    // Faint connecting light strip across the deck (classic 80s wraparound look)
    ctx.fillStyle = braking ? 'rgba(255,45,77,0.5)' : 'rgba(122,16,32,0.35)';
    ctx.fillRect(-carW * 0.42, carH * 0.1, carW * 0.84, carH * 0.035);
    // Bright corner clusters — the side currently turning glows amber instead of red
    [-1, 1].forEach((side) => {
      const turning = Math.abs(steerAmt) > 0.15 && Math.sign(steerAmt) === side;
      ctx.fillStyle = turning ? '#ffb84d' : (braking ? '#ff2d4d' : '#7a1020');
      ctx.fillRect(side * carW * 0.47 - (side > 0 ? carW * 0.15 : 0), carH * 0.08, carW * 0.15, carH * 0.075);
    });
    ctx.restore();

    // --- License plate, centered on the rear bumper, with the chosen icon beside the text ---
    ctx.save();
    ctx.fillStyle = plate.color || '#ffffff';
    const plateW = carW * 0.38, plateH = carH * 0.16;
    ctx.fillRect(-plateW / 2, carH * 0.2, plateW, plateH);
    ctx.strokeStyle = '#222';
    ctx.lineWidth = 1;
    ctx.strokeRect(-plateW / 2, carH * 0.2, plateW, plateH);
    ctx.fillStyle = (plate.color === '#111111') ? '#eee' : '#111';
    ctx.font = `${Math.max(6, plateH * 0.6)}px monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText((plate.text || 'SUNSET1').slice(0, 7), plateW * 0.1, carH * 0.2 + plateH / 2);
    // Small plate icon (palm/cactus/sun/skyline) on the left edge of the plate
    ctx.font = `${Math.max(7, plateH * 0.75)}px sans-serif`;
    ctx.fillText(plate.icon || '🌴', -plateW / 2 + plateW * 0.1, carH * 0.2 + plateH / 2);
    ctx.restore();

    ctx.restore();
  }

  // Draws a rounded-rectangle "capsule" (stadium) path — a straight-sided
  // shape with semicircular caps — used for the tire/rim so wheels read as
  // having real cylindrical thickness instead of collapsing into a paper-thin
  // ellipse when the car drives straight and steerAngle ~= 0.
  function pathCapsule(cx, cy, halfW, halfH) {
    const rad = Math.min(halfW, halfH);
    ctx.beginPath();
    if (ctx.roundRect) {
      ctx.roundRect(cx - halfW, cy - halfH, halfW * 2, halfH * 2, rad);
    } else {
      // Manual fallback path for browsers without roundRect support.
      ctx.moveTo(cx - halfW, cy - halfH + rad);
      ctx.arcTo(cx - halfW, cy - halfH, cx, cy - halfH, rad);
      ctx.arcTo(cx + halfW, cy - halfH, cx + halfW, cy - halfH + rad, rad);
      ctx.lineTo(cx + halfW, cy + halfH - rad);
      ctx.arcTo(cx + halfW, cy + halfH, cx, cy + halfH, rad);
      ctx.arcTo(cx - halfW, cy + halfH, cx - halfW, cy + halfH - rad, rad);
      ctx.closePath();
    }
  }

  // Draws a single wheel viewed from behind the car. The tire is rendered as
  // a capsule (stadium) rather than a flat ellipse, so it always shows real
  // sidewall thickness — even dead-on when driving straight — instead of
  // collapsing into a hairline sliver. Widens/opens up as the car steers,
  // revealing more of the metallic rim, just like a real wheel's visible
  // profile changes when turning.
  function drawWheel(x, y, r, steerAngle) {
    ctx.save();
    ctx.translate(x, y);
    const openness = Math.min(1, Math.abs(steerAngle)); // 0 = dead straight, 1 = full lock
    // Minimum thickness floor so the tire never vanishes into a line.
    const halfW = r * (0.34 + openness * 0.4);
    ctx.rotate(steerAngle * 0.35); // slight tilt sells the angled-wheel look

    // Outer tire: dark rubber capsule with a lighter sidewall ring stroke
    ctx.fillStyle = '#0a0a0a';
    pathCapsule(0, 0, halfW, r);
    ctx.fill();
    ctx.strokeStyle = 'rgba(70,70,70,0.65)';
    ctx.lineWidth = Math.max(1, r * 0.09);
    pathCapsule(0, 0, halfW * 0.82, r * 0.86);
    ctx.stroke();

    // Inner rim (metallic), noticeably smaller than the tire so a sidewall band shows
    const rimHalfW = halfW * 0.55, rimR = r * 0.58;
    ctx.fillStyle = '#3a3a3a';
    pathCapsule(0, 0, rimHalfW, rimR);
    ctx.fill();

    // Rim spokes, squashed to match the capsule width so they rotate believably
    ctx.save();
    ctx.scale(rimHalfW / rimR, 1);
    ctx.rotate(wheelSpin);
    ctx.strokeStyle = `rgba(190,190,190,${0.45 + openness * 0.5})`;
    ctx.lineWidth = Math.max(1, r * 0.14);
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(Math.cos(a) * rimR * 0.85, Math.sin(a) * rimR * 0.85);
      ctx.stroke();
    }
    ctx.restore();

    // Center hub cap
    ctx.fillStyle = '#141414';
    ctx.beginPath();
    ctx.ellipse(0, 0, rimHalfW * 0.4, rimR * 0.22, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  // ---------------------------------------------------------------------
  // Main loop
  // ---------------------------------------------------------------------
  function loop(now) {
    requestAnimationFrame(loop);

    if (Controls.consumePause() && state === STATE.PLAYING) pauseRun();

    if (state !== STATE.PLAYING) {
      lastFrameTime = now;
      return;
    }

    let dt = (now - lastFrameTime) / 1000;
    lastFrameTime = now;
    dt = Math.min(dt, 0.1); // avoid spiral of death on tab-switch

    accumulator += dt;
    while (accumulator >= FIXED_DT) {
      update(FIXED_DT);
      accumulator -= FIXED_DT;
    }
    render(accumulator / FIXED_DT);
  }

  // ---------------------------------------------------------------------
  // Wire up UI actions
  // ---------------------------------------------------------------------
  UI.on('startDrive', () => { lastZoneSet = new Set(); startRun(); });
  UI.on('pauseRequested', pauseRun);
  UI.on('resumeRequested', resumeRun);
  UI.on('quitRequested', quitToMenu);
  UI.on('restartRequested', () => { lastZoneSet = new Set(); startRun(); });
  UI.on('settingsChanged', (settings) => {
    Audio_.setEnabled(settings.soundOn);
  });
  UI.on('orientationChanged', (isLandscape) => {
    if (!isLandscape && state === STATE.PLAYING) pauseRun();
  });

  // ---------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------
  function boot() {
    UI.init();
    Controls.initTouch();
    resizeCanvas();
    // Safety net: some browsers keep the AudioContext suspended even after a
    // click if it wasn't created perfectly in sync with the gesture. Any
    // subsequent pointer/key interaction retries the resume.
    const resumeAudioOnGesture = () => Audio_.resume();
    ['pointerdown', 'keydown', 'touchstart'].forEach((evt) =>
      window.addEventListener(evt, resumeAudioOnGesture, { passive: true })
    );
    requestAnimationFrame(loop);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
