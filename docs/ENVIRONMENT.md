# Environment — as built (Phases 8a + 8b, 17.1 + 17.2)

Phase 8 of `ROADMAP.md` was split in two. This document describes both halves as they exist in the
tree today: §1–§6 are the first half — **where the sun is, what the sky looks like, how far you
can see** — and §7 is the second half — **weather, clouds, water, lightning**, everything that
reacts to that light with simulation state of its own. §8–§9 describe the Phase 17.1 multiple-scattering
and Phase 17.2 aerial-perspective additions. `docs/VERIFICATION.md` says which assertion
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

A Nishita/O'Neil sky around a spherical planet — single scattering, plus the multiple-scattering
table §8 adds on top: Rayleigh molecules (scale height
8 km), Mie aerosols (1.2 km, Cornette–Shanks phase with asymmetry `g`), and a tent-shaped ozone
absorption layer (peak 25 km, half-width 15 km), with Bruneton & Neyret's sea-level coefficients.
Below the horizon the model returns the sunlit Lambertian ground seen through the whole view path.

`AtmosphereModel` is the **reference implementation** and the sky shader is its GPU twin: same
integral (midpoint rule on cubically spaced view segments, a light ray per sample), same constants
(delivered as `SkyUniforms`, 144 B, never retyped), same lit-ground term. A change to one is a change
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
  uniform segments the first sample sat ~60 km out and 8×4 came out 10× too dark in blue. Cubic
  spacing handles the rest of the dome efficiently; the narrow `abs(viewDir.y) < 0.035` horizon band
  floors both CPU and GPU integration at 64×32 and stays within 12% of a 512×32 reference (pinned).
  Light rays are uniform.
* **Quality tiers.** `SKY_QUALITY_SAMPLES`: `low` 8×4, `medium` 16×8, `high` 64×32 (view × light),
  with the horizon floor above. The renderer uses the scene tier capped by the quality profile
  (`EngineConfig.skyQuality` → `RendererOptions.skyQuality`; `stats.skySamples` reports the base tier)
  and `DayNightCycle` uses the same horizon floor, so its driven fog colour matches the drawn horizon.
* **Hemispherical estimates.** `skyAmbient` (24 Fibonacci directions, cosine-weighted) and
  `horizonColor` (8 azimuths) evaluate the Mie lobe with |g| capped at 0.5: a dust lobe with g 0.7
  cannot be integrated by two dozen directions (whichever sample lands nearest the sun dominates),
  and widening the lobe keeps the scattered energy while redistributing it to what the sample set can
  resolve. Both estimates land within 25 % of a 4000-direction reference for Earth and Mars (pinned).
* **Units.** `sunIntensity` is the sun's top-of-atmosphere irradiance per channel in scene units;
  the model returns linear RGB radiance. Single scattering alone leaves the sky ~3× too dark
  relative to the sun; §8's multiple-scattering table closes part of that (measured ~1.3× at noon,
  2–7× at twilight), and the demo's 20 : 4.2 sky-to-light ratio plus `ambientScale` 0.6 still stands
  as the art tuning across the whole day. See §6 and §8.

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
* Own technique (`"sky"`) and bind-group layout (group 0): `PerFrameUniforms` (vertex + fragment),
  `SkyUniforms`, the cloud block, and the multiple-scattering table as a read-only storage buffer at
  binding 3 (§8). The post layout only binds `float` textures, which is why the sky does not read the
  depth as a texture but tests against it as an attachment — a graph *read*, tracked like any other.
  The mock enforces the spec's rule that a read-only depth attachment carries no load/store ops.
* Output follows the forward shader's contract: scene-referred linear radiance on the HDR path,
  exposure + tone curve + sRGB in-shader on the LDR path (`perFrame.flags` bit 1).
* Cost: `viewSamples × (lightSamples + 1)` exponentials per sky pixel, plus one table lookup per
  sample when `multiScattering` is on; nothing per frame beyond one 144-byte uniform write. The pass
  adds no transient texture (`tests/rendering/frame.test.ts`).

### Scene settings

`scene.settings.sky` (`SceneSkySettings`, defaults in `defaultSkySettings()`):

| Field | Meaning |
| --- | --- |
| `sunDirection` | unit vector *toward* the sun in render axes; `null` (default) = the first directional light's `−direction`, else a default. `setSky({ sunDirection })` stores a normalised copy. |
| `sunIntensity` (20), `exposure` (1) | sky radiance scale; `exposure` multiplies the sky only. |
| `turbidity` (2), `rayleigh` (1), `mie` (1) | multipliers on the preset: Mie coefficients are scaled by `mie × turbidity / 2`, Rayleigh by `rayleigh`. |
| `sunAngularRadius` (0.00465), `sunDiscIntensity` (100) | disc size (the real sun) and radiance relative to `sunIntensity × transmittance` (the physical 14 700× would bloom the frame). |
| `starBrightness` (1), `nightEnabled` (true) | Star field plus an atmosphere-attenuated full moon in the anti-solar direction; stars fade with scattered daylight. |
| `seaLevel` (0) | render-local height of the planet surface; the camera's altitude is `y − seaLevel`. |
| `quality` (`medium`) | sample tier, see above. |
| `multiScattering` (`true`) | add the higher orders from the Phase 17.1 table (§8); `false` draws the raw single-scattering sky. |
| `aerialPerspective` (`false`) | apply finite-path atmospheric transmittance and in-scattering to standard and water geometry (Phase 17.2, §9); opt-in because it adds per-fragment work. |
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
* **Schedules** (`schedules`): callbacks run after built-in outputs with smooth complementary
  `daylight`/`night` factors. They can synchronize point/spot lamps, emissive materials, fog density,
  audio or arbitrary scene systems without coupling those systems to the astronomical model.
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
whose colour tracks the horizon. The on-screen panel is the interface: `-1h` / `+1h` scrub by an
hour, `Pause` stops/starts the clock, `Mars` swaps Earth for Mars (sky preset, cycle atmosphere and
ground colour together); the keys `[` / `]`, `T` and `M` are shortcuts on the same actions. The HUD prints the clock,
sun elevation/azimuth, light intensity and colour, and the derived ambient and fog colours.
`window.__forge.setTimeOfDay(h)`, `setPlanet("earth" | "mars")`, `setSky(on)` and
`environmentState()` are what `check:browser` drives: noon must be brighter than 01:00, the pass
must vanish when the sky is off, and Mars must present with zero GPU errors. The terrain demo now
runs under the Mars preset with exp² dust haze coloured by the model's horizon.

## 6. Approximations (what a green gate does not erase)

* **Multiple scattering is approximated** (§8): an isotropic source per height and sun elevation,
  summed as a geometric series, no ground bounce, and twilight columns good to a factor of ~2 rather
  than a few percent. The sky is still darker than reality relative to the sun, just less so — the
  demo's `sky.sunIntensity` 20 against the light's 4.2 and `ambientScale` 0.6 are unchanged.
* **Aerial perspective** (§9) is an opt-in finite-path integration on the standard and water
  forward shaders, not a full volumetric renderer; custom fog remains a separate effect and is
  composed before the atmospheric transfer. **Per-object sky lighting** is still not evaluated —
  ambient remains one colour. The procedural anti-solar moon is always full and has no orbital
  inclination or calendar phase.
* **The sun disc is a look control**, not a physical radiance.
* **Mars' blue sunset aureole** needs a wavelength-dependent Mie lobe; the preset has one `g`.

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
from humidity/storm, cloud coverage + deck wind from cover/mean wind, and directional/ambient
attenuation from cloud + storm cover (each behind a `drive*` switch). Lighting attenuation composes
over fresh `DayNightCycle` output without accumulating; point and spot lights remain local and
untouched.

### 7.2 Clouds: a stack of sheets inside the sky pass (Phase 8b, layered in 17.3)

`environment/clouds.ts` splits the deck into `clouds.layers` (1-4, default 3) horizontal sheets
spread evenly through a slab of `clouds.thickness` metres centred on `clouds.height`. Every sheet
samples the same fbm coverage field as Phase 8b — its own scale (`scale*layerScale^i`), seed, and
advection (`wind*(1 +/- layerDrift/2)*seconds`, so the upper sheets slide through the lower ones) —
and the column weights `0.55 + 0.45*sin(pi*(k+0.5)/n)`, normalised to one, keep a uniform deck's
column density equal to the single plane's at any count: `layers = 1` reproduces 8b exactly, which
is what lets the 8b coverage statistics keep describing the deck. The shading is unchanged — dense
cores transmit less sun, everything receives the ambient, a `(cos t)^6` lobe silvers the lining —
lit by the 8a sky: `SkyLightingCache` derives the sun/ambient/horizon tints from the live
`AtmosphereModel` and re-evaluates only when the sun moves (~0.05 deg) or the atmosphere changes, so
the deck tracks the day/night cycle for free. What Phase 17.3 adds is what shades those sheets and
what they shade:

- **The sun-path march.** `cloudDeckShadowTau` samples the slab above a point along the sun ray.
  The count follows the path length (`round(shadowSteps*span/sub-layer thickness)`, at least one —
  the top sheet is barely shadowed and takes a single sample where the ground takes `shadowSteps`),
  the secant is clamped at the horizon (a sun under 0.02 elevation casts nothing), and each sample
  lands in whichever sub-layer holds its height. The deck's own sheets are shaded by the depth
  above them, and the same depth reaches the scene below: standard, terrain and water fragments
  multiply their directional light by `exp(-2.5*shadowStrength*tau)` while `surfaceShadows` is on,
  so the ground under the deck darkens and water glints (direct sun) are what a cloud takes away.
- **The octave fade.** `dpdx`/`dpdy`, taken in uniform control flow, give the world metres one
  pixel covers at the plane being sampled: the deck's own plane in the sky pass
  (`cloudDeckFootprint`) or the fragment's surface for the shadow (`cloudSurfaceFootprint`). An
  octave whose wavelength falls under that footprint fades out across the 1x-3x Nyquist band, and a
  fully faded octave stops the loop — a grazing ray stops resolving detail it cannot hold (the
  horizon shimmer the phase set out to fix) and the far deck costs fewer octaves. The fade scales
  the octave's contribution and the normaliser keeps counting it at its unfaded amplitude: fading
  the divisor too would cancel the fade out, which is the trap `cloudOctaveWeight`/`cloudFieldLod`
  document on both sides of the twin.

The CPU reference and the WGSL still differ only in their noise basis (Perlin fbm vs value-noise
fbm): the tests pin the CPU arithmetic and its statistics (the 24-sample reference march against the
device's 3 samples, the coverage means, the per-pixel fade A/B, the upload), the browser gate pins
the GPU's layering, its shadow and its stability on a real adapter, and the strict WGSL validator
compiles the shader corpus — including the rule that a derivative must stay in uniform control flow,
which the first version of this shader broke on the device and no other check saw.

### 7.3 Water: one Gerstner sum, sampled twice

`environment/water.ts` evaluates the Gerstner sum — vertical `A·sin(f)` plus horizontal
`Q·A·cos(f)` travel with `Q = steepness/(k·A·N)` — with exact parametric normals from the full
horizontal-displacement Jacobian and a shared four-wave CPU/GPU bound. A crest factor
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
running the sun. The buttons along the bottom of the page are the interface on every device — the
four presets, `Strike`, `Dive`, `-1h`, `+1h`, `Pause` — with the keys `1–4` (presets), `L` (a
strike), `U` (floods the camera: the sea level rises over the eye — the orbit controller owns the
camera, the scene owns the sea) and `[`/`]`/`T` (the clock) as shortcuts onto the very same
callbacks. `window.__forge` exposes `setWeather`, `setCoverage` (pins the deck
without touching the weather, for the night A/B), `triggerLightning`, `setUnderwater` and
`weatherState` for the gate.

`examples/src/controls/weatherTouch.ts` binds the panel in `examples/index.html` to those
callbacks — one action per path, two inputs — fires them on `click` (a touch tap's `pointerdown` +
`pointerup` + `click` must not run a toggle twice), holds the clock buttons (repeat after 400 ms,
~10 h/s) and paints the pressed preset/toggles from the scene's own state, immediately on a press
and every frame after. CSS decides whether it is visible: `body.scene-weather`, any pointer, any
width. The sky demo (`7.x`/Phase 8a) follows the same pattern: its `-1h`/`+1h`/`Pause`/`Mars` panel
(`examples/src/controls/skyTouch.ts`) is the interface, with `[`/`]`/`T`/`M` as shortcuts. Only the
vehicle demo keeps keyboard-first controls (its pad stays touch-only). `npm run check:browser`
drives both panels, at a phone width for weather and a desktop width for sky (see
`docs/VERIFICATION.md`).

## 8. Multiple scattering (Phase 17.1)

The sky integral in §2 is *single* scattering: it stops after one event, so it misses the light that
bounces twice or more. That light is what makes a real sky bright, what keeps the twilight after
sunset (single scattering goes to exactly zero the moment the sun crosses the horizon), and what Mars
— thin air, dust with a strong forward lobe — leans on almost entirely.

The engine uses the standard approximation instead of integrating it: the higher orders are treated
as an isotropic source per point,

```
J₁(x)  = (1/4π) ∫ L₁(x, ω) dω          mean single-scattered radiance around x
L_ms(x) ≈ J₁(x) · σ_s(x) / (1 − ρ(x))    the whole cascade as a geometric series
```

`F(x) = (1/4π)∫ T_view(x,ω) · σ_s(x) · L₁(x,ω) dω` — what the table stores, per unit sun intensity,
per channel — depends on a point only through the height above sea level and the sun's zenith cosine
there (a spherically symmetric atmosphere), so a `heightSamples × sunSamples` table covers every
view. `AtmosphereModel.skyRadiance` and the sky shader both march the same way and add
`Σ T_view · (σ_R·ρ_R + σ_M·ρ_M) · J_ms` per segment, one lookup each.

**Layout.** `MS_LUT_FLOATS_PER_TEXEL = 4`: `rgb = F / sunIntensity` in **linear radiance units** (the
shader does not rescale it — `sunIntensity` is already in the uniform), `a =` mean ρ (diagnostics).
Both axes are warped so the interesting parts get columns: height by `sqrt(h / H)` (dense near the
ground) and sun elevation by `sqrt(|μ|)` around the terminator. `texelValue` reads a texel as stored;
`sample` bilinearly interpolates — at a texel centre the two agree exactly, which
`tests/environment/environment17.test.ts` pins for every texel.

* **`MultiScatteringField` (`environment/multiScattering.ts`)** is the reference. Per texel it averages
  `MULTI_SCATTERING_CPU.directions` (32) Fibonacci directions, marching `steps` (12) cubically spaced
  segments per direction; it reads a τ-to-space table (24 height × 32 μ, cubically marched, `1e30`
  where the sun is blocked) and clamps ρ at `maxSeriesRatio` (0.9) so the series cannot diverge. The
  build costs ~9 ms of JavaScript, allocation-free after construction, and never mutates the model it
  reads. Assign it to `model.multiScattering` and every radiance that model returns — sky, ambient,
  horizon colour — includes the term.
* **`MULTI_SCATTERING_GPU`** (32 × 32, 48 directions, 24 steps) is what the device builds: the three
  times the directions buy a table within ~±5 % of the sphere mean in daylight, where the CPU's 32 sit
  within ~±17 %. Both numbers are pinned against a 256-direction reference in
  `tests/environment/environment17.test.ts`. The Mie lobe is evaluated with |g| capped at
  `ESTIMATE_MIE_ANISOTROPY` (0.5, the same cap `skyAmbient` uses) because a 48-direction average of a
  forward-peaked lobe is decided by whichever sample lands nearest the sun.
* **The two passes.** `forge.sky.ms.table` fills the τ table (768 invocations) and `forge.sky.ms.lut`
  the field (1024 invocations of 48 × 24 samples each), 64 threads per workgroup, sharing one
  bind-group layout: `SkyUniforms` (the frame's own uniform buffer), τ storage, LUT storage. They are
  recorded at the *start* of the frame, before the shadow cascades, so the table is ready for
  `forge.sky`. `Renderer.recordSkyMultiScattering` records them only when the sun has moved more than
  `MS_SUN_EPSILON` (cos 0.5°) or the effective atmosphere changed — compared by value, because a
  day/night cycle mutates `AtmosphereParams` in place. A still frame therefore has the same pass list
  it had before this phase.
* **Getting them on.** `scene.settings.sky.multiScattering` (default `true`) writes a flag into
  `SkyUniforms`; the shader skips the term (and the second pass is not recorded) when it is off. The
  sky bind group always binds the LUT buffer, so toggling the flag never re-creates bind groups.
* **Measured.** Earth, CPU configuration, MS on vs off at luminance: zenith at 10° sun ×1.26,
  horizon away from the sun ×1.30, zenith 6° after sunset ×2.2, horizon away from the sun at that
  hour ×6.3. Mars: zenith ×2.24, horizon ×4.95, dusk zenith ×4.31 — the thin, forward-scattering
  atmosphere gains the most. Cost: the headless CPU build is ~9 ms of JavaScript for the CPU
  configuration; on the device the two dispatches (1.2 M samples) measured 0.11 ms for the table and
  43 ms for the field on SwiftShader — a software rasteriser, so the number to read is the ratio
  against the other passes in the same frame, not its absolute size — and nothing at all on a frame
  whose sun has not moved. On the sky demo at noon, switching the term off darkens 156 062 of
  468 000 pixels by up to 10 luma levels and brightens none.
* **Limits.** No ground bounce (the planet is black to the table: at 20 km an albedo-0.1 ground would
  add 1.5–2.2× to the mean, which the table does not have); the higher orders are isotropic, so no
  wavelength-dependent aureole (Mars' blue sunset); the terminator columns are good to an
  order of magnitude rather than a few percent — the source changes by orders of magnitude inside one
  column and a 48-direction mean cannot resolve the spike; and the CPU path is opt-in, so a scene
  that wants MS in its derived ambient must assign the field itself. `docs/KNOWN-ISSUES.md` §Environment
  lists them with their capability references.
* **Verification.** `tests/environment/environment17.test.ts` (table shape and axes, the sphere-mean
  identity, the twilight decay and exact zeros, the model/ambient/horizon gains, the renderer's pass
  bookkeeping, the WGSL/TS config agreement) and, on a real device, `npm run check:browser:environment`
  (also part of the full browser gate): the two
  passes must run, the sky must draw brighter with the flag on, and the table read back off the device
  must match `Renderer.multiScatteringReference()` (the CPU twin of the same frame) within 15 %.

## 9. Aerial perspective (Phase 17.2)

A sky pixel integrates radiance all the way through the atmosphere shell. A surface pixel used to
receive only the scene's conventional fog, so distant geometry kept its authored colour instead of
picking up the same air. When enabled, the forward fragment programs now integrate the finite
camera-to-surface segment and composite the surface radiance as

```
Lout = Lsurface · Tview + Lair
```

`Tview` is the exponential of Rayleigh scattering, Mie extinction and ozone absorption along the
part of the view ray inside the spherical atmosphere. `Lair` is the direct-sun Rayleigh/Mie source
integrated along that same segment, plus the Phase 17.1 multiple-scattering source when its flag and
LUT are enabled. The view ray is clipped to the atmosphere shell, and the sample spacing is biased
toward its lower-altitude end; sun visibility uses the same ray/sphere and optical-depth helpers as
the sky shader. The scene's `sky.seaLevel`, camera altitude, effective atmosphere, sun direction,
scattering multipliers and `sky.exposure` all come from the same `SkyUniforms` written for the frame.
The arithmetic stays in scene-linear radiance and runs before output exposure/tone mapping, so the
HDR post path and the LDR forward path share it.

* **Enable it.** `scene.settings.sky.aerialPerspective` defaults to `false` and is serialized. Set
  it with `scene.setSky({ aerialPerspective: true })` (which also enables the sky) or override it for
  one frame with `RenderFrameContext.setSkyOverride`. It maps to `perFrame.flags` bit 6. With the bit
  clear, the fragment function returns the input radiance before doing any path integration.
* **Shader coverage and cost.** Both the standard PBR/terrain fragment path and the water fragment
  path call `applyAerialPerspective` after the existing fog blend. The configured sky quality is
  halved for this per-fragment work and clamped to 4–16 view samples × 4–8 light samples (low 4×4,
  medium 8×4, high 16×8); each view sample evaluates sun transmittance, and MS adds one LUT lookup.
  This is a deliberate opt-in trade-off. The sky uniform and LUT are frame bindings 9 and 10; when
  no built LUT is available an inert storage buffer is bound, and the uniform branch ensures it is
  never read. Enabling MS records/builds the LUT before `forge.main` consumes it.
* **CPU reference.** `AtmosphereModel.aerialPerspective(viewDir, distance, height, sunDir, T, Lair,
  viewSamples?, lightSamples?)` fills caller-owned arrays with the same finite-path transfer and
  optional `MultiScatteringField` source. Compose it with `surfaceRadiance[c] * T[c] + Lair[c]`.
  It is allocation-free and is useful for tests/tools; the renderer uses the device implementation.
* **Composition and model limits.** Existing artistic fog still runs first and remains an independent
  medium. For a pure physical-air comparison, disable custom fog; stacking both can deliberately
  tint/fade the air twice. The path assumes the spherical atmosphere's local vertical is render-space
  +Y and clamps below-sea-level camera altitude to sea level, as the sky pass does. This is surface
  scattering, not a volumetric cloud, particle, light-shaft or per-object ambient/IBL pass.
* **Verification.** `tests/environment/environment17.test.ts` checks identity paths, distance-dependent
  transmittance/in-scattering and the optional CPU MS source. `tests/environment/environment.test.ts`
  pins the opt-in default and serialization; `tests/rendering/frame.test.ts` reads back bit 6, checks
  the inert fallback/LUT transition and ensures the underwater path disables it. `check:wgsl` validates
  the standard, terrain and water modules. On real Chromium + SwiftShader, the environment browser
  section toggled only this setting at frozen noon: the flag went false→true and 41,658/468,000
  pixels changed (maximum channel difference 17), with zero GPU errors.

## 10. Ocean, shoreline and tropical cyclones (fe-33)

**Ocean** (`environment/ocean.ts`): `oceanWavesFromWind({ windSpeed, direction, maxHeight, waveCount, choppiness, seed })`
builds a Pierson–Moskowitz sea (Hs = 0.21·U²/g, peak λ from Tp = 2πU/(0.877g), deep-water speeds,
components fanned around the wind) and returns `{ waves, choppiness, foamThreshold, significantHeight }`;
`applyOceanState(scene, state)` writes it. `oceanGridSource(size, segments, amplitude, focusX, focusZ, exponent)`
is a water grid that is dense at a focus point; `oceanQualityForTier(tier)` sizes it (low 128 / medium 192 /
high 288 segments; low evaluates 3 waves).

**Shoreline** (`scene.settings.water.shore`, `WaterShoreSettings`): an analytic sloped bed through
`origin` at `bedLevel`, rising `slope` per metre along `direction` (toward land). The water shader and
the CPU (`shoreDepthAt`, `shoalFactor`, `breakingFactor`, `shoreFoamFactor`, `sampleWater`) share it:
depth colour (`shallowColor` → `deepColor` over `colorDepth`), shoaling to `SHOAL_PEAK` at `breakDepth`
then dying in the surf, a depth-limited cap (H ≤ 0.78·d, `BREAKER_INDEX`), white water on crests across
the surf zone (scaled by the sea's amplitude), and an animated swash band under `foamDepth`. Raising
`water.level` (a surge) floods inland consistently. `water.choppiness` scales every wave's steepness
(Q clamped to 1).

**Coast** (`terrain/coastal.ts`): `coastalHeightAt(params, x, z)` — seabed (exactly the water's shore
bed offshore), beach face, berm, a wandering dune ridge, hinterland; `coastalTerrainSource(...)` meshes
it; `coastalShoreSettings(params, extra)` returns the matching `water.shore`.

**Cyclones** (`environment/cyclone.ts`): script a storm as `CycloneTrack` keyframes (`time, x, z,
maxWind, radiusMaxWind, eyeRadius, rain, surge`). Field functions: `cycloneWindAt` (calm eye, eyewall ramp,
`(Rm/r)^0.55` decay, 20° inflow, hemisphere rotation, forward motion ÷ `timeCompression`),
`cycloneRainAt` (dry eye, eyewall ring, log-spiral bands), `cycloneCoverAt` (clear eye), `cyclonePhaseAt`,
`saffirSimpsonCategory/Label`. `CycloneSystem` runs the track on the fixed clock and, at an `observer`,
drives clouds (cover, density, deck wind, albedo), fog (density + colour), the ocean (wind-driven waves
with a build/decay lag, swell radiating from the centre) and surge; `observed` exposes wind, rain,
cover, phase, `darkness`, light factors and category for the host. `seek(t)` warms the sea up so a
scrub lands on the same sea a playthrough would have.

**Rain** (`particles/precipitation.ts`): `PrecipitationField({ follow, drive })` — camera-following,
wind-slanted GPU rain driven by any `{ intensity, windX, windZ }` callback.

**Foliage sway** (`population/windSway.ts`): `windSway(windX, windZ, t, params)` returns a bend axis,
lean (quadratic drag, saturating), gust rocking and leaf flutter; `windBendWeights(n)` spreads it up a
chain. The engine ships no plant models — the hurricane demo's palms live in `examples/`.

Demo: `?scene=hurricane` (`examples/src/scenes/hurricane.ts` is the storm script; `hurricaneScene.ts`
wires the systems, camera and HUD; `hurricanePalms.ts` is the demo's palm model). `?tier=` forces a tier.

### Local cloud holes (eye of a storm)

`SceneCloudSettings` has a generic local clearing: `holeX`/`holeZ` (render-local metres, fixed in the
world, not advected by the wind), `holeRadius`, `holeWall` and `holeStrength` (0..1, default 0 =
off, so every existing scene is unchanged). Inside the radius the deck fades to clear (soft inner
25 %); across `holeWall` metres outside it the density is raised to the full `density` (a wall
ring). The shader (`cloudHoleApply` in `cloudLayer.ts`) and the CPU twin (`cloudHoleApply` in
`clouds.ts`, applied by `cloudLayerDensityAt`) share the formula, so cloud shadows and tools agree.
The hole needs `coverage > 0` (the deck early-outs when empty).

`CycloneSystem({ eyeHole: { scale, wallScale? } })` drives it: the deck stays overcast through the
eye and the hole follows the storm centre, scaled toward the observer by `scale` (eye radius ×
scale; wall = (Rm − eye) × scale × wallScale, default 1.5). The observer's own `cover` (lighting,
darkness) still opens in the eye.

### Sky exposure dims the deck

`SkyLightingCache.update(sunDir, atmosphere, height, sunIntensity, ambientScale = 1)` now rescales
its cached sun, ambient and horizon tints when the intensity or `ambientScale` changes (before,
the change was ignored until the sun moved, and ambient never scaled). The renderer passes the
sky `exposure` as `ambientScale`, so `setSky({ exposure })` darkens the cloud deck and the water's
sky tint with the atmosphere — how a storm reaches near-black grey. Exposure 1 is unchanged.

### 10.x Storm realism (fe-34)

All of this is engine-side and reusable; the hurricane demo only scripts it.

* **Curvy coast.** `WaterShoreSettings.curveAmp1/curveLength1/curvePhase1` and `curveAmp2/…2`
  (default 0 = straight) wind the waterline: `shoreCurveOffset(curve, across)` is the sum of two
  sinusoids that `shoreDepthAt`, the WGSL `shoreDepth` (`shoreD`/`shoreE`) and
  `coastalHeightAt` all subtract from the along-shore distance, so foam, depth colour and the
  terrain agree. `coastalShoreSettings` copies the curve; `duneRows` (0–2) adds hummock rows
  behind the fore-dune.
* **Sea level.** `water.level = seaLevel + surge + setup + tideOffset`. `cycloneWindSetup(windX, windZ,
  onshoreX, onshoreZ, coef, limit)` is wind set-down (offshore wind pulls the sea back — the
  pre-storm "low tide") and set-up (onshore wind). `CycloneSystem.tideOffset` is a scripted tide.
  `runup: { base, perMetre }` widens `shore.foamDepth` with significant wave height (swash).
  `WaterSurface` now moves its mesh to the live level.
* **Gusts.** `gustiness` (0..1) multiplies the wind by the deterministic `cycloneGustSignal(t, seed)`;
  `observed.gust` / `observed.gustSpeed` expose it. `ceiling {clear, storm}` lowers the deck,
  `scud` speeds the lowest layer, `billow {clear, storm}` drives the deck's billows.
* **Billows.** `clouds.billow` (0..1): `cloudBillow` keeps lumpy structure at full coverage and shades
  dense cores darker, thin edges brighter. `cloudBillowApply` / `cloudDensityAt(..., billow)` mirror it on CPU.
* **Ocean.** Up to 8 components (`MAX_WATER_WAVES`); 5–8 add a near-twin of the peak (wave groups /
  sets), cross-sea and chop. Quality tiers: low 4, medium 6, high 8.
* **Lightning.** `LightningSystem` options `storm()` (rate scale), `center()`, `surfaceAt(x,z)` (ground or
  sea strike height), `branches`, `cloudFlashFraction` (intra-cloud flashes, `bolt.cloudOnly`),
  `boltColor`, `boltWidth`; `paused`; `trigger(position?, energy?, cloudOnly?)`; `lightningBranches()`.
* **Waterspouts.** `WaterspoutSystem` (environment/) spawns seeded Poisson funnels in an area at a
  host-scripted `spawnRate()` (`waterspoutSpawnRate(wind, {threshold, full, perSecond})`), drifts them
  with the steering wind plus wander, and dissipates them (`waterspoutStrength`, rope-out from the
  bottom in `waterspoutFunnelAt`). `WaterspoutVisual` (particles/) renders funnel segments and a spray ring.
  `spawn(at?, life?)` forces one (debug hooks).
* **Wind made visible.** `WindBlownField` with `windBlownPreset("spray"|"spindrift"|"sand"|"mist"|"debris")`;
  `windBlownVelocity` couples particles to the wind.
* **Soundscape.** `StormSoundscape` (audio/) synthesises wind, howl, rain, surf and thunder with WebAudio;
  `stormSoundLevels` is the pure mapping. Browsers need a user gesture, so it is opt-in.
* **Camera buffet.** `windBuffet(t, windSpeed, gust, strength, out)` gives a small offset + roll for a follow camera.

**fe-34 v2 additions.**

* **Visible bolts.** `LightningBoltVisual` (particles/) draws a `LightningSystem`'s live bolts as emissive,
  fog-exempt cylinders sized per segment to `corePixels` on screen at its distance
  (`lightningSegmentRadius`), with a transparent `glowPixels` sheath; brightness follows the flash
  envelope. The system's own debug-line bolt can also be widened (`boltPixels`, `boltGlowPixels`,
  `viewer`, `lightningRibbonStep`). Fixes: a vertical bolt (start straight above the strike) used to
  come out as a straight rod (`seg × up` was zero), and a strike triggered while `paused` never flashed.
* **Gusts** are a pure function of the storm clock and `gustSeed`, so `seek(t)` equals playing to `t`.
* **`darknessGain`** (CycloneSystem): darkness → 1 − (1 − d)^gain, so the rain bands are already dark,
  billowing storm cloud. The billow shading adds a relief term (one extra density sample toward the light).
* **`WaterspoutVisual.fogExempt`** keeps a funnel readable through the storm haze; the lowest segment
  now reaches the sea.

**fe-34 v3.** Waterspouts are particle vortices: `VortexColumnParticles` (particles/vortexColumn.ts)
generalises the Mars dust-devil swarm (column/skirt emit alternation on the GPU vortex spawn, with
swirl and the axis spring) into a reusable engine piece with caller colours (`VORTEX_WATER_LOOK`: white
spray, grey mist, blue-grey condensation). `WaterspoutVisual` now drives one column per spout from
`waterspoutFunnelAt` (lean, bend, widening, rope-out) plus the spray ring; the mesh segments, `segments`,
`color`, `opacity` and `fogExempt` options are gone. The Mars scene still uses its own devil code
(migrating it onto `VortexColumnParticles` is a follow-up).

#### fe-34 v3 sky: overcast, billows, scud, in-cloud flashes

- `CycloneOptions.overcast {from, ramp}` (in radii of max wind): `cycloneOvercastFloor()` forces
  coverage to 1 inside `from`, ramping to 0 over `ramp`; the eye returns 0, so blue shows only in the
  eye hole and the far-offshore calm. Darkness is at least `floor·(0.3 + 0.7·storm)`.
- `darknessGain` steepens darkening with storm strength; `maxDarkness` caps it (the demo uses 0.9) so
  the eyewall deck stays dark grey rather than black and its billows still read.
- Cloud shader: billow relief at two scales plus an underside term along the view direction (lumpy
  bases, lit tops); with several layers the lowest is darkened as scud racing under the deck.
- `LightningOptions.cloudGlow {radius, intensity, flickerHz}`: intra-cloud flashes draw no channel and
  add nothing to sky exposure; instead the brightest live strike writes `flashX/flashZ/flashRadius/
  flashIntensity` into the clouds, and the shader adds a Gaussian glow in deck space, brightest at thin
  puff edges, so a patch of billows lights from inside. `lightningFlicker(age, seed, hz)` gives the
  pulses. Frequency follows the storm through `rate` and `cloudFlashFraction`.

#### fe-35 wave height: why the hurricane sea looked flat, and the fix

Root cause (the Gerstner vertex displacement itself was applied correctly; a height-debug render
showed metre-scale swells offshore):

1. **Steepness collapse.** `oceanWavesFromWind` capped Hs at `maxHeight` but shrank the wavelength
   only by √(Hs/Hs_developed), so a capped storm sea kept a ~400 m peak: Hs/λ ≈ 1 %, about a 1–3°
   slope, which renders as a flat sheet. Now `peakSteepness` (default 1/13) sets λp = Hs/steepness,
   never longer than the fully developed PM peak.
2. **Height cap.** The hurricane capped Hs at 4–5 m, so mid-storm and the eyewall had the same sea.
   `heightScale` (fetch-limited sea, demo 0.45) plus `maxWaveHeight` 9/10/12 m let it grow with the storm.
3. **Framing, beach and fog.** From the old camera framing, the open sea was a ~20 px strip at the
   horizon behind a wide swash band. On a 6 % beach, depth-limited breaking (H ≤ 0.78·d) flattened
   everything within ~200 m of shore, and exp2 fog of 0.0045 left <1 % of the sea visible at 500 m. The
   new `WaterShoreSettings.dropOff` (shelf drop-off; CPU twin `shoreDropOff`, shader `shoreE.w`) lets
   swells keep their size closer in. The demo looks a little more seaward with the same eye height,
   and its storm fog is 0.0022.
4. **Shading.** Under an overcast sky the fresnel-mixed sky and the water body were the same dark grey,
   and foam covered half of every wave (whitecap threshold floor 0.5). The water shader now darkens
   troughs and lifts crests (`heightN`, scaled by sea size), wraps a sky key light over the slopes,
   adds crest subsurface, shades foam by the relief, and reflects at least the fog colour at the
   horizon. The whitecap floor is 0.68.

The hurricane uses ≥ 5 components on every tier, so the near-twin of the peak beats into wave sets.

## 11. Environment state drives the simulation (Phase 17.4–17.6)

### 11.1 Surface weather and traction (17.4)

`environment/surfaceWeather.ts` gives the ground a memory of the weather. `SurfaceWeatherState`
holds `wetness`, `puddles` and `snow` (0–1); `stepSurfaceWeather` integrates them with
`DEFAULT_SURFACE_RATES` (seconds): wetting 45, drying 600 (scaled by temperature, humidity and wind),
puddle fill 600 / drain 2400 (rain above 0.5 on already-wet ground only), snowfall 600, melt 900.
`snowFraction(T) = clamp((2 − T)/3)` splits precipitation into rain and snow.

`WeatherSystem` integrates it inside `advance()` in ≤ 1 s slices and, by default:

| Option | Default | Effect |
|---|---|---|
| `driveSurface` | on | writes `scene.settings.surface` → `PerFrameUniforms.surfaceWeather` (flag bit 7); the standard shader darkens and glosses wet ground, fills flat noise basins with sky-reflecting puddles and lays snow on up-facing surfaces |
| `driveVehicles` | on | publishes `tyreGripFactor(surface)` for the world (`scene/surfaceGrip.ts`); `VehicleSystem` writes it into every `vehicle.surfaceGrip` on its fixed step, and `Vehicle.mu` scales the Pacejka peak (environment never imports vehicles) |
| `driveWater` | off | rebuilds the sea from the wind (`weatherOceanOptions`), throttled |

Grip: wet 0.75, puddles ×0.73 more, snow `1 − 0.7√s`, floor 0.2. Braking from 20 m/s measures
19.3 m dry, 25.8 m wet, 35.3 m in puddles, 64.6 m on snow. Other mappings: `visibilityForFogDensity`
(metres, Koschmieder ln 20 / σ), `weatherPrecipitationDrive` (adds `snow` for `PrecipitationField`'s
slow flakes), `weatherSoundInput` (levels for `StormSoundscape`; the weather demo starts it only once
a gesture has unlocked audio — sound stays opt-in).


Ambient under cloud: the clear-sky hemispherical ambient is blue, but a deck scatters nearly
wavelength-independently. `overcastAmbientNeutral` / `neutralizeAmbient` grey the ambient by cover
(luminance-preserving, idempotent), and `cloudDiffuseTransfer` (default 0.8) returns most of the
sunlight the deck takes out of the direct beam as neutral skylight, with `cloudShadowFill` (0.5)
lifting the remaining soft shadows. Snow albedo is `(0.90, 0.91, 0.93)`; a snow cover also greys
65 % of a pixel's ambient so shadowed snow keeps only a slight cool tint.

### 11.2 Screen-space water (17.5)

`scene.settings.water.screenSpace` = `"off" | "refraction" | "full"` (per tier:
`waterScreenSpaceForTier`). On HDR frames with a water batch and the camera above water, the
renderer drops water from `forge.main`, then `forge.water.grab` copies the scene colour and depth
(MRT into rgba16float + r32float, since depth24plus cannot be copied) and `forge.water` draws the
water sampling both: a refracted probe (fallback to the straight pixel when the probe hits
something in front), Beer–Lambert absorption (`absorption`, default 0.35/0.075/0.045 per metre;
CPU twin `waterTransmittance`), contact foam and a soft edge where the column is thinner than
`intersectionFoam` (CPU twin `intersectionFoam`), and in `"full"` a 40-step SSR that falls back to
the sky reflection off-screen. Off keeps the earlier single-pass water exactly.

### 11.3 Lightning as a simulation event (17.6)

The scheduler's rate is `rate × storm01`. With `strikeTarget` (a height function) and attractors,
`attachStrike` picks the highest point within the rolling-sphere `strikingDistance(I) = 10·I^0.65` m.
With a `listener`, each strike queues its thunder at `thunderDelay` (nearest channel point ÷
`speedOfSound(T)`), delivered through `onThunder` on the simulated clock (`pendingThunder`,
`thunderCount`). On a 120 m ridge the high-ground share rises from 7.8 % to 12.7 %.

Change log: fe-36 — 17.4 surface weather / grip / audio / sea coupling, 17.5 screen-space water,
17.6 thunder timing and strike attachment; browser-check holds water, lightning and surface still
during the 17.3 deck A/Bs.
