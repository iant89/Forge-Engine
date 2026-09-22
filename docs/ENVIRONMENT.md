# Environment — as built (Phases 8a + 8b)

Phase 8 of `ROADMAP.md` was split in two. This document describes both halves as they exist in the
tree today: §1–§6 are the first half — **where the sun is, what the sky looks like, how far you
can see** — and §7 is the second half — **weather, clouds, water, lightning**, everything that
reacts to that light with simulation state of its own. `docs/VERIFICATION.md` says which assertion
proves each claim; `docs/KNOWN-ISSUES.md` lists the approximations a green run does not remove.

Everything lives in `engine/src/environment/` (`solar.ts`, `atmosphere.ts`, `fog.ts`,
`dayNight.ts`, plus the 8b `weather.ts`, `clouds.ts`, `water.ts`, `lightning.ts`), plus the sky
pass (`rendering/shaders/sky.ts`, `forge.sky`), the water program (`rendering/shaders/water.ts`,
technique `"water"` inside `forge.main`) and fog in the forward shader
(`rendering/shaders/common.ts`, `WGSL_FOG`). The module depends on `scene`, `math` and `core`
only; `rendering` imports it (never the reverse) and `scene` sees its types only.

## 1. Sun position (`solar.ts`)

The NOAA solar calculator equations — Meeus *Astronomical Algorithms* ch. 7 (Julian day), 25
(low-accuracy solar coordinates: geometric mean longitude/anomaly, equation of centre, apparent
longitude with the nutation term, obliquity), 28 (equation of time) — evaluated in degrees exactly
as NOAA publishes them and converted to radians and engine axes at the end.

```ts
const jd = julianDay(2000, 6, 21, 12);               // UTC → Julian day (or julianDayFromDayOfYear)
const pos = solarPosition(jd, 51.48, 0);             // latitude °N, longitude °E
pos.elevation, pos.azimuth                            // radians; azimuth clockwise from north
pos.trueElevation                                     // without refraction
const toSun = sunDirection(pos);                      // unit vector toward the sun, engine axes
const { sunrise, sunset, solarNoon, dayLength } = sunEvents(julianDay(2000, 6, 21), 40, 0); // hours UTC
```

* **Axes.** +Y up, **north = +Z, east = +X**. The world is left-handed with +Z forward, so facing
  north puts east on your right — the geographically correct pair. `toSun = (cos el · sin az, sin el,
  cos el · cos az)`; a `Light` travels along `−toSun`. `elevationAzimuthOf` is the exact inverse.
* **Refraction.** `atmosphericRefractionDeg` is NOAA's piecewise fit (≈ 29′ at the horizon, 0 above
  85°); `solarPosition(…, refraction = false)` gives the geometric elevation.
* **Sunrise/sunset** use NOAA's zenith of 90.833° (refraction + half a disc) with one hour-angle
  refinement, and report polar day/night (`sunrise: null`, `dayLength` 24 or 0).
* **Accuracy.** The low-accuracy series is good to ~0.01° in the sun's position — invisible in a
  shadow or a sky. The tests reproduce Meeus' worked examples to the printed digits (RA/Dec of
  1992-10-13, equation of time 13.7 min) and NOAA facts (day lengths at 40°/60°/80° N, solstice
  declinations, 4 min/° of longitude).

## 2. Atmosphere (`atmosphere.ts` and `shaders/sky.ts`)

A single-scattering Nishita/O'Neil sky around a spherical planet: Rayleigh molecules (scale height
8 km), Mie aerosols (1.2 km, Cornette–Shanks phase with asymmetry `g`), and a tent-shaped ozone
absorption layer (peak 25 km, half-width 15 km), with Bruneton & Neyret's sea-level coefficients.
Below the horizon the model returns the sunlit Lambertian ground seen through the whole view path.

`AtmosphereModel` is the **reference implementation** and the sky shader is its GPU twin: same
integral (midpoint rule on cubically spaced view segments, a light ray per sample), same constants
(delivered as `SkyUniforms`, 128 B, never retyped), same lit-ground term. A change to one is a change
to both. What only the pixel pass adds is the limb-darkened sun disc and a hashed star field that
fades in as the scattered light goes away.

```ts
const model = new AtmosphereModel(createAtmosphere());          // Earth; createAtmosphere({}, MARS_ATMOSPHERE) for Mars
model.skyRadiance(viewDir, sunDir, height, out, 16, 8);         // linear RGB along a direction
model.sunTransmittance(sunDir, height, out, 32);                // colour of direct sunlight
model.skyAmbient(sunDir, height, out);                          // cosine-weighted hemisphere mean (E/π)
model.horizonColor(sunDir, height, out, 8, 0.026, 16, 8);       // mean sky 1.5° above the horizon
model.transmittance(height, dx, dy, dz, out, samples);          // toward space along any direction
```

* **Presets.** `EARTH_ATMOSPHERE` (R 6371 km, atmosphere 80 km, β_R (5.802, 13.558, 33.1)·10⁻⁶,
  β_M 3.996·10⁻⁶ scattering / 4.44·10⁻⁶ extinction, g 0.76, ozone (0.65, 1.881, 0.085)·10⁻⁶, grey
  ground) and `MARS_ATMOSPHERE` (R 3389.5 km, thin CO₂ Rayleigh, dust with β_M (33, 21, 10)·10⁻⁶ /
  (36, 30, 26)·10⁻⁶ — red scatters, blue is absorbed — g 0.7, no ozone, rust ground). Mars values are
  tuned to the qualitative record (butterscotch day sky, bright forward aureole, dim sky overall),
  not measured.
* **Sampling.** View-ray segment *i* spans `tMax·[(i/N)³, ((i+1)/N)³]`. A horizon ray is ~1000 km
  long and nearly all of its in-scattered blue comes from the first few tens of kilometres; with
  uniform segments the first sample sat ~60 km out and 8×4 came out 10× too dark in blue. With the
  cubic spacing 8×4 stays within 0.6–1.1× of a 512×32 reference from 0.5° to 30° elevation
  (pinned). Light rays are uniform.
* **Quality tiers.** `SKY_QUALITY_SAMPLES`: `low` 8×4, `medium` 16×8, `high` 32×16 (view × light).
  The renderer marches with the scene's tier capped by the quality profile
  (`EngineConfig.skyQuality` → `RendererOptions.skyQuality`; `stats.skySamples` reports the result)
  and `DayNightCycle` evaluates its horizon colour with the scene's tier, so the fog colour is the
  horizon the pass draws (under a profile cap the two can differ by the truncation error below).
* **Hemispherical estimates.** `skyAmbient` (24 Fibonacci directions, cosine-weighted) and
  `horizonColor` (8 azimuths) evaluate the Mie lobe with |g| capped at 0.5: a dust lobe with g 0.7
  cannot be integrated by two dozen directions (whichever sample lands nearest the sun dominates),
  and widening the lobe keeps the scattered energy while redistributing it to what the sample set can
  resolve. Both estimates land within 25 % of a 4000-direction reference for Earth and Mars (pinned).
* **Units.** `sunIntensity` is the sun's top-of-atmosphere irradiance per channel in scene units;
  the model returns linear RGB radiance. Because single scattering misses multiple scattering, the
  sky is ~3× too dark relative to the sun; the demo renders the sky at `sky.sunIntensity` 20 against
  a light of 4.2 and scales the derived ambient by 0.6, which reproduces the real sky-to-sun
  irradiance split (~15–20 %). See §6.

### The `forge.sky` pass

Declared by `Renderer.buildFrame` when `scene.settings.skyEnabled && RendererOptions.sky !== false`:

```
forge.main   color: sceneColor (clear)   depth: sceneDepth (store while the sky runs, discard otherwise)
forge.sky    color: sceneColor (load)    depth: sceneDepth (depthReadOnly)   1 triangle, 1 draw
```

* One fullscreen triangle emitted at **z = 1** (the far plane) with `depthCompare: "less-equal"` and
  no depth writes: only pixels no geometry covered are shaded, so there is no overdraw behind terrain.
  The regular `WGSL_FULLSCREEN_VERTEX` emits z = 0 and would overwrite the scene.
* View rays come from `invViewProj`: each corner is unprojected at NDC z = 0 and z = 1 and the
  fragment normalises `far − near`, which is exact for perspective *and* orthographic cameras.
* Own technique (`"sky"`) and bind-group layout: `PerFrameUniforms` (vertex + fragment) and
  `SkyUniforms`. The post layout only binds `float` textures, which is why the sky does not read the
  depth as a texture but tests against it as an attachment — a graph *read*, tracked like any other.
  The mock enforces the spec's rule that a read-only depth attachment carries no load/store ops.
* Output follows the forward shader's contract: scene-referred linear radiance on the HDR path,
  exposure + tone curve + sRGB in-shader on the LDR path (`perFrame.flags` bit 1).
* Cost: `viewSamples × (lightSamples + 1)` exponentials per sky pixel; nothing per frame beyond one
  128-byte uniform write. The pass adds no transient texture (`tests/frame.test.ts`).

### Scene settings

`scene.settings.sky` (`SceneSkySettings`, defaults in `defaultSkySettings()`):

| Field | Meaning |
| --- | --- |
| `sunDirection` | unit vector *toward* the sun in render axes; `null` (default) = the first directional light's `−direction`, else a default. `setSky({ sunDirection })` stores a normalised copy. |
| `sunIntensity` (20), `exposure` (1) | sky radiance scale; `exposure` multiplies the sky only. |
| `turbidity` (2), `rayleigh` (1), `mie` (1) | multipliers on the preset: Mie coefficients are scaled by `mie × turbidity / 2`, Rayleigh by `rayleigh`. |
| `sunAngularRadius` (0.00465), `sunDiscIntensity` (100) | disc size (the real sun) and radiance relative to `sunIntensity × transmittance` (the physical 14 700× would bloom the frame). |
| `starBrightness` (1), `nightEnabled` (true) | star field; stars fade with the scattered light so they never show by day. |
| `seaLevel` (0) | render-local height of the planet surface; the camera's altitude is `y − seaLevel`. |
| `quality` (`medium`) | sample tier, see above. |
| `atmosphere` (`null`) | `AtmosphereParams` or `null` for Earth. Serialised with the scene. |

`scene.setSky(partial)` applies and turns the sky on; `scene.setBackgroundColor()` turns it off (solid
clear). `RenderFrameContext.setSkyOverride(partial)` overrides any field for exactly one frame and is
then cleared — a system can steer the sun or the haze without touching the settings.

## 3. Fog (`fog.ts` and `WGSL_FOG`)

Fog is not a pass. The standard shader blends every fragment toward `fog.color` by the
transmittance of the air between camera and surface, scene-referred (before exposure and the tone
curve) so the HDR and LDR paths agree:

| `fog.mode` | transmittance |
| --- | --- |
| `none` (default) | 1 |
| `linear` | `clamp((end − d) / (end − start), 0, 1)` |
| `exp2` | `exp(−(d · density)²)` |
| `height` | `exp(−τ)`, `τ = density · e^{−k(y_cam − b)} · (1 − e^{−k Δy}) / (k Δy) · d` — the exponential density `density · e^{−k(y − b)}` (`k = heightFalloff`, `b = heightBase`) integrated in closed form along the camera→surface segment (`Δy = y_surface − y_cam`; the `k Δy → 0` limit is handled). Fog pools in valleys and thins with height. |

`fogTransmittance(fog, d, cameraY, surfaceY)` on the CPU and `fogTransmittance(d, cameraY,
surfaceY)` in WGSL are the same formula; the tests compare the height-fog closed form against a
20 000-step brute-force integral. The shader receives the mode and height parameters in
`PerFrameUniforms.fogParams` (`FOG_MODE_ID`), the colour/density/range in the fields that existed
since Phase 2 (they were uploaded but never sampled until now). **The default mode is `none`**: fog is
opt-in via `scene.setFog(mode, options)`; the other defaults are a ready preset.

**Fog and the sky.** The sky pass fogs the *planet ground* it draws below the horizon in every mode
(it is geometry at a known distance), and fogs the sky itself only in `height` mode, whose integral is
finite for upward rays (evaluated over 100 km): the horizon fills with fog and the zenith stays
clear. Linear and exp² fog leave the sky alone — their integral over an infinite path would erase it.
For those modes, keep `fog.color` equal to the sky just above the horizon; `DayNightCycle.driveFog`
does exactly that, and the terrain demo computes it once from `AtmosphereModel.horizonColor`.

## 4. Day/night (`dayNight.ts`)

`DayNightCycle` is a `SceneObject` that owns a calendar clock (`year`, `dayOfYear`, `timeOfDay`,
`latitude`, `longitude`, `timeZone`, `timeScale`) and, every frame, points the scene's sun at where
the sun really is and derives the lighting from the atmosphere:

```ts
const cycle = new DayNightCycle({ latitude: 47, dayOfYear: 172, timeOfDay: 9.5, timeScale: 240 });
scene.add(cycle);                                   // finds the first directional light; enables the sky
cycle.setTime(18.5).apply();                        // scrub; apply() is idempotent for an instant
cycle.timeScale = 0;                                // freeze
cycle.setAtmosphere(MARS_ATMOSPHERE);               // swap planets (keep scene.settings.sky.atmosphere in step)
cycle.stats();                                      // { time: "18:30", day, elevationDeg, azimuthDeg, isDay, sunIntensity }
```

Per `apply()` (sun direction from `solarPosition`, then):

* **Light** (`sun` option or the first directional light; `followRotation` is switched off):
  `direction = −toSun`, `color = sunTransmittance(toSun)` (32 light samples), `intensity =
  sunIntensity × smoothstep(−0.5°, +0.5°, elevation)` — off below the horizon.
* **Ambient** (`driveAmbient`): `scene.settings.ambientColor = max(nightAmbient, skyAmbient ×
  ambientScale)`. `nightAmbient` defaults to (0.02, 0.023, 0.032) linear — starlight/airglow.
* **Fog colour** (`driveFog`): `scene.settings.fog.color = max(nightAmbient, horizonColor)` at the
  scene's sky quality tier.
* **Sky** (`driveSky`): `scene.settings.sky.sunDirection = toSun` and `skyEnabled = true` on attach.
* The two hemispherical integrals (~0.25 ms) are re-evaluated only when the sun has moved by more
  than 0.03° since the last evaluation, or after `refresh()`/`setAtmosphere()`.

Time advances by the frame's **fixed-step budget** (`fixedSteps × fixedDt × timeScale`), so a run of
N steps lands on the same minute regardless of frame rate and the cycle freezes with the clock; a
120 × 1/60 run and a 60 × 1/30 run agree to within one step (pinned, via `ManualClock`, whose
constructor was broken before this phase — it read `this` inside the base constructor). With
`timeZone` and `longitude` at 0, `timeOfDay` is local mean solar time: noon is within the equation
of time (±16 min) of the sun's highest point.

## 5. Demo (`examples/src/scenes/skyScene.ts`, `?scene=sky`)

A 2 km ground plane, a ring of spheres and a gnomon under a `DayNightCycle` running June 21 at 47°N
at 240× (a day in six minutes), HDR + bloom + 3 cascades, height fog (density 0.003, falloff 0.08)
whose colour tracks the horizon. Keys: `[` / `]` scrub by an hour, `T` pauses the clock, `M` swaps
Earth for Mars (sky preset, cycle atmosphere and ground colour together). The HUD prints the clock,
sun elevation/azimuth, light intensity and colour, and the derived ambient and fog colours.
`window.__forge.setTimeOfDay(h)`, `setPlanet("earth" | "mars")`, `setSky(on)` and
`environmentState()` are what `check:browser` drives: noon must be brighter than 01:00, the pass
must vanish when the sky is off, and Mars must present with zero GPU errors. The terrain demo now
runs under the Mars preset with exp² dust haze coloured by the model's horizon.

## 6. Approximations (what a green gate does not erase)

* **Single scattering.** No multiple scattering, so the sky is ~3× darker than reality relative to
  the sun and Earth's horizon is yellowish rather than white; compensate with `sky.sunIntensity` vs
  the light's intensity (the demo's 20 : 4.2) and `ambientScale`. A multiple-scattering LUT is the
  natural follow-up.
* **Sample truncation** at the horizon with `low` quality (up to ~35 % dark in blue against the
  converged integral; `medium` halves it).
* **No moon, no twilight from below the horizon, no aerial perspective on geometry** (fog is the
  only distance cue on surfaces), **no per-object sky lighting** (the ambient is one colour).
* **The sun disc is a look control**, not a physical radiance.
* **Mars' blue sunset aureole** needs a wavelength-dependent Mie lobe; the preset has one `g`.
* **`DayNightCycle` drives one directional light** and does not touch fog density, point/spot lights
  or materials.

## 7. Weather, clouds, water, lightning (Phase 8b)

### 7.1 `WeatherSystem`: the state everything else reads

`environment/weather.ts` holds eight scalars — wind speed + direction, gust factor, temperature,
humidity, precipitation, storm intensity, cloud coverage — and drifts them toward a target with
exact exponential integration (`approachExponential`, one time constant per channel, so the path
never matters), on the fixed-step clock. Four frozen presets (`clear`, `overcast`, `rain`, `storm`)
are the demo keys and the gate's vocabulary. The fields are frozen turbulence advected by the mean
wind: `sampleWindAt` (gust-bounded), `sampleTemperatureAt` (lapse rate + patch field),
`samplePrecipitationAt` (patch-modulated, dry states dry everywhere) — all pure in
(x, z, t, seed). `apply` pushes the driven settings: fog density from precipitation, sky turbidity
from humidity/storm, and cloud coverage + deck wind from cover/mean wind (each behind a `drive*`
switch; the day/night cycle writes fog *colour* and the sun direction, so the two never fight).

### 7.2 Clouds: one deck inside the sky pass

`environment/clouds.ts` is a horizontal plane at `clouds.height` whose density is fbm noise
remapped by the coverage: 0 is clear, 1 is overcast at `density`, and the large-area mean rises
monotonically with the slider. The shading is the documented formula — dense cores transmit less
sun, everything receives the ambient, a `(cos θ)^6` lobe silvers the lining — lit by the 8a sky,
not by new constants: `SkyLightingCache` derives the sun/ambient/horizon tints from the live
`AtmosphereModel` and re-evaluates only when the sun moves (~0.05°) or the atmosphere changes, so
the deck tracks the day/night cycle for free. The same remap and shading run on the CPU and in
WGSL (`rendering/shaders/cloudLayer.ts`, evaluated once per sky pixel before fog), but the noise
bases differ on purpose (Perlin fbm on the CPU, value-noise fbm on the GPU): the tests pin the CPU
statistics, the browser gate pins the GPU's presence and direction. The shader advects the field by
the weather's deck wind over the frame clock.

### 7.3 Water: one Gerstner sum, sampled twice

`environment/water.ts` evaluates the Gerstner sum — vertical `A·sin(f)` plus horizontal
`Q·A·cos(f)` travel with `Q = steepness/(k·A·N)` — with analytic normals and a crest factor that
drives `foamFromCrest`. The water *vertex shader* evaluates the same sum from the same waves
(`WaterUniforms` carries `k` and `Q` precomputed), so gameplay queries
(`WaterSurface.sampleHeight`, buoyancy, soundings) agree with the rendered surface. The fragment
stage shades from the 8a sky: Schlick fresnel toward the horizon tint, a two-lobe sun glint,
noise-broken whitecap foam, standard fog. `WaterSurface` owns the entity and advances `water.time`
on the fixed clock; the mesh is a static grid from `waterGridSource`, assigned (with the `water`
material) by the host, because the environment/rendering boundary runs one way. When the camera
drops below `water.level` the renderer skips `forge.sky` and swaps the frame fog for the murk —
scene settings untouched, `stats.underwater` set.

### 7.4 Lightning: scheduled strikes, one shared flash

`environment/lightning.ts` schedules strikes as a Poisson process at `rate × storm` (storm from the
`WeatherSystem`, else an override), each with a midpoint-displaced bolt grown deterministically
from the seeded stream. The flash is a double stroke (attack/decay + return stroke); while it lives
it drives a point light at the brightest strike, a one-frame sky exposure boost through
`setSkyOverride` (so the clouds flash), and the bolt polylines as debug lines. Thunder is a sound
system's job — the strike's time/position/energy are all it needs.

### 7.5 The `weather` demo

`examples/src/scenes/weatherScene.ts` puts the four together: a lake under the deck with the cycle
running the sun. Keys `1–4` snap the presets, `L` calls a strike, `U` floods the camera (the sea
level rises over the eye — the orbit controller owns the camera, the scene owns the sea),
`[`/`]`/`T` drive the clock. `window.__forge` exposes `setWeather`, `setCoverage` (pins the deck
without touching the weather, for the night A/B), `triggerLightning`, `setUnderwater` and
`weatherState` for the gate.
