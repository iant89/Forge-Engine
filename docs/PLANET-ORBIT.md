# Planet orbit: the Mars Orbit Explorer (fe-39)

`?scene=mars-orbit` — code: `examples/src/scenes/marsOrbitScene.ts` (the demo) over reusable engine systems.
Aliases: `?scene=orbit`, `?scene=planet`, `?scene=mars-orbital`.

You start in orbit above a spinning Mars. Drag (mouse or touch) to turn it; let go and it coasts, then resumes
turning by itself about four seconds after you stop. **Double-click / double-tap** the globe to fly down and stand on
the ground at that latitude and longitude; **Return to orbit**, `Esc`, or a **double-click / double-tap on the sky**
(any point whose view ray hits no loaded terrain and is more than 0.5° above the horizon) flies back up. A season slider, a clock,
a *Fly to…* list of weather sites and a touch-diagnostics toggle (`T`) sit in the bottom bar.

## The rule: the engine owns the systems, the demo owns the script

Anything generated or simulated is an engine system with its own tests and docs. The demo contains only its
**scripting** (when, where and how intensely weather happens: `scenes/marsOrbitEvents.ts`), its **props** (the HUD)
and its **camera policy** (`scenes/marsOrbitMath.ts`).

| System | File | What it does |
|---|---|---|
| Planet frames and calendar | `engine/src/environment/planetFrame.ts` | lat/lon ↔ direction, site tangent frames, `planetOrientationForSite`, ray/sphere picking, `PlanetOrbit` (`MARS_ORBIT`: tilt, eccentricity, sol length), `Ls`, the sun direction, local solar time |
| Spin controller | `engine/src/environment/planetSpin.ts` | `PlanetSpinController`: grab-point dragging, inertia, idle auto-spin with a ramp, `animateTo` |
| Weather | `engine/src/environment/planetWeather.ts` | `PlanetWeatherSystem` (season-driven events with envelopes, drifting footprints, point `sample()`, orbit-scale `fillAtmosphere`), `PlanetPolarCaps`, `planetGroundWeather` (sample → `WeatherState`) |
| Mars globe sampler | `engine/src/terrain/mars/globeSampler.ts` | the *same* generator as the ground terrain, evaluated per direction for elevation and albedo |
| Globe | `engine/src/rendering/planetGlobe.ts` | `PlanetGlobe`: progressive, time-sliced bake of a textured, displaced sphere plus a cloud/dust shell and a surface overlay, and a zoomed-in detail patch |
| Detail patch maths | `engine/src/rendering/planetDetail.ts` | bicubic grid lookups, the detail window snapped to globe cells, and the crack-free patch mesh |
| Dust devils | `engine/src/particles/dustDevilField.ts` | `DustDevilField`: a few `VortexColumnParticles` columns spawned around the viewer, scaled by an `activity` dial |
| External sun | `DayNightCycle.externalSunDirection` | the ground sky follows the planet's sun instead of the calendar |
| Sunset aureole | `AtmosphereParams.mieAureole` | a tight per-channel forward Mie lobe; blue is strongest, so a low Mars sun gets a blue glow |
| Space-observer sky | `rendering/shaders/sky.ts`, `environment/atmosphere.ts` | the sky integral starts where the ray enters the atmosphere shell, so the limb glows from orbit |

### The frame trick

The analytic sky and aerial perspective assume the planet centre is straight below the camera. So the planet sits at
`(0, −R, 0)`, the camera stays on the `+Y` axis looking down, and **dragging rotates the planet**, not the camera. A
ground site uses the `MarsSite` frame (`+X` east, `+Y` up, `+Z` north), and `planetOrientationForSite` rotates the planet so
the chosen point is under the camera with north up the screen — the globe's last frame and the terrain's first
frame line up. The sun is rotated into the world with the planet, so the terminator drifts correctly as you spin.

### Orbit → ground

1. A double-tap picks the lat/lon (`pixelRay` → `pickPlanetDirection`).
2. The spin controller eases to the site orientation (2.8 s) while altitude log-eases toward 450 km; the ground world
   (`TerrainWorld`, `DayNightCycle`, `WeatherSystem`, `DustDevilField`) is built at the start of the dive.
3. At the swap altitude the globe hides, the sky settings change from "seen from space" to "standing in it", and
   a butterscotch entry haze (`entryHaze`) covers the swap while the camera descends to eye height (1.7 m, 4.2 s).
4. Return reverses it and frees the ground world's GPU memory.

On the ground, drag to look, wheel/pinch to change eye height (1.7–700 m), WASD to walk. The ground sky, dust haze,
frost, clouds and devils are all read from the same `PlanetWeatherSystem` the orbit view draws from, sampled at the site
and mapped by `planetGroundWeather`. Frost is `surface.snow` and burns off as the sun climbs; devil activity follows
the sun elevation.

## Zooming in: the detail patch

One equirectangular texture for the whole planet is ≈10–20 km per texel, which the closest orbit zoom (900 km) magnifies to
tens of screen pixels per texel. So once the visible cap is narrower than 24° (`detailFocusRadius` in `marsOrbitMath.ts`;
roughly below 2,500 km), the scene points `PlanetGlobe.setDetailFocus` at the ground under the camera every frame, and the globe
bakes a **detail patch** there in the background:

* a latitude/longitude window snapped to the globe mesh's cells, about 1.45× the visible cap so small spins and zooms stay inside it;
* a texture of `detailTexture` texels (tier: 512 / 1024 / 1536) — colour from a coarse grid of full sampler calls, shaded relief
  from a finer grid of the sampler's cheap `elevation` path (over MOLA: the atlas heights, ≈2.6–5 km nodes), the polar-cap overlay on top;
* a mesh `detailQuads` across, displaced by the same heights. The globe leaves the window's cells out of its index buffer while the
  patch shows; the patch's border lies exactly on the globe's cell edges and its outermost cell fades into the globe's shape and
  texture, so there is no crack, step or colour seam.

The previous patch stays up until the next one is baked; a re-bake starts only when the view leaves the patch or zooms in to less than
40% of it. It is dropped (and the full globe drawn again) when you zoom back out. `marsOrbitState().globeDetail` reports it.

The globe's own relief is also smoother now: its slope comes from a bicubic interpolation of the elevation grid, so it no longer bakes one
flat tone per grid cell (the blocky look of a close zoom).

## Weather events (`marsOrbitEvents.ts`)

Each event is a `PlanetWeatherEventDef`: a kind (`dust-storm`, `regional-storm`, `ice-cloud`, `dust-devils`,
`frost`), a footprint (disc or latitude band), a season window in `Ls`, a peak, attack/decay shape, a slow drift
(degrees **per sol**; windows last 100+ sols, so fractions of a degree), and an optional `diurnal` weighting. The shipped
table has the aphelion cloud belt, orographic cloud on the shield volcano, canyon ice fog, polar hoods, a
planet-encircling dust event, regional storms (a southern-basin storm, a northern-lowland storm, a local storm),
polar storms, dust-devil seasons and fields, and basin frost. Seasonal CO₂ caps come from `PlanetPolarCaps`.

## Touch and the diagnostics overlay

`GestureRecogniser` turns raw pointer events into drag, tap, double-tap and pinch with documented thresholds, so mouse and
iOS Safari behave identically (the canvas has `touch-action: none`; a second finger ends a drag without a throw, and
lifting out of a pinch never flings the planet). `TouchDiagnostics` (toggle with `T`, the bottom-bar button or
`?touchdiag=1`) shows pointer, touch and Safari `gesture*` event counts, the canvas `touch-action`, the viewport, dots
under every contact and a rolling event log — for working out why a device is not delivering what you expect.

## URL knobs

| Query | Effect |
|---|---|
| `?tier=low\|medium\|high` | force the quality tier (globe mesh/texture/passes, devils, terrain distance) |
| `?ls=<deg>` | start at a solar longitude |
| `?touchdiag=1` | open the touch diagnostics |
| `?mola=phone\|tablet\|desktop\|off` | real MOLA elevation atlas size (default: from the tier and the device); `off` = the procedural planet |
| `?moinstant=1` | dives and returns land at once (tests, headless) |
| `?mobake=<ms>` | per-frame globe bake budget (default is small so frames stay smooth) |

## Real elevation (fe-40)

The globe and the ground terrain use **real MOLA heights** where the atlas is available (`docs/MARS-TERRAIN.md` §8).
`marsOrbitAtlas.ts` picks the size (`?mola=` or tier + device: iPhone → `phone` 2 MB, iPad/medium → `tablet` 7.6 MB, high →
`desktop` = tablet base + lazy 2048² faces), downloads only that, and caches the face files in IndexedDB. The planet is not drawn
until the base level is in ("loading elevation data…"); if the atlas is missing or the browser cannot decode it the demo falls back
to the procedural planet. On a dive, a `desktop` device fetches the 2048² faces under the site (the 2.8 s orbit approach usually
covers it; otherwise the approach waits up to 12 s with "loading terrain detail…") before the terrain is built, so tiles are
generated once with the finest heights. The HUD overlay reads `elev <size> <res>² <status>`.

## Verification and limits

* Unit: `tests/environment/planetOrbit.test.ts` (frames, calendar, spin, weather, aureole, external sun, sampler,
  globe on the mock device, devils) and `tests/examples/marsOrbitScene.test.ts` (gestures, diagnostics text, camera
  maths, the event script).
* Browser: `npm run check:browser:mars-orbit` (globe renders and bakes, a mouse drag turns it, diagnostics toggle,
  dive to a storm site with dust and terrain, return). It runs under headless SwiftShader at a few fps, so it uses
  `?moinstant=1`; it does **not** measure real-time easing or real-GPU / iOS performance.
* The globe texture is ≈10–21 km per texel procedural, **≈5–20 km over real data** (final grid pass 0.33–0.75°, the atlas nodes
  are 2.6–10 km). Zoomed in, the detail patch brings the view to ≈1–2 km per texel, but its relief can be no finer than the atlas
  (tablet ≈5 km nodes; the desktop 2048² faces are only fetched for a dive). There is one patch level, not a full clipmap.
  The orbit and ground renderings of the same weather are separate (the orbit shows clouds/dust on a shell; the
  ground shows haze, devils and a sheet cloud layer).
* See `docs/KNOWN-ISSUES.md` for the tracked limitations.
