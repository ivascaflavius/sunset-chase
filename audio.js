/* =========================================================================
   SUNSET CHASE — audio.js
   Procedural synthwave music engine built entirely on the WebAudio API.
   - Base arpeggiated bass loop + 8-note minor-scale melody generator
   - Reactive layers: filter brightness, panning, pad bloom, tempo/darkness
     driven by the current driving/sunset state each frame
   - Simple "theme memory": each run's melody seed is stored in
     LocalStorage and has a chance of being reused in a future run
   ========================================================================= */

const Audio_ = (() => {
  let ctx = null;
  let masterGain, musicGain, padGain, bassGain, leadGain, bellGain, subGain;
  let filterNode, panNode, reverbNode;
  let delayNode, delayFeedback, delayWetGain;
  let filterLfo, filterLfoGain;
  let noiseBuffer = null;
  let started = false;
  let intensity = 0.7; // 0..1, from Settings "music intensity"
  let enabled = true;  // master on/off toggle, independent of intensity

  // Scheduling
  let nextNoteTime = 0;
  let stepIndex = 0;
  let globalStep = 0; // never wraps — drives the slower chord progression
  const STEP_DUR = 0.22; // seconds per 8th-note style step (tempo baseline)
  let scheduleTimer = null;

  // Reactive targets (set every frame by game.js), smoothed internally
  const target = { brightness: 0.6, pan: 0, bloom: 0, darkness: 0, tempoMul: 1 };
  const current = { brightness: 0.6, pan: 0, bloom: 0, darkness: 0, tempoMul: 1 };

  // Minor scale (A minor) frequencies across two octaves for melody
  const A_MINOR = [220.00, 246.94, 261.63, 293.66, 329.63, 349.23, 392.00, 440.00];

  // A gentle i–VI–III–VII (Am–F–C–G) chord progression underlies the diatonic
  // lead motif — same scale throughout, but the harmony shifts every 2 bars,
  // which is what gives synthwave pads their emotional "drift".
  const CHORDS = [
    { tones: [110.00, 130.81, 164.81] }, // A minor  (A C E)
    { tones: [87.31, 110.00, 130.81] },  // F major  (F A C)
    { tones: [130.81, 164.81, 196.00] }, // C major  (C E G)
    { tones: [98.00, 123.47, 146.83] },  // G major  (G B D)
  ];
  const CHORD_LENGTH_STEPS = 32; // 2 bars per chord

  // Hand-shaped melodic contours (as indices into A_MINOR) instead of pure
  // random note picks — gives the motif an intentional rise-and-resolve arc
  // rather than a flat, aimless sequence of notes.
  const MELODY_SHAPES = [
    [0, 2, 4, 7, 6, 4, 2, 0],
    [2, 4, 7, 6, 4, 2, 0, 2],
    [4, 6, 7, 6, 4, 2, 0, 4],
    [0, 4, 7, 4, 2, 4, 7, 2],
  ];

  let motif = [];  // current run's primary 8-note motif
  let motifB = []; // contrasting answer phrase, swapped in periodically
  let audioLatencyComp = 0.05; // seconds, compensates for output latency

  function loadMotifMemory() {
    try {
      const saved = JSON.parse(localStorage.getItem('sunsetchase_motif') || 'null');
      // ~35% chance to reuse a previous run's motif for continuity
      if (saved && Array.isArray(saved) && Math.random() < 0.35) return saved;
    } catch (e) { /* ignore */ }
    // Pick one of the hand-shaped melodic contours for a more musical arc
    const shape = MELODY_SHAPES[Math.floor(Math.random() * MELODY_SHAPES.length)];
    return shape.map((i) => A_MINOR[i % A_MINOR.length]);
  }

  function saveMotifMemory(m) {
    try { localStorage.setItem('sunsetchase_motif', JSON.stringify(m)); } catch (e) { /* ignore */ }
  }

  function init() {
    if (ctx) return;
    ctx = new (window.AudioContext || window.webkitAudioContext)();

    // Estimate output latency for audio/visual sync compensation
    audioLatencyComp = (ctx.outputLatency || ctx.baseLatency || 0.03) + 0.02;

    masterGain = ctx.createGain();
    masterGain.gain.value = enabled ? intensity : 0;

    filterNode = ctx.createBiquadFilter();
    filterNode.type = 'lowpass';
    filterNode.frequency.value = 2200;

    panNode = ctx.createStereoPanner ? ctx.createStereoPanner() : ctx.createGain();

    reverbNode = ctx.createConvolver();
    reverbNode.buffer = makeImpulseResponse(2.6, 2.4);
    const reverbSend = ctx.createGain();
    reverbSend.gain.value = 0.3;

    musicGain = ctx.createGain();
    padGain = ctx.createGain();
    bassGain = ctx.createGain();
    leadGain = ctx.createGain();
    bellGain = ctx.createGain();
    subGain = ctx.createGain();
    padGain.gain.value = 0.0;
    bassGain.gain.value = 1.1;
    leadGain.gain.value = 0.7;
    bellGain.gain.value = 0.8;
    subGain.gain.value = 0.9;

    // Slow feedback delay on the lead voice for that spacious synthwave "echo"
    delayNode = ctx.createDelay(1.5);
    delayNode.delayTime.value = STEP_DUR * 3;
    delayFeedback = ctx.createGain();
    delayFeedback.gain.value = 0.34;
    delayWetGain = ctx.createGain();
    delayWetGain.gain.value = 0.3;
    leadGain.connect(delayNode);
    delayNode.connect(delayFeedback);
    delayFeedback.connect(delayNode);
    delayNode.connect(delayWetGain);

    // A slow LFO breathes the filter cutoff up & down for gentle movement
    filterLfo = ctx.createOscillator();
    filterLfo.frequency.value = 0.12;
    filterLfoGain = ctx.createGain();
    filterLfoGain.gain.value = 260;
    filterLfo.connect(filterLfoGain);
    filterLfoGain.connect(filterNode.frequency);
    filterLfo.start();

    // Routing: instruments -> filter -> pan -> master (+ parallel reverb send)
    [padGain, bassGain, leadGain, bellGain].forEach((g) => g.connect(filterNode));
    filterNode.connect(panNode);
    delayWetGain.connect(panNode); // echoed lead bypasses the lowpass for clarity
    subGain.connect(panNode); // sub-bass bypasses the reactive lowpass so low end stays felt
    panNode.connect(masterGain);
    filterNode.connect(reverbSend);
    reverbSend.connect(reverbNode);
    reverbNode.connect(masterGain);
    masterGain.connect(ctx.destination);

    noiseBuffer = makeNoiseBuffer(0.08);

    motif = loadMotifMemory();
    saveMotifMemory(motif);
    // Pick a different contour as the "answer" phrase so the lead alternates
    // between two related ideas instead of looping one line forever.
    const bShape = MELODY_SHAPES[Math.floor(Math.random() * MELODY_SHAPES.length)];
    motifB = bShape.map((i) => A_MINOR[i % A_MINOR.length]);

    nextNoteTime = ctx.currentTime + 0.1;
    scheduleTimer = setInterval(scheduler, 25);
    started = true;
  }

  // Generates a short synthetic impulse-response buffer for the reverb tail.
  function makeImpulseResponse(duration, decay) {
    const rate = ctx.sampleRate;
    const length = Math.max(1, Math.floor(rate * duration));
    const impulse = ctx.createBuffer(2, length, rate);
    for (let ch = 0; ch < 2; ch++) {
      const data = impulse.getChannelData(ch);
      for (let i = 0; i < length; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
      }
    }
    return impulse;
  }

  // Short white-noise buffer reused for hat/percussion hits.
  function makeNoiseBuffer(duration) {
    const rate = ctx.sampleRate;
    const length = Math.max(1, Math.floor(rate * duration));
    const buf = ctx.createBuffer(1, length, rate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  // ----- Note scheduling (look-ahead scheduler pattern) -------------------
  function scheduler() {
    if (!ctx) return;
    while (nextNoteTime < ctx.currentTime + 0.15) {
      playStep(stepIndex, nextNoteTime);
      const stepDur = STEP_DUR / Math.max(0.5, current.tempoMul);
      nextNoteTime += stepDur;
      stepIndex = (stepIndex + 1) % 16;
      globalStep++;
    }
  }

  function playStep(step, time) {
    const chordIndex = Math.floor(globalStep / CHORD_LENGTH_STEPS);
    const chord = CHORDS[chordIndex % CHORDS.length];
    const barInChord = Math.floor((globalStep % CHORD_LENGTH_STEPS) / 16);

    // Sub-bass: a felt-more-than-heard sine an octave below the bass note,
    // holding down the root on beat 1 of every bar for warmth & weight.
    if (step === 0) {
      subPluck(chord.tones[0] * 0.25, time, 1.6);
    }

    // Four-on-the-floor kick, harder when the player is pushing the throttle
    if (step % 4 === 0) {
      kick(time, 0.32 + current.brightness * 0.22);
    }
    // Gated snare/clap on the backbeat — the classic synthwave "80s clap".
    // Fades out as the sun sets so late-run audio turns moodier and sparser.
    if ((step === 4 || step === 12) && current.darkness < 0.85) {
      clap(time, (0.14 + current.bloom * 0.1) * (1 - current.darkness * 0.6));
    }

    // Bass: two rolling patterns that alternate per chord, so the low end
    // has motion across the progression instead of one fixed loop.
    if (step % 4 === 0) {
      const patternA = [chord.tones[0] * 0.5, chord.tones[1] * 0.5, chord.tones[0], chord.tones[2] * 0.5];
      const patternB = [chord.tones[0] * 0.5, chord.tones[0], chord.tones[2] * 0.5, chord.tones[1]];
      const bassPattern = chordIndex % 2 === 0 ? patternA : patternB;
      pluck(bassGain, bassPattern[(step / 4) % bassPattern.length], time, 0.4, 'sawtooth', 0.42);
    }

    // Lead melody: alternates between the main motif, its answer phrase and a
    // reversed reprise every two chords — call-and-response instead of a loop.
    if (step % 2 === 0) {
      const phrase = Math.floor(globalStep / (CHORD_LENGTH_STEPS * 2)) % 3;
      const m = phrase === 1 ? motifB : motif;
      const idx = (step / 2) % m.length;
      const note = phrase === 2 ? m[m.length - 1 - idx] : m[idx];
      const bright = 1 - current.darkness * 0.6;
      const freq = note * (0.5 + bright * 0.5 + 0.5);
      // Occasional rest breathes air into the line (skipped at phrase starts)
      if (!(idx !== 0 && Math.random() < 0.08)) pluckLead(freq, time, 0.26);
    }

    // Counter-arpeggio picking out the current chord's tones — adds harmonic
    // motion underneath the melody, gently gated by the flow/bloom amount.
    if (step % 4 === 2) {
      const tone = chord.tones[(step / 2) % chord.tones.length];
      pluck(padGain, tone, time, 0.5, 'triangle', 0.1 + current.bloom * 0.12);
    }

    // Bell arpeggio: sparse, high-register chord tones (an octave up) for a
    // sparkly, melodious top layer — only in alternating bars so it doesn't
    // clutter the mix, more prominent during flow/bloom moments.
    if (barInChord === 1 && step % 4 === 3) {
      const tone = chord.tones[Math.floor(step / 4) % chord.tones.length] * 2;
      bellPluck(tone, time, 0.9);
    }

    // Soft hats for a subtle rhythmic pulse, brighter when accelerating
    if (step % 2 === 1) hat(time, 0.04 + current.brightness * 0.05);

    // Pad bloom: sustained chord swell during flow streaks
    if (step % 16 === 0 && current.bloom > 0.05) {
      pad(padGain, chord.tones, time, 2.8);
    }
  }

  function pluck(destGain, freq, time, dur, type = 'sawtooth', vol = 0.3) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, time);
    g.gain.exponentialRampToValueAtTime(vol, time + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, time + dur);
    osc.connect(g);
    g.connect(destGain);
    osc.start(time);
    osc.stop(time + dur + 0.05);
  }

  // Deep sine sub-bass hit — bypasses the reactive lowpass entirely (routed to
  // subGain) so the low end stays felt even when the filter darkens during a
  // sunset descent.
  function subPluck(freq, time, dur) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, time);
    g.gain.exponentialRampToValueAtTime(0.5, time + 0.04);
    g.gain.exponentialRampToValueAtTime(0.0001, time + dur);
    osc.connect(g);
    g.connect(subGain);
    osc.start(time);
    osc.stop(time + dur + 0.05);
  }

  // Bright, bell-like pluck (sine + a quiet detuned partner) for a sparkling
  // high melodic layer that surfaces occasionally between motif phrases.
  function bellPluck(freq, time, dur) {
    [1, 2.01].forEach((mult, i) => {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq * mult;
      const vol = i === 0 ? 0.22 : 0.07;
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(vol, time + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, time + dur);
      osc.connect(g);
      g.connect(bellGain);
      osc.start(time);
      osc.stop(time + dur + 0.05);
    });
  }

  // Two slightly detuned oscillators in unison give the lead a wider, thicker
  // "supersaw"-adjacent synthwave character instead of a single thin tone.
  function pluckLead(freq, time, dur) {
    [-5, 5].forEach((cents) => {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'square';
      osc.frequency.value = freq;
      osc.detune.value = cents;
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.16, time + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, time + dur);
      osc.connect(g);
      g.connect(leadGain);
      osc.start(time);
      osc.stop(time + dur + 0.05);
    });
  }

  // Analog-style kick: a sine that pitch-drops from ~150Hz to ~42Hz. Routed
  // through subGain so it bypasses the reactive lowpass and always thumps.
  function kick(time, vol) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(150, time);
    osc.frequency.exponentialRampToValueAtTime(42, time + 0.11);
    g.gain.setValueAtTime(vol, time);
    g.gain.exponentialRampToValueAtTime(0.0001, time + 0.26);
    osc.connect(g);
    g.connect(subGain);
    osc.start(time);
    osc.stop(time + 0.3);
  }

  // 80s gated clap: two quick band-passed noise bursts (flam + main hit).
  function clap(time, vol) {
    if (!noiseBuffer) return;
    [0, 0.018].forEach((offset, i) => {
      const src = ctx.createBufferSource();
      src.buffer = noiseBuffer;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1700;
      bp.Q.value = 1.2;
      const g = ctx.createGain();
      const v = i === 0 ? vol * 0.5 : vol;
      g.gain.setValueAtTime(v, time + offset);
      g.gain.exponentialRampToValueAtTime(0.0001, time + offset + 0.09);
      src.connect(bp);
      bp.connect(g);
      g.connect(panNode); // bypass the reactive lowpass so the snap stays crisp
      src.start(time + offset);
      src.stop(time + offset + 0.1);
    });
  }

  // Distant thunder rumble for storm lightning: a long low-passed noise
  // swell that rolls in shortly after the flash.
  function thunder(strength = 1) {
    if (!ctx || !enabled) return;
    const dur = 1.8 + Math.random() * 1.2;
    const src = ctx.createBufferSource();
    src.buffer = makeNoiseBuffer(dur);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 180 + Math.random() * 120;
    const g = ctx.createGain();
    const t = ctx.currentTime + 0.2 + Math.random() * 0.4; // flash-to-boom delay
    const vol = Math.min(0.55, 0.3 * strength + 0.15);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.12);
    g.gain.exponentialRampToValueAtTime(vol * 0.4, t + dur * 0.5);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(lp);
    lp.connect(g);
    g.connect(masterGain);
    src.start(t);
    src.stop(t + dur);
  }

  // A short, high-passed noise burst standing in for a soft hi-hat/shaker.
  function hat(time, vol) {
    if (!noiseBuffer) return;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 6500;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, time);
    g.gain.exponentialRampToValueAtTime(0.0001, time + 0.045);
    src.connect(hp);
    hp.connect(g);
    g.connect(panNode); // bypass the reactive lowpass so hats stay crisp
    src.start(time);
    src.stop(time + 0.06);
  }

  function pad(destGain, freqs, time, dur) {
    freqs.forEach((f) => {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = f;
      g.gain.setValueAtTime(0.0001, time);
      g.gain.linearRampToValueAtTime(0.28 * current.bloom, time + dur * 0.4);
      g.gain.linearRampToValueAtTime(0.0001, time + dur);
      osc.connect(g);
      g.connect(destGain);
      osc.start(time);
      osc.stop(time + dur + 0.1);
    });
  }

  // ----- Reactive parameter updates, called every game frame --------------
  // driveState: { accelAmount, braking, turnAmount, smoothness, sunset01, flow01 }
  function updateFromDriving(driveState, dt) {
    if (!ctx) return;
    target.brightness = 0.4 + driveState.accelAmount * 0.6 - (driveState.braking ? 0.35 : 0);
    target.pan = Math.max(-1, Math.min(1, driveState.turnAmount));
    target.bloom = driveState.flow01;
    target.darkness = driveState.sunset01;
    target.tempoMul = 0.85 + driveState.smoothness * 0.3 - driveState.sunset01 * 0.25;

    const smooth = Math.min(1, dt * 2);
    for (const k in target) current[k] += (target[k] - current[k]) * smooth;

    // Apply to audio graph
    const cutoff = 400 + current.brightness * 3200 - current.darkness * 900;
    filterNode.frequency.setTargetAtTime(Math.max(200, cutoff), ctx.currentTime, 0.2);
    if (panNode.pan) panNode.pan.setTargetAtTime(current.pan, ctx.currentTime, 0.15);
    masterGain.gain.setTargetAtTime(enabled ? intensity : 0, ctx.currentTime, 0.3);
  }

  function setIntensity(v) {
    intensity = Math.max(0, Math.min(1, v));
    if (masterGain) masterGain.gain.setTargetAtTime(enabled ? intensity : 0, ctx ? ctx.currentTime : 0, 0.2);
  }

  // Mutes/unmutes the whole music engine instantly (used by the Settings
  // sound toggle) without tearing down or restarting the scheduler.
  function setEnabled(v) {
    enabled = v;
    if (masterGain) masterGain.gain.setTargetAtTime(enabled ? intensity : 0, ctx ? ctx.currentTime : 0, 0.15);
  }

  function resume() { if (ctx && ctx.state === 'suspended') ctx.resume(); }

  function stop() {
    if (scheduleTimer) clearInterval(scheduleTimer);
    scheduleTimer = null;
    if (ctx) { ctx.close(); ctx = null; }
    started = false;
  }

  function getLatencyCompensation() { return audioLatencyComp; }

  return { init, resume, stop, updateFromDriving, setIntensity, setEnabled, getLatencyCompensation, thunder };
})();
