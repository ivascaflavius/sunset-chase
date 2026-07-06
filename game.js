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
    Audio_.setIntensity(save.settings.music / 100);

    World.reset(Date.now(), save.settings.curvature / 100);

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
    World.ensureAhead(Math.floor(car.distance / World.SEGMENT_LENGTH), UI.getSave().settings.curvature / 100);

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

  // Draws the player's car as a layered rear-view silhouette: fendered rear
  // deck, wraparound light bar, cabin/roofline, license plate + chosen icon,
  // thick-treaded spinning wheels, and a subtle lean/shake so it reads as a
  // real car rather than a static box.
  function drawCar(w, h, styleName, flow01, brakeAmount) {
    const style = CAR_STYLES[styleName] || CAR_STYLES.testarossa;
    const plate = UI.getSave().plate;
    const shakeX = car.shake > 0 ? (Math.random() - 0.5) * car.shake * 10 : 0;
    const cx = w / 2 + car.heading * 34 + shakeX;
    const cy = h * 0.86;
    const carW = w * 0.17;
    const carH = carW * 0.52;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(car.heading * 0.14);

    // Soft ground shadow
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.ellipse(0, carH * 0.6, carW * 0.58, carH * 0.16, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;

    // --- Dark wheel-well cutouts (drawn before wheels/body so tires look tucked in) ---
    ctx.fillStyle = '#050505';
    [-1, 1].forEach((side) => {
      ctx.beginPath();
      ctx.ellipse(side * carW * 0.46, carH * 0.4, carW * 0.19, carH * 0.24, 0, 0, Math.PI * 2);
      ctx.fill();
    });

    // --- Rear wheels (thick tires + spinning rims, tucked into the wells) ---
    drawWheel(-carW * 0.46, carH * 0.42, carW * 0.16, car.wheelAngle);
    drawWheel(carW * 0.46, carH * 0.42, carW * 0.16, car.wheelAngle);

    // --- Body: curved rear deck with bulging fenders over each wheel well ---
    if (flow01 > 0.05) { ctx.shadowColor = style.color; ctx.shadowBlur = 16 * flow01; }
    ctx.fillStyle = style.color;
    ctx.beginPath();
    ctx.moveTo(-carW * 0.5, carH * 0.1);
    // left fender bulge
    ctx.quadraticCurveTo(-carW * 0.56, carH * 0.32, -carW * 0.4, carH * 0.34);
    ctx.lineTo(carW * 0.4, carH * 0.34);
    // right fender bulge
    ctx.quadraticCurveTo(carW * 0.56, carH * 0.32, carW * 0.5, carH * 0.1);
    ctx.quadraticCurveTo(carW * 0.5, -carH * 0.02, carW * 0.4, -carH * 0.05);
    ctx.lineTo(-carW * 0.4, -carH * 0.05);
    ctx.quadraticCurveTo(-carW * 0.5, -carH * 0.02, -carW * 0.5, carH * 0.1);
    ctx.closePath();
    ctx.fill();

    // Subtle rocker-panel shading along the lower body edge for depth
    ctx.globalAlpha = 0.18;
    ctx.fillStyle = '#000';
    ctx.fillRect(-carW * 0.4, carH * 0.24, carW * 0.8, carH * 0.1);
    ctx.globalAlpha = 1;

    // --- Roof / cabin silhouette (narrower, set back, gently tapered) ---
    ctx.beginPath();
    ctx.moveTo(-carW * 0.28, -carH * 0.05);
    ctx.quadraticCurveTo(-carW * 0.24, -carH * (0.3 + style.wedge), -carW * 0.18, -carH * (0.28 + style.wedge));
    ctx.lineTo(carW * 0.18, -carH * (0.28 + style.wedge));
    ctx.quadraticCurveTo(carW * 0.24, -carH * (0.3 + style.wedge), carW * 0.28, -carH * 0.05);
    ctx.closePath();
    ctx.fill();
    ctx.shadowBlur = 0;

    // Rear windshield accent
    ctx.fillStyle = style.accent;
    ctx.beginPath();
    ctx.moveTo(-carW * 0.14, -carH * 0.06);
    ctx.lineTo(-carW * 0.11, -carH * 0.21);
    ctx.lineTo(carW * 0.11, -carH * 0.21);
    ctx.lineTo(carW * 0.14, -carH * 0.06);
    ctx.closePath();
    ctx.fill();

    // --- Wraparound rear light bar: full-width strip, split into corner clusters ---
    const braking = brakeAmount > 0.08;
    const steerAmt = car.wheelAngle;
    ctx.save();
    if (braking) { ctx.shadowColor = '#ff1030'; ctx.shadowBlur = 22; }
    // Faint connecting light strip across the deck (classic 80s wraparound look)
    ctx.fillStyle = braking ? 'rgba(255,45,77,0.55)' : 'rgba(122,16,32,0.4)';
    ctx.fillRect(-carW * 0.4, carH * 0.06, carW * 0.8, carH * 0.05);
    // Bright corner clusters — the side currently turning glows amber instead of red
    [-1, 1].forEach((side) => {
      const turning = Math.abs(steerAmt) > 0.15 && Math.sign(steerAmt) === side;
      ctx.fillStyle = turning ? '#ffb84d' : (braking ? '#ff2d4d' : '#7a1020');
      ctx.fillRect(side * carW * 0.47 - (side > 0 ? carW * 0.16 : 0), carH * 0.05, carW * 0.16, carH * 0.12);
    });
    ctx.restore();

    // --- License plate, centered on the rear bumper, with the chosen icon beside the text ---
    ctx.save();
    ctx.fillStyle = plate.color || '#ffffff';
    const plateW = carW * 0.4, plateH = carH * 0.13;
    ctx.fillRect(-plateW / 2, carH * 0.16, plateW, plateH);
    ctx.strokeStyle = '#222';
    ctx.lineWidth = 1;
    ctx.strokeRect(-plateW / 2, carH * 0.16, plateW, plateH);
    ctx.fillStyle = (plate.color === '#111111') ? '#eee' : '#111';
    ctx.font = `${Math.max(6, plateH * 0.6)}px monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText((plate.text || 'SUNSET1').slice(0, 7), plateW * 0.1, carH * 0.16 + plateH / 2);
    // Small plate icon (palm/cactus/sun/skyline) on the left edge of the plate
    ctx.font = `${Math.max(7, plateH * 0.75)}px sans-serif`;
    ctx.fillText(plate.icon || '🌴', -plateW / 2 + plateW * 0.1, carH * 0.16 + plateH / 2);
    ctx.restore();

    ctx.restore();
  }

  // Draws a single wheel viewed from behind the car: edge-on (a thin ellipse,
  // like looking at the tire tread face-on) when driving straight, opening up
  // into a wider, angled oval — revealing more of the rim — as the car steers,
  // just like a real wheel's visible profile changes as it turns. Includes a
  // visible tire sidewall + inner rim so the wheel reads as having thickness
  // rather than being a flat disc.
  function drawWheel(x, y, r, steerAngle) {
    ctx.save();
    ctx.translate(x, y);
    const openness = Math.min(1, Math.abs(steerAngle)); // 0 = dead straight, 1 = full lock
    const rx = r * (0.32 + openness * 0.68);
    ctx.rotate(steerAngle * 0.35); // slight tilt sells the angled-wheel look

    // Outer tire: dark rubber with a slightly lighter sidewall ring to fake thickness
    ctx.fillStyle = '#0a0a0a';
    ctx.beginPath();
    ctx.ellipse(0, 0, rx, r, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(70,70,70,0.6)';
    ctx.lineWidth = Math.max(1, r * 0.1);
    ctx.beginPath();
    ctx.ellipse(0, 0, rx * 0.86, r * 0.86, 0, 0, Math.PI * 2);
    ctx.stroke();

    // Inner rim (metallic), noticeably smaller than the tire so a sidewall band shows
    const rimRx = rx * 0.58, rimR = r * 0.58;
    ctx.fillStyle = '#3a3a3a';
    ctx.beginPath();
    ctx.ellipse(0, 0, rimRx, rimR, 0, 0, Math.PI * 2);
    ctx.fill();

    // Rim spokes, squashed to match the ellipse so they rotate believably in perspective
    ctx.save();
    ctx.scale(rimRx / rimR, 1);
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
    ctx.ellipse(0, 0, rimRx * 0.22, rimR * 0.22, 0, 0, Math.PI * 2);
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
    Audio_.setIntensity(settings.music / 100);
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
