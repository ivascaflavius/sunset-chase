# 🌅 Sunset Chase

A relaxing, retro-futuristic synthwave endless driving game, built with plain
HTML, CSS and JavaScript (no frameworks, no build step).

Drive a retro 1980s sports car down a two-lane road through an eternal neon
sunset. The world is procedurally generated, the music reacts to how you
drive, and the core mechanic is simple: **smooth driving keeps the sun
suspended in the sky — mistakes make it sink. When the sun fully sets, the
run ends.**

## 🕹 Play it live

**[ivascaflavius.github.io/sunset-chase](https://ivascaflavius.github.io/sunset-chase/)**

## ▶ Running the game

No build tools or servers are strictly required for most browsers, but
because the game uses `fetch`-free WebAudio/Canvas only, you can simply run
a static file server from the project root and open it, e.g.:

```
npx serve .
# or
python -m http.server 8080
```

Then open `http://localhost:8080` (or `PORT`) in a modern desktop or mobile
browser, in **landscape orientation**.

## 📁 Project structure

| File | Responsibility |
|---|---|
| `index.html` | Markup for the 16:9 stage, all menu/HUD/overlay screens |
| `style.css` | Layout, letterboxing, breathing neon UI, touch zones, filters |
| `controls.js` | Keyboard / gamepad / touch input, normalized into one state |
| `audio.js` | Procedural WebAudio synthwave engine, reactive to driving |
| `world.js` | Procedural road/parallax/zone/weather/particle world renderer |
| `ui.js` | Menu navigation, plate editor, journey log, settings, persistence |
| `game.js` | Main loop, car physics, sunset mechanic, rendering orchestration |
| `assets/` | SVG car silhouettes & license-plate icons |

## 🎮 Controls

**Desktop:** Arrow keys / WASD to steer & accelerate, Space to brake,
Esc to pause. A connected gamepad's left stick + triggers also work.

**Mobile (landscape only):** Translucent on-screen zones — lower-left steers
left, lower-right steers right, bottom-right accelerates, upper-right
brakes.

## 🌇 The Sunset Chase mechanic

- **Perfect line:** stay close to dead-center of the lane at a steady speed
  and the 🎯 HUD meter fills up — once full, the sunset freezes completely.
- Drift off-line, brake hard, slow down, or stop and the meter drains, and
  the sunset resumes sinking right away.
- Minor mistakes (a sharp swerve, hard braking) speed up the descent further.
- Drifting off-road accelerates it even more.
- Sustained perfect-line "flow streaks" cause the sun to rise slightly, the
  road reflections & palm shadows to intensify, and the music to bloom.
- When the sun fully sets, the run ends and your stats are recorded.

## 🧭 Progression (stored in LocalStorage)

- Best run distance & lifetime KM driven
- Longest sunset suspension time & best flow streak
- Zones visited (Palm, Desert, Coastal, Nightfall)
- License plate customization (text, color, icon)
- Unlockable sun styles (classic, pastel, deep purple eclipse, vaporwave
  grid) based on lifetime KM
- Unlockable visual filters, car silhouettes, and gentle achievements

## 🛠 Technical notes

- Rendering uses a classic segment-based pseudo-3D road projection (curves
  + hills) with cached parallax layers (sky/hills/skyline) for GPU-friendly,
  batched draw calls.
- The game loop runs on a **fixed 60Hz timestep with render interpolation**,
  so steering and camera motion stay smooth independent of the display's
  actual frame rate.
- Music is scheduled with a WebAudio look-ahead scheduler and includes a
  simple **audio latency compensation** offset derived from
  `AudioContext.outputLatency`/`baseLatency`.
- The canvas stage always maintains a 16:9 aspect ratio, scaled to fill the
  viewport height with black bars filling any remaining space — no page
  scrolling is ever possible.
- A fullscreen blocking overlay appears automatically in portrait mode and
  is removed the instant the device is rotated to landscape.

## 🙌 Design intent

The primary goal is relaxation, atmosphere and flow — progression exists,
but stays gentle and secondary. Nothing about the achievements or unlocks
is meant to pressure the player; they're just a nice bonus for driving
into as many sunsets as you like.
