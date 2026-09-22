# What is verified, and how

Phase 1 (core engine), Phase 2 (rendering foundation: render graph, HDR + bloom + tone mapping,
cascaded shadow maps, pipeline cache), Phase 3 (scene/ECS: entity lifecycle, component stores,
system scheduler, hierarchy, visibility culling, import boundaries), Phase 4 (terrain + procedural
worlds: chunks, heightmaps, quadtree LOD, geomorphing, streaming, generators, 10 km+ visible world),
Phase 5 (physics: fixed timestep, rigid bodies, broad/narrowphase, sequential impulse solver,
Coulomb friction, bounce restitution, 3-box vertical stacking, 15/30/60/144 Hz trajectory determinism),
Phase 6 (vehicles: Pacejka, suspension, engine/transmission/diff, aero, ground query, TC/ABS), and
Phase 7 (particles: CPU simulation as the reference, a compute integrator for the same gravity/drag/life
step, modules, trails, budgets) are **verified** through automated tests, benchmarks, and headless
real-WebGPU checks. This file states exactly which claims are backed by an automated check, so nothing
in `ROADMAP.md` has to be taken on faith. `docs/VEHICLES.md` and `docs/PARTICLES.md` describe what
those two phases actually do; this file says which assertion proves each part. Phases 8–14 are not
built (`ROADMAP.md`).

## Setting up

`npm run setup` (`scripts/setup-deps.sh`) installs or verifies every prerequisite below — Node, npm,
the locked packages, and the headless Chromium + SwiftShader build that `check:browser` drives —
checking versions first and only installing what is missing or wrong. `npm run setup:check` verifies
without changing anything.

## Runs green today

| Command | Checks | Status |
| --- | --- | --- |
| `npm run typecheck` | `tsc -b engine` (strict mode, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`) and examples tsconfig | passing |
| `npm test` | 162 tests in 16 files: `math` (26), `orbitControls` (16), `vehicles` (15), `renderGraph` (14), `ecs` (13), `particles` (13), `realisticTerrain` (11), `wgsl` (9), `terrain` (8), `frame` (7), `shadows` (7), `physics` (6), `rendering` (6), `architecture` (5), `pipeline` (4), `primitives` (2) — see the per-suite notes below | passing |
| `npm run check:wgsl` | structural WGSL validation of every shipped shader (standard, unlit, depth-only, debug, post, particle compute) + 16-byte layout sizing + the strict uniform address-space layout rules (array strides and struct/array member offsets that are multiples of 16) applied to every generated struct and every `var<uniform>` in the shader text | passing |
| `npm run check:browser` | Headless Chromium + SwiftShader: the Phase 2 chain (3 cascades → HDR forward → 5-mip bloom → tonemap), bloom/shadow A/B, LDR fallback, cascade debug, resize, Phase 4 terrain camera, scene switching, the Phase 7 compute integrator executed on that device (`gpuError ≈ 2.5e-7`), and the vehicle playground plus particle fountain loaded with zero GPU errors | passing |
| `npm run bench` | Phase 3 100k-entity transform/visibility/culling benchmark, plus the Phase 7 100k-particle × 30-step integrator (fails if that integrate takes ≥ 1 s or leaves the analytic curve; measured here at ~98 ms) | passing |
| `npm run verify` | typecheck, test, and check:wgsl in sequence | passing |

### `tests/math.test.ts` — conventions the engine silently depends on

Pins the `+Z` forward view space shared by `Mat4.setLookAt`/`setPerspective`/`Frustum`, WebGPU's
`[0,1]` depth range for perspective *and* orthographic (shadow) projections, the clockwise
on-screen winding that fixes `frontFace: "cw"`, the `[0,1]`-safe deterministic hash/noise,
float64-pair and `Double3.writeRelativeFloat32` precision, and `TransformStore` dirty-skip behaviour.
Phase 2 added an alias-safety case: `Mat4.transformPoint/transformDirection` and `Quat.rotateVector`
must give the same answer when the output vector *is* the input, because that is how the scratch
vectors in the cascade fit are used (the bug it guards against shifted every cascade centre).

### `tests/orbitControls.test.ts` — the demo camera controls

`OrbitControls` is the only path a user has to the scene, so its contract is tested where it can be
seen: `configure()` clamps a preset distance into the scene's range (the regression — a 120 m terrain
preset under a hard-coded 50 m cap, which made the first wheel event a teleport to the ground);
zoom is exponential in wheel pixels and saturates at `minDistance`/`maxDistance` in both directions;
panning moves the target along the camera's own right/up axes by exactly
`dragged pixels × 2·distance·tan(fovY/2) / viewportHeight` (asserted at two azimuths and two viewport
heights); elevation clamps; the surface constraint holds the target *and* the eye above
`groundHeight + groundClearance` across a full zoom sweep, both elevation extremes and a pan that
would bury the target; and the camera's world matrix looks at the orbit target. The terrain demo's own
preset is asserted too: it starts inside its declared range, can zoom out, stays above the terrain at
every zoom level, and its elevation queries match an independently generated tile of the same cell
(the bare `HeightGenerator` disagrees by up to 26 m on that seed, which is how the camera used to sink
through crater rims).

### `tests/ecs.test.ts` — scene/entity lifecycle

Component storage is per *world*: two live scenes each hold their own store for a component type,
adding a component in one world does not show up in the other, and disposing one world leaves the
other's components intact. The regression this pins is what the demo's scene buttons hit — one store
instance per component *type*, shared by every world, aliased entity slot 0 of one scene onto slot 0
of the next, so the second scene built in a session threw `Entity "ground" already has a Transform
component` (and disposing either scene cleared the other's components).

### `tests/terrain.test.ts` — procedural generation, sampling and the streaming budget

Bit-for-bit deterministic tiles for a seed, seamless elevation continuity across chunk edges, crater
excavation plus uplifted rims, scatters on acceptable slopes, bicubic height/normal interpolation and
grid-marching raycasts, LOD bands with geomorph alpha, and the resident-chunk budget: after moving the
focus 5 km the world still holds no more than `maxChunksLoaded` chunks (`maxGenerationsPerFrame` also
progresses at least one chunk per frame, which the old scan-order queue could silently fail to do when
the budget was already full of far chunks).

### `tests/renderGraph.test.ts` — the graph's contracts (mock device)

* **Validation** — reading or `load`-ing a transient nothing wrote, attaching one texture twice,
  sampling a pass's own attachment, and using a stale handle or the API outside `begin()` each throw a
  `UsageError` naming the pass, and a failed frame submits nothing; loading the imported swapchain is
  allowed.
* **Culling and dependencies** — passes nobody consumes are dropped unless they write an imported
  texture or are flagged `sideEffect`; every layer-writer of an array texture stays alive when a
  later pass samples the whole texture (the cascade case); a `load` write depends on the previous
  writer, a `clear` write does not.
* **Memory planning** — same-shaped transients with disjoint live ranges share one physical texture
  and `aliasedBytes` reports the saving; overlapping ranges or differing descriptors do not alias;
  re-executing the same topology allocates nothing and preserves texture identity; a shape that
  stops being used survives the two-frame grace period, is then destroyed, and `dispose()` releases
  the rest (asserted through `mock.outstanding`).
* **Recording** — one command buffer per `execute()`, a named debug group per pass, and attachment
  views with the mip/layer shapes the passes declared.

### `tests/shadows.test.ts` — cascade math without a GPU

Split distances interpolate between uniform (λ = 0) and logarithmic (λ = 1) and always end at the
shadow distance; every corner of every frustum slice projects inside `[-1,1]² × [0,1]` of its
cascade's light-space box (perspective camera, arbitrary orientation); the box leaves
`casterBackoff × radius` of room in front of the slice for off-screen casters; translating the camera
by a fraction of a texel changes the light-space origin by a whole texel (the snapping that keeps
shadow edges from swimming); a straight-down sun and an orthographic camera produce finite,
containing matrices; passing an output array reuses the cascade objects.

### `tests/pipeline.test.ts` — the pipeline cache

Identical keys return the identical bundle and count a cache hit without touching the device; every
axis of the key (technique, colour/depth formats, blending, culling, instancing, additive, fragment
entry) yields a distinct pipeline; the four post entry points compile from one shader module; all 13
variants the renderer can ask for pass the mock's validation; `invalidate()` drops pipelines and
layouts and the next `get` rebuilds them.

### `tests/frame.test.ts` — the frame the renderer builds (mock device)

Drives `Renderer.renderScene` with a camera, a shadow-casting sun, a ground plane and boxes on a
320×180 mock surface with a 256² atlas (the mock allocates texture storage eagerly):

* HDR settings produce exactly `shadow.0, shadow.1, main, bloom.prefilter, bloom.down.2, bloom.down.3,
  bloom.up.2, bloom.up.1, tonemap`, with `main` on `rgba16float` + `depth24plus`, `tonemap` on the
  swapchain, 3 bloom mips at 180 px, 6 transients → 6 physical textures, and post draws excluded from
  the triangle count.
* `hdr: false` yields `shadow.0, main` with `main` on the swapchain and no post pass.
* Bloom, `postProcessing`, shadows, the light's `castShadow` and the quality caps (`shadowCascades`,
  `shadowMapSize`) each change exactly the passes they should.
* A caster behind the camera is frustum-culled from `forge.main` but still drawn into the cascade
  that contains it.
* A steady frame creates no textures and no buffers; a resize to an unrelated size creates only the
  frame-sized transients (HDR, depth, new bloom mips), the old shapes are retired after the grace
  period, and the shadow atlas is untouched.
* Toggling HDR and shadows through five combinations records zero mock validation errors, and
  every fixture asserts `mock.outstanding` is empty after teardown.

The mock validates attachment formats against pipelines, bind-group layouts, dynamic offsets and view
dimensions, so "no errors" is a statement about the command stream, not just about exceptions.

### `tests/rendering.test.ts` — Phase 1 renderer behaviour

Draw calls issued, `lookAt` reaches the frame (view faces the target, sun direction points at it),
projection aspect derives from the surface, empty scenes clear without errors, frustum culling,
debug lines, and zero leaked GPU buffers/textures on disposal.

### `tests/vehicles.test.ts` — the raycast car

Pins the claims in `docs/VEHICLES.md`: Pacejka is odd and peaks where the sampled slip says it does;
a constant torque produces `I·α = τ` and the rev limiter holds; upshift and downshift RPM fire;
an open diff splits equally and an LSD biases toward the slower wheel; aero drag is `½ρCdAv²`;
static load transfer follows the sign of `ax`. On the chassis: a 1000 kg, μ = 1 stop from 20 m/s
lands between 75% and 115% of `v²/(2μg)`; a 12° slope is climbed when μ exceeds `tan θ`; acceleration
shifts load rearward and braking shifts it forward; a short gearbox upshifts within 2.5 s; TC holds
peak driven |κ| under 0.35 and at least 0.15 below the same launch with TC off; identical inputs
repeat the pose; `VehicleSystem` steps once per fixed step and writes the chassis transform. The
playground's keyboard and camera follow are not in this suite — `check:browser` only proves that
scene loads without a GPU error.

### `tests/particles.test.ts` — the buffer, not a draw

Pins the claims in `docs/PARTICLES.md`: `integrateParticle` matches `analyticGravity` (semi-implicit,
not `½gt²` on the first step); drag damps and an expired life clears the slot; the compute shader
passes `validateWgsl`; cone emission, colour/size modules, the emit budget, and trails are
deterministic for a seed; 100k particles × 30 steps (drag 0) finish under 1 s and particle 0 matches
the curve; the mock device records the compute dispatch and does **not** set `gpuExecuted` (it does
not run WGSL); `ParticleSystem` and `ParticleWorld` each step once and pose a sprite. The real-GPU
half of that check is `check:browser`, not this file.

### `tests/wgsl.test.ts` — the layout rules browsers disagree on

Chromium's compiler accepts uniform structs with a relaxed layout; WebKit rejects the module, which
on Safari is a black canvas with a live HUD. The suite asserts that every generated struct emits
scalar padding (never `array<u32, N>`), reports no `uniformLayoutProblems()`, keeps its byte
offsets/sizes (`PerFrame` 240, `Light` 80, `LightBlock` 1296, `Shadow` 320, `ShadowPass` 80, `Post`
48, `Material` 80, `Object` 176, `Instance` 80 B), that every shipped shader variant — including the
depth-only and post modules added in Phase 2 — passes `validateWgsl`, that `toWgsl("uniform")`
throws for a sub-16-byte array stride, that struct-typed members sit on 16-byte boundaries, and that
`validateWgsl` flags the exact pattern that shipped (`pad68: array<u32, 3>`), nested-struct
strides, root-level uniform arrays and unpadded struct members while accepting legal layouts.

## A real browser + real WebGPU runs here

`tools/browser-check.mjs` starts the Vite demo (the `PBR Showcase` scene: 19 instanced batches, an
emissive cube, a shadow-casting sun, HDR + bloom + 3 cascades), drives headless Chromium over a real
WebGPU adapter (`google/swiftshader` with Vulkan backing), and asserts that:

- Frames advance continuously and draw calls are active (`drawCalls >= 1`, `triangles >= 12`, `entities >= 8`; the PBR scene actually reports 29 draws / 28k triangles).
- The frame has the Phase 2 structure: `render.hdr` is true, at least one `forge.shadow.` pass,
  exactly one `forge.main` and one `forge.tonemap`, at least three `forge.bloom.` passes,
  `shadowsDrawn >= 1`, and `texturesCreated === 0` on a steady frame (the graph's pool is warm).
- Real geometry and lighting reach the canvas (≥ 8 distinct colours, mean luminance ≥ 6/255 — the lit ground fills the lower half of the frame, so a black frame with a HUD cannot pass).
- **Bloom A/B**: a readback with bloom off has a lower mean luminance than with it on (light bleeds
  from the emissive cube), and the pass list shrinks accordingly.
- **Shadow A/B**: a readback with shadows off is *brighter* than with them on (the ground under the
  spheres is really being darkened by the cascades, not by ambient occlusion baked into materials).
- **LDR fallback**: with `hdr` off the pass list has no tonemap or bloom passes and the frame is still
  a lit scene.
- **Cascade debug view** renders without errors, and after every toggle the settings are restored,
  the pass count is back to the HDR default, and `gpuErrors` is still 0.
- Resizing the viewport recreates the swapchain and the frame-sized transients and presentation
  continues.
- No GPU error was recorded: shader compile diagnostics (`getCompilationInfo`), `uncapturederror`
  events and render exceptions all land in `engine.stats().gpuErrors`/`lastError`, and any engine
  `console.error` fails the run.
- **Terrain camera controls (Phase 4)**: the gate then switches to the terrain scene with the
  animation frozen and drives the real controller — `page.mouse.wheel` at the canvas centre and a
  right-button drag. It asserts the starting framing is inside the scene's own zoom range, that
  scrolling away increases `distance` (bounded by `maxDistance`) and scrolling back decreases it,
  that a right-drag moves the orbit target, and that after every one of those the reported
  `altitude` (eye height minus `terrain.getHeightAt(eye.x, eye.z)`) stays above the surface — the
  exact failure that started this: a controller with a hard-coded 2..50 m range under a scene framed
  at 120 m, which clamped the eye to the ground and left it under ridge lines. `tools/.browser-check-terrain.png`
  captures the closest-zoom frame for eyeballing.
- **Scene switching**: `pbr → terrain → pbr → terrain` must leave `gpuErrors` at 0, which it cannot
  if component stores leak between worlds (see the ECS note above) or the previous controller was
  left attached.
- **Particle compute on this device (Phase 7)**: `window.__forge.runParticleGravityCheck` uploads a
  rest state, dispatches `PARTICLE_SIM_SHADER` 30 times, and reads it back. `gpuExecuted` must be
  true (the mock device, and a shader that dispatched but did not write, both return false) and
  `gpuError` must be under `1e-2` against `analyticGravity`. `cpuError` must be under `1e-4`.
  The SwiftShader run recorded here measured `gpuError ≈ 2.5e-7`.
- **Vehicle playground and particle fountain**: `loadScene("vehicle")` and `loadScene("particles")`
  must present with `gpuErrors === 0`. The fountain must report `alive > 0` after a short settle.
  The car is not driven here — stopping distance and the 12° climb are unit tests. Screenshots:
  `tools/.browser-check-vehicle.png`, `tools/.browser-check-particles.png`.

Run it with `npm run check:browser`, then **look at `tools/.browser-check.png`**: the automated
thresholds prove the passes ran and changed the pixels in the right direction; whether the shadows
are crisp and the bloom halo is where the emissive cube is remains an eyeball check.

The browser it drives is Chromium. WebKit (Safari, every iOS browser) is stricter about uniform
address-space layout, and that difference is enforced statically instead: `StructDef.toWgsl("uniform")`
refuses illegal definitions, `validateWgsl` applies the same rules to shader text at module creation,
and `check:wgsl` + `tests/wgsl.test.ts` run both. No automated check compiles the shaders on WebKit.

## Verified capabilities

* **A rendered frame with the Phase 2 chain.** Headless Chromium renders the PBR scene through
  cascaded shadow maps, an `rgba16float` forward pass, a 5-mip bloom chain and a tonemap resolve, with
  real shader compilation and zero GPU errors.
* **Render graph semantics.** Validation, culling, live-range aliasing, cross-frame pooling and
  retirement, single-submit recording — all on the mock device, where every allocation is visible.
* **Cascade math.** Containment, texel snapping and caster back-off are checked numerically,
  independently of the GPU.
* **`Engine` / `Renderer` / `Scene` at runtime.** Verified both through the mock-device suites and
  through `npm run check:browser` in real Chromium.
* **GPU resource lifecycle.** Steady frames allocate nothing; resizes retire what they replace; clean
  teardown with zero leaked GPU buffers or textures asserted by `MockGPUDevice.outstanding` in every
  renderer fixture.
* **A raycast vehicle.** Torque→RPM, shift points, the analytic stop, a 12° climb, load transfer,
  and TC slip are numeric tests in `tests/vehicles.test.ts`. The playground is a scene the browser
  gate loads; it is not a handling-quality test. See `docs/VEHICLES.md` for what is kinematic rather
  than simulated.
* **A particle buffer.** The CPU integrator matches `analyticGravity` in `tests/particles.test.ts`,
  including a 100k × 30 step budget. The same curve on a real device is the `runParticleGravityCheck`
  assertion in `check:browser`. Emission, modules, and trails are CPU and covered by the unit suite
  only.

## Not verified yet

* **A WebKit compile.** Uniform-layout strictness is enforced by the static validator and unit tests
  (above), not by running Safari; there is no WebKit build in the sandbox.
* **Bloom and shadow *quality*.** The gates prove the effects are present and act in the right
  direction (A/B luminance) and that the cascade fit is geometrically correct; they do not compare
  against a reference image. Aliasing in the default frame is 0 bytes by design (nothing shares a
  shape yet), so the aliasing path is exercised only by `tests/renderGraph.test.ts`.
* **GPU timings.** No timestamp queries yet; `renderTimeMs` is CPU time.
* **Multi-threaded task scheduler and worker round-trips.** Worker entry and scheduler are
  implemented, but worker execution across threads has no test suite yet.
* **Terrain streaming quality.** The browser gate proves the terrain camera can move and stays above
  the surface, and the unit suites cover chunk generation, LOD selection, the resident-chunk budget
  and elevation queries; nobody asserts *how much* of the world is resident, how the boundary of the
  loaded disc looks, or how long a hitch a chunk takes to generate on a given machine.
* **Particle *rendering*.** The browser gate proves the compute integrator matches analytic gravity
  on SwiftShader and that 200 sprite boxes present. It does not prove a billboard pass, per-particle
  colour on the material, or a trail draw — none of those exist (`docs/PARTICLES.md`).
* **Vehicle handling quality.** The unit suite proves the analytic stop, the slope, load transfer,
  shifts, and TC slip. The browser gate only proves the playground loads. Nobody asserts that the
  ramp mesh and the ground query stay coincident after a camera-follow frame, or that the car is
  pleasant to drive.
* **Fog / atmosphere.** `scene.setFog` stores settings and the forward pass uploads
  `fogColor`/`fogDensity`/`fogRange`, but no shipped shader samples them yet (ROADMAP Phase 8), so a
  scene that configures fog renders without haze.
* **Resource cache eviction.** Texture/mesh registry LRU behaviour under memory pressure is not
  covered.
