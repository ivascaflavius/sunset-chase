/* =========================================================================
   SUNSET CHASE — controls.js
   Unified input layer: keyboard, gamepad, and touch zones.
   Exposes a single global `Controls` object with a normalized state:
     { steer: -1..1, accel: 0..1, brake: 0..1, pauseRequested: bool }
   Other modules poll Controls.state each frame; they never touch DOM
   input events directly.
   ========================================================================= */

const Controls = (() => {

  // Normalized live input state, read by game.js every frame.
  const state = {
    steer: 0,   // -1 = full left, 1 = full right
    accel: 0,   // 0..1
    brake: 0,   // 0..1
  };

  let pauseRequested = false;

  // ----- Keyboard -----------------------------------------------------
  const keys = new Set();

  window.addEventListener('keydown', (e) => {
    keys.add(e.code);
    if (e.code === 'Escape') pauseRequested = true;
  });
  window.addEventListener('keyup', (e) => keys.delete(e.code));

  // If the window/tab loses focus while a key is held (alt-tab, opening dev
  // tools, clicking outside the page, etc.), the browser can swallow the
  // matching 'keyup' event — leaving that key "stuck" in the Set forever,
  // which reads as the car silently auto-accelerating with nobody touching
  // the gas. Clearing all held keys (and touch zones) whenever the page
  // loses focus/visibility guarantees input never gets stuck on.
  function clearAllInput() {
    keys.clear();
    touchState.left = false;
    touchState.right = false;
    touchState.accel = false;
    touchState.brake = false;
  }
  window.addEventListener('blur', clearAllInput);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) clearAllInput();
  });

  function readKeyboard() {
    let steer = 0, accel = 0, brake = 0;
    if (keys.has('ArrowLeft') || keys.has('KeyA')) steer -= 1;
    if (keys.has('ArrowRight') || keys.has('KeyD')) steer += 1;
    if (keys.has('ArrowUp') || keys.has('KeyW')) accel = 1;
    if (keys.has('Space') || keys.has('ArrowDown') || keys.has('KeyS')) brake = 1;
    return { steer, accel, brake };
  }

  // ----- Gamepad (optional) -------------------------------------------
  function readGamepad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const gp of pads) {
      // Some browsers report a "phantom" gamepad slot that exists but isn't
      // actually connected — skip those so a plugged-in-but-idle or fake
      // device can't inject phantom accel/steer input.
      if (!gp || !gp.connected) continue;
      const steer = Math.abs(gp.axes[0]) > 0.12 ? gp.axes[0] : 0;
      const accel = gp.buttons[7] ? gp.buttons[7].value : (gp.buttons[0] ? gp.buttons[0].value : 0);
      const brake = gp.buttons[6] ? gp.buttons[6].value : (gp.buttons[1] ? gp.buttons[1].value : 0);
      if (steer || accel || brake) return { steer, accel, brake };
    }
    return null;
  }

  // ----- Touch zones ----------------------------------------------------
  const touchState = { left: false, right: false, accel: false, brake: false };

  function bindTouchZone(el, key) {
    if (!el) return;
    const on = (ev) => { ev.preventDefault(); touchState[key] = true; el.classList.add('pressed'); };
    const off = (ev) => { if (ev) ev.preventDefault(); touchState[key] = false; el.classList.remove('pressed'); };
    el.addEventListener('touchstart', on, { passive: false });
    el.addEventListener('touchend', off, { passive: false });
    el.addEventListener('touchcancel', off, { passive: false });
    // Mouse fallback for testing on desktop
    el.addEventListener('mousedown', on);
    window.addEventListener('mouseup', off);
  }

  function initTouch() {
    bindTouchZone(document.getElementById('touch-left'), 'left');
    bindTouchZone(document.getElementById('touch-right'), 'right');
    bindTouchZone(document.getElementById('touch-accel'), 'accel');
    bindTouchZone(document.getElementById('touch-brake'), 'brake');
  }

  function readTouch() {
    let steer = 0;
    if (touchState.left) steer -= 1;
    if (touchState.right) steer += 1;
    return {
      steer,
      accel: touchState.accel ? 1 : 0,
      brake: touchState.brake ? 1 : 0,
    };
  }

  // ----- Frame update: merge all sources --------------------------------
  // Simple smoothing (lerp) so steering feels analog even from digital keys.
  function update(dt) {
    const kb = readKeyboard();
    const gp = readGamepad();
    const tc = readTouch();

    let targetSteer = kb.steer || tc.steer || (gp ? gp.steer : 0);
    let targetAccel = Math.max(kb.accel, tc.accel, gp ? gp.accel : 0);
    let targetBrake = Math.max(kb.brake, tc.brake, gp ? gp.brake : 0);

    const lerpSpeed = 6 * dt;
    state.steer += (targetSteer - state.steer) * Math.min(1, lerpSpeed);
    state.accel += (targetAccel - state.accel) * Math.min(1, lerpSpeed * 1.5);
    state.brake += (targetBrake - state.brake) * Math.min(1, lerpSpeed * 1.5);
  }

  function consumePause() {
    const p = pauseRequested;
    pauseRequested = false;
    return p;
  }

  function requestPause() { pauseRequested = true; }

  return {
    state,
    update,
    initTouch,
    consumePause,
    requestPause,
  };
})();
