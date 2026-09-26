# What is verified, and how

Phase 1 (core engine), Phase 2 (rendering foundation: render graph, HDR + bloom + tone mapping,
cascaded shadow maps, pipeline cache), Phase 3 (scene/ECS: entity lifecycle, component stores,
system scheduler, hierarchy, visibility culling, import boundaries), Phase 4 (terrain + procedural
worlds: chunks, heightmaps, quadtree LOD, geomorphing, streaming, generators, 10 km+ visible world),
Phase 5 (physics: fixed timestep, rigid bodies, broad/narrowphase, sequential impulse solver,
Coulomb friction, bounce restitution, 3-box vertical stacking, 15/30/60/144 Hz trajectory determinism),
Phase 6 (vehicles: Pacejka, suspension, engine/transmission/diff, aero, ground query, TC/ABS),
Phase 7 (particles: CPU simulation as the reference, a compute integrator for the same gravity/drag/life
step, modules, trails, budgets), Phase 8a (environment I: sun position, single-scattering sky
pass, fog in the forward shader, day/night cycle), and Phase 8b (environment II: weather state,
cloud deck, Gerstner water, lightning) are **verified** through automated tests,
benchmarks, and headless real-WebGPU checks. This file states exactly which claims are backed by an
automated check, so nothing in `ROADMAP.md` has to be taken on faith. `docs/VEHICLES.md`,
`docs/PARTICLES.md` and `docs/ENVIRONMENT.md` describe what those phases actually do; this file says
which assertion proves each part. Phase 9 (engine hardening: worker execution, resource eviction,
resource statistics, the coordinate-space API, the capability registry and the known-issue gate) is
built and covered below. Phase 10 (streaming) and Phase 11 (vehicle physics) are implemented; Phase 12 is an honest GPU-particle subset (see below and `ROADMAP.md`). Phase 13 (renderer 2.0) is in progress: items 13.1–13.8 are implemented and covered below, including indirect rendering, asynchronous pipeline compilation and GPU timing; 13.9's per-object cascade assignment and bounded spot shadows (four shared-resolution maps) are implemented, while point/contact shadows and adaptive resolution remain.

## Setting up

`npm run setup` (`scripts/setup-deps.sh`) installs or verifies every prerequisite below — Node, npm,
the locked packages, and the headless Chromium + SwiftShader build that `check:browser` drives —
checking versions first and only installing what is missing or wrong. `npm run setup:check` verifies
without changing anything.

## Asking a device that CI cannot run

Chromium + SwiftShader is one implementation of WebGPU: a frame that renders in the gate can still
come out wrong on a phone, and a phone has no console to read. The demo therefore carries its own
device-side diagnostics, loaded on demand (`examples/src/diag/`):

* `?diag=1` on the demo installs a panel that snapshots the page — user agent, viewport and
  drawing-buffer sizes, adapter limits and features, engine stats, the render-graph pass list, and
  the terrain/model state — and captures the presented frame through a 2D canvas as an average
  colour plus a colour grid per row, so "the frame is only background" is a measurement rather than
  an impression (`examples/src/diag/iosReport.ts`).
* The same run then re-captures across a matrix of render settings (sky off, HDR off, shadows off)
  and across every demo scene, so a background-only frame is attributed to a feature or a scene
  instead of guessed at. The panel hides behind a `diag` button, and the numbers are POSTed as JSON
  when the host injects `window.__forgeDiagEndpoint` (the sandbox dev server's scratch config does);
  a plain `npm run demo` only draws the text on screen.
* `examples/src/diag/rawGpuTests.ts` runs twelve raw-WebGPU probes against the engine's device *and*
  a freshly requested one — rasterisation, the depth test, `depthReadOnly` loading the previous
  pass's depth (kept as a device probe after the renderer moved to the explicit-load spelling its
  `depth-load` control exercises, so a phone report still names the primitive), dynamic offsets
  (uniform slices and a read-only-storage window, the two shapes the
  renderer's per-draw and per-instance bindings use), front-facing winding under both `frontFace`
  settings and back-face culling, instancing, rendering into an array layer,
  HDR blit and sRGB sampling. Each probe runs inside a validation error scope and carries its
  expected colour, so a failure names the primitive and leaves the engine's `gpuErrors` counter
  meaning what it says ("the engine's own frames failed"), not "a diagnostic ran".

None of this is a verification gate: it is an instrument for a report from hardware nobody here can
attach a debugger to, and it proves nothing until someone reads the output.

## Runs green today

| Command | Checks | Status |
| --- | --- | --- |
| `npm run typecheck` | `tsc -b engine` (strict mode, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`), the examples project, and the tests project (Phase 9.6: vitest only *transpiles*, so a test with stale types still ran — the first typechecked run found 37 errors, including `mock.texturesCreated` assertions that had been comparing `undefined` to `undefined`) | passing |
| `npm test` | 603 tests in 42 files on the current tree (including Phase 13.7 async pipeline, Phase 13.8 timestamp/readback and Phase 13.9 cascade/spot-map coverage); see the per-suite notes below | passing |
| `npm run test:affected` | The same suites as `npm test`, but only the ones the working-tree (or PR) diff can reach: each change is mapped through `tools/test-subsystems.mjs` to its subsystem, expanded to every dependent subsystem, and unioned with the smoke floor (`math`, `ecs`, `renderGraph`, `frame`, `architecture`, `subsystems`). A foundation change (`core`/`math`), a build/test-config change, or a file no subsystem owns falls back to the full suite, and the one-line reason is printed. `--all` forces the full set; PRs run this in CI, `main` runs the full suite | passing |
| `npm run check:testmap` | The source→test map has not drifted: every suite on disk is claimed by exactly one subsystem (or the smoke floor), every declared source path and `deps` id resolves, and every top-level `engine/src` directory is owned by a subsystem or is a full-run trigger. Guarded a second time from inside vitest by `tests/subsystems.test.ts` | passing |
| `npm run check:wgsl` | structural WGSL validation of every shipped shader (standard, unlit, depth-only, debug, post, sky, water, particle compute/render) + 16-byte layout sizing + the strict uniform address-space layout rules (array strides and struct/array member offsets that are multiples of 16) applied to all 16 generated structs (including `ShadowUniforms`, `SkyUniforms`, `CloudUniforms`, `WaterUniforms`) and every `var<uniform>` in the shader text + `smoothstep` literal edge order (`low >= high`, which strict compilers reject at shader-module creation) | passing |
| `npm run lint:arch` | Import boundaries from `ARCHITECTURE.md` §2 (`core/**` -> core+math, `gpu/**` -> core/gpu/math/testing, `math/**` -> core+math, `scene/**` -> no runtime rendering/environment, `environment/**` -> core/math/scene/environment), no WebGL fallback anywhere in `engine/src`, and no `engine/src` deep imports from `examples/` or `tests/` (they must use `@forge/engine`) | passing |
| `npm run docs:check` | The capability registry agrees with itself and with the documents: unique ids, `verified` entries carry evidence that exists on disk, unfinished entries name a roadmap item or phase that exists (or, if they are unmapped, carry a note saying why the roadmap schedules nothing), `ROADMAP.md`'s engine-state block matches the registry's phase statuses, every Phase 9 item is claimed, and every bullet in `docs/KNOWN-ISSUES.md` references a capability that is *not* verified (a stale limitation fails the gate) | passing |
| `npm run check:browser` | Headless Chromium + SwiftShader: the landing-page selector defaults to Mars Showcase, `?scene=pbr` still selects the PBR fixture, then the Phase 2 chain (3 cascades → HDR forward → 5-mip bloom → tonemap), bloom/shadow A/B, LDR fallback, cascade debug, resize, Phase 4 terrain camera, scene switching, the Phase 7 compute integrator executed on that device (`gpuError ≈ 2.5e-7`), the vehicle playground plus particle fountain loaded with zero GPU errors, and the Phase 8a sky scene: `forge.sky` compiled and run on the real adapter directly after `forge.main`, noon brighter than 01:00 by > 2×, the pass gone when the sky is switched off, and the Mars preset presenting with zero GPU errors, plus the Phase 8b weather scene: overcast noon brighter than clear noon, a pinned overcast night darker than a clear night, the sky pass gone underwater, and a triggered strike registered — the sky scene's on-screen buttons at a desktop width (panel shown with the hint hidden, `+1h` scrubbing the clock, `Pause` stopping it and the second tap restarting it, `Mars` swapping the planet and back, each button marking itself pressed), and the weather scene's buttons at phone width: panel shown with the hint hidden, each button moving the state its key moves and marking itself pressed, the clock frozen by Pause and running again after it, and the panel still shown when the window returns to a desktop width (the buttons are the interface on every device; only the vehicle demo keeps its keyboard) — the storm preset spawning live rain (`weatherState().rainDrops > 0`) — and the Mars Showcase: the Perseverance GLB loading with its 6 wheels found, the wheels settling to ≥4 in terrain contact, `W` driving the rover > 0.5 m with the speed and kick dust that prove the drivetrain, and the robotic arm: `R` starting the unfold with the elbow joint leaving its stowed angle, then stowing back to all-zero joints with the thumbsticks hidden (the full 6 s unfold, the thumbstick jogging, the joint limits and the ground guard are covered by `tests/roverArm`, `tests/armTouch` and `tests/vehicleTouch`, because the showcase presents well under 1 fps on SwiftShader), the vehicle playground's parking brake: `P` latching it with the pad's P/PARK lamp lit, full throttle not moving the latched car (wheels locked), a second `P` releasing it and `W` driving the car > 0.5 m (this section resumes the demo loop the pixel A/Bs froze and asserts `animating()`, because a frozen loop applies no input at all and a parked car looks the same as a car that cannot move) — the Phase 13.5 object culling A/B (identical picture between the device culler and the CPU twin, the pass present in one arm only, the HiZ stage off without darkening a pixel) and the Phase 13.6 indirect arm that follows it (`indirectDraws === batches` with the pass's counter identities on a real device, the same picture with the records off and `indirectDraws` back to 0, and a 1 m draw distance that makes the device, not the CPU, zero records), plus startup through the non-blocking 13.7 pipeline path and optional 13.8 timestamp-query reporting (this SwiftShader adapter reported frame/render/compute and per-pass samples), and the 13.9 per-object cascade submissions plus the spot-shadow A/B: on the PBR fixture the spot map/pass appears, disappears when only the spotlight's `castShadow` flag is disabled (directional cascades stay active), and returns when re-enabled; the full-resolution comparison measured 13,464 pixels darker with spot shadows, none brighter, maximum 11 luma levels, with zero GPU errors through that arm. The frame suite separately checks spot-map counts/layers and range/`firstInstance` ownership because the browser A/B checks rendered output | this local run's spot A/B, cascade tint and earlier browser arms passed, then the Mars Showcase W-drive check failed at 0.485 m in 45 s against the >0.5 m requirement; the gate did not reach the later HGA poll, so there is no full browser pass or CI result for this diff |
| `npm run bench` | Phase 3 100k-entity transform/visibility/culling benchmark, the Phase 7 100k-particle × 30-step integrator (fails if that integrate takes ≥ 1 s or leaves the analytic curve; measured here at ~98 ms), the Phase 13.4 light-count stress benchmark (`benchmarks/src/lights.bench.ts`: prepare/count/fill timed per frame at 16/64/256 lights on a demo-shaped and a grid-saturating rig, with shape guards — the fill follows coverage, the counting pass does not, the worst case stays under a second) and the Phase 13.5 object-culling benchmark (`benchmarks/src/culling.bench.ts`: the CPU twin's frustum/distance/HiZ tests at 512/2048/8192 batches plus a 1280×720 pyramid per frame; measured here 1.1 µs/batch and 9.2 ms/frame at the cap, 39.5 ms for the pyramid — the reduction the twin does not do) | passing |
| `npm run verify` | typecheck, test, and check:wgsl in sequence | passing |
| `npm run setup:check` | Node/npm/git, every locked package, the headless browser, and the Vulkan loader + ICD the gate needs — one line per dependency, `warn` for anything that only affects the browser gate and `FAIL` for the rest. `--browser` makes the browser and Vulkan required instead of advisory | passing (this sandbox reports the two system packages as a warning: the bundled Chromium ships its own loader and ICD) |
| `npm run test:gpu` | Suites named `tests/**\/*.gpu.test.ts` against a real adapter; none exist yet (`passWithNoTests`), real-adapter validation is `check:browser` | no-op by design |

### When the browser is not installed at all

The gate's first act is to launch a browser, and a runner without one exits 2 with
`check:browser NOT RUN — no launchable browser` rather than failing a check it never ran. On a fresh
sandbox that is the normal state: Playwright's browsers live under `~/.cache`, and a checkout restored
without that directory (or an environment that cannot reach the Playwright CDN) has none. The fix is
the command the tool prints — `npx playwright@<installed playwright-core version> install --with-deps
chromium` — and there is nothing to read into a NOT RUN beyond "this machine did not test the browser
path". The advisory WebGPU CI job is where a real-device gate belongs, so a change whose browser arm
never ran locally must say so rather than claim the arm passed — as Phase 13.6 did: its sandbox run
was NOT RUN, and the same commit's advisory job passed the whole gate on SwiftShader
(`check:browser passed (real WebGPU, headless Chromium + SwiftShader) — gpu: adapter ok (google /
swiftshader)`, 17 minutes), the Phase 13.6 arm included.

### The Mars Showcase poll on a SwiftShader-only sandbox

One gate check waits on a clock instead of asserting a fact: the Mars Showcase section polls for 300 s
for the HGA to leave `stowed` and swing its azimuth off the 180° rest heading, and the showcase
presents at a fraction of a frame per second under SwiftShader, so the deployment it is waiting for
may not start inside that window. This was attributed with a baseline worktree rather than argued
about: at `2c24cec`, the commit *before* Phase 13.5's culler, the same section failed the same way
(`mars showcase: HGA never started deploying in 300s`, antenna at `phase: "stowed"`, countdown 0.05,
rover still rolling, exit 1) — the demo was alive, the machine was slow. On the culler branch the
sections before that poll all pass, the object-culling ones included (`gpu` vs `cpu` over the fixture:
5 batches, 5 tested, `max luma diff 0.00`, 0 px beyond one level, `forge.objects.cull` owned by the
`gpu` arm only; occlusion on → off: 4 HiZ passes → 0, 0 px darker, 0 px beyond one level; restored:
mode `gpu, occlusion true`). So a red `check:browser` here means: read the run up to its `- Error:`
line, and treat this one timeout as the sandbox's frame rate rather than as the frame being verified. The same commit
passes the whole gate — this poll included — on CI's runner (`mars showcase HGA: phase=deploying
az=168.0° el=12.0°`, then `check:browser passed`), which is the same SwiftShader implementation on a
faster machine: the exception belongs to the sandbox, not to the check.

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
every zoom level, keeps a modest far/near depth ratio with sky `seaLevel` pinned to the orbit
look-at (fe-14 iOS orbit moiré), and its elevation queries match an independently generated tile of the same cell (the bare
`HeightGenerator` disagrees by up to 26 m on that seed, which is how the camera used to sink through
crater rims).

### `tests/textureMips.test.ts` — procedural mip chains

`Texture.fromRgba8(..., { mipmaps: true })` must upload every level, not just level 0: empty higher
mips turn tiled terrain albedo/normals into grazing-angle sparkle on mobile. The suite pins the
box-filter average (linear bytes, sRGB→linear→sRGB for albedo, unpack/average/renormalize for
normals) and that an 8×8 upload accounts for the full 8²+4²+2²+1² chain.

### `tests/demoSceneSelection.test.ts` — first scene and deep links

The no-query landing page resolves to Mars Showcase so the streamed landscape and rover are visible
without finding the scene selector first. Direct links for all nine scenes still resolve, the existing
`mars`, `realistic-terrain`, `vehicle-playground` and `showcase` aliases are preserved, and unknown
scene values fall back to the rover showcase.

### `tests/weatherTouch.test.ts` — the weather demo's on-screen buttons

The weather scene's interface is its button panel (shown on every device), with the keys as
shortcuts onto the same five actions (`1..4`, `L`, `U`, `[`/`]`, `T`), so every way that can go
wrong is a disagreement between the two. Driving a stub root (the `orbitControls` pattern — the
module only touches listeners, classes, attributes and pointer capture) the suite pins: each button
sends its own action and no neighbour's; a tap runs it exactly once even though a touch tap is
`pointerdown` + `pointerup` + `click` (a double-fired `Dive`/`Pause` is a no-op that reads as a dead
button); a right-press starts no hold, because that gesture is the orbit pan; holding `±1h` steps
after `HOLD_DELAY_MS`, repeats every `HOLD_REPEAT_MS`, applies the hour the tap would have applied,
and the `click` that ends the press is swallowed exactly once (the next tap still lands); `dispose()`
stops a hold in flight and unhooks every listener; `sync()` paints the pressed preset and the two
toggles from the scene's state but writes nothing when the state has not moved (it runs every
frame), while a press repaints immediately from the scene instead of waiting for the loop; and a
missing panel is a no-op rather than a crash.

### `tests/skyTouch.test.ts` — the sky demo's on-screen buttons

The sky scene used to be keys-only (`[`/`]`, `T`, `M`); its button panel (`-1h`/`+1h`/`Pause`/`Mars`)
is now the interface on every device, bound to the very callbacks the keys call. The suite pins the
same contract as the weather panel against a stub root: each button sends its own action; a tap runs
once even though it is `pointerdown` + `pointerup` + `click` (a double-fired `Pause` would read as a
dead button); a right-press starts no hold; holding `±1h` repeats after `HOLD_DELAY_MS`, applies the
hold's own hour, and the release `click` is swallowed exactly once; `dispose()` stops a hold in
flight and unhooks every listener; `sync()` paints `Pause`/`Mars` from the scene's state, writes
nothing when the state has not moved, and a press repaints immediately; a missing panel is a no-op.


### `tests/vehicleTouch.test.ts` — A/B gas/brake hold on iOS

The vehicle pad's A/B buttons must survive a long-press on iOS Safari: without `user-select: none`,
`-webkit-user-select: none`, `touch-action: none` and non-passive `touchstart`/`selectstart`/
`contextmenu` `preventDefault`, WebKit's selection/callout cancels pointer capture and drops
throttle mid-hold. The suite drives a stub root (no DOM) and pins that those listeners are
registered with `{ passive: false }`, that each gesture calls `preventDefault`, and that a
`pointerdown`→`pointerup` on gas holds throttle at 1 for the duration. Manual check on a phone:
open Mars Showcase, hold A for several seconds — the label must not select and throttle must stay up.

### `tests/toolbarMenu.test.ts` — hamburger for DEMO SCENE / TONE MAPPING / RENDERING

The three top-right panels stay in the DOM (so `__forge` and the browser gate still reach every
button) but start collapsed behind a ☰ control. The suite pins: closed by default, toggle opens and
closes, an outside `pointerdown` collapses, an inside one does not. Manual check: tap ☰ to reveal
the panels, tap again or the canvas to hide them; scene switching and render toggles still work.

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
* **Recording and timing** — one command buffer per `execute()`, a named debug group per pass, and
  attachment views with the mip/layer shapes the passes declared. Timestamp-enabled execution resolves
  render and compute pass boundaries asynchronously, reports positive per-pass/frame durations through
  the callback and stats, and leaves `execute()` non-blocking. When `timestamp-query` is unsupported,
  the graph continues without timing and allocates no timestamp buffers.

### `tests/shadows.test.ts` — cascade math without a GPU

Split distances interpolate between uniform (λ = 0) and logarithmic (λ = 1) and always end at the
shadow distance; every corner of every frustum slice projects inside `[-1,1]² × [0,1]` of its
cascade's light-space box (perspective camera, arbitrary orientation); the box leaves
`casterBackoff × radius` of room in front of the slice for off-screen casters; translating the camera
by a fraction of a texel changes the light-space origin by a whole texel (the snapping that keeps
shadow edges from swimming); a straight-down sun and an orthographic camera produce finite,
containing matrices; passing an output array reuses the cascade objects. Spotlight fitting also proves
the perspective frustum contains interior cone points, clips beyond `Light.range`, remains finite for
vertical directions, rejects degenerate direction/range/resolution, clamps extreme outer cosines and
reuses the supplied matrix.

### `tests/clusters.test.ts` — the light grid, without a GPU

Pure CPU math (`engine/src/rendering/clusters.ts`), so the property that matters can be checked
exhaustively: **conservation** — a light must be in the cluster list of every fragment it can reach.
The suite walks probe points inside each light's range and looks them up exactly the way the fragment
stage does (tile from the projected position, slice from the view depth), and one test walks the ground
under an *off-axis* lamp at 2 cm, which is where a near-depth-only box projection silently dropped the
inner crescent of the lamp's own pool (the regression `check:browser` first saw as 181 darker pixels).
Also pinned: the 16×8×24 constants ARCHITECTURE.md §5.5 specifies; a spot cone's bounding sphere
covering its rim at full range; every list staying in light order (what makes the clustered and
unclustered sums bit-identical); the near/far/off-frame culls; the slice span reaching the deepest
light; the per-cluster cap evicting the *dimmest* (intensity × colour luma) and reporting it;
`CLUSTER_INDEX_CAPACITY` being exactly the worst case (`CLUSTER_COUNT × MAX_LIGHTS_PER_CLUSTER`), so
the cap and never the buffer is what limits a cluster; `MAX_CLUSTERED_LIGHTS` truncation reporting what
it was asked for; determinism (two builds byte-identical, nothing allocated); and a non-finite
transform dropping a light instead of poisoning the grid.

### `tests/pipeline.test.ts` — the pipeline cache

Identical keys return the identical bundle and count a cache hit without touching the device; every
axis of the key (technique, colour/depth formats, blending, culling, instancing, depth write,
additive, fragment entry) yields a distinct pipeline; the four post entry points compile from one
shader module; all 22 variants the renderer can ask for (including the two `sky` targets, the three
`prepass` variants and the three SSAO entry points) pass the mock's validation; `invalidate()` drops
pipelines and the 11 layouts and the next `get` rebuilds them. **Prepass (13.1):** the `prepass`
pipeline's vertex stage is the *same* shader module and entry point as the forward pipeline's
(static and instanced — the prepass compiles no module of its own), it has no fragment stage,
`depthCompare: "less"` and zero depth bias (the shadow program has a positive one and is a different
module), culls like the forward pipeline, and the forward variant used over prepassed surfaces is
`less-equal` with depth writes off. The SSAO estimate and both blur directions share one module,
bind no vertex buffer and no depth attachment, and use different layouts (depth vs AO texture).

**Async compilation (13.7):** repeated `getReady()` cache misses share one in-flight `createRenderPipelineAsync`, return no bundle until it resolves, and expose pending/failure counts; a rejection is latched until invalidation and never leaves a pending entry.

### `tests/frame.test.ts` — the frame the renderer builds (mock device)

Drives `Renderer.renderScene` with a camera, a shadow-casting sun, a ground plane and boxes on a
320×180 mock surface with a 256² atlas (the mock allocates texture storage eagerly):

* HDR settings produce exactly `shadow.0, shadow.1, prepass, ssao, ssao.blur.h, ssao.blur.v, main,
  bloom.prefilter, bloom.down.2, bloom.down.3, bloom.up.2, bloom.up.1, tonemap`, with `main` on
  `rgba16float` + `depth24plus`, `tonemap` on the swapchain, 3 bloom mips at 180 px, 9 transients → 8
  physical textures with `aliasedBytes` = 160·90·4, and fullscreen draws excluded from the triangle
  count.
* `hdr: false` yields `shadow.0, prepass, ssao, ssao.blur.h, ssao.blur.v, main` with `main` on the
  swapchain and no post pass.
* Bloom, `postProcessing`, shadows, the light's `castShadow` and the quality caps (`shadowCascades`,
  `shadowMapSize`) each change exactly the passes they should.
* A caster behind the camera is frustum-culled from `forge.main` but still drawn into the cascade
  that contains it.
* **Per-object cascade assignment (13.9):** two same-geometry casters with distinct, overlapping
  cascade masks stay in one colour batch; each depth pass issues only the `firstInstance` ranges
  assigned to its layer, and the submitted/cut instance totals match the masks.
* **Spot maps (13.9):** spot passes follow cascade layers in the shared array, use per-spot matrices
  and map texel size, preserve light indices in both the fixed uniform list and clustered storage
  block, support a spot-only frame, and cap the active maps at four. Tests check the 3-layer mixed
  atlas, the 4-layer spot-only atlas, the extra spot remaining unshadowed, and zero mock errors.
* A steady frame creates no textures and no buffers; a resize to an unrelated size creates only the
  frame-sized transients (HDR, depth, new bloom mips), the old shapes are retired after the grace
  period, and the shadow atlas is untouched.
* Toggling HDR and shadows through five combinations records zero mock validation errors, and
  every fixture asserts `mock.outstanding` is empty after teardown.
* **Depth prepass (13.1)**: `forge.prepass` has no colour target, clears and stores the scene depth
  and draws the two opaque batches; `forge.main` attaches the *same* depth with `depthLoadOp: "load"`,
  and every draw it issues for those batches uses a `nodepthwrite` pipeline (read back from the
  mock's command log: pipeline per draw) while every prepass draw uses the depth-only `prepass`
  variant. Cutout (`alphaTest`), fading (`opacity < 1`), transparent and overlay batches stay out of
  the prepass (`prepassDraws` 2 of 6) and keep `depthwrite` pipelines in `forge.main`; a scene with
  nothing eligible runs no prepass, no SSAO, and `forge.main` clears depth itself. A culled caster
  reaches the cascades but not the prepass.
* **SSAO (13.1) and aliasing (13.2)**: the estimate and both blur passes each draw one fullscreen
  triangle into a 160×90 `rg16float` target with no depth attachment; the vertical blur's target *is*
  the estimate's physical texture (same label), `aliasedBytes` = 160·90·4 and physical = transient −
  1. The uploaded `SsaoUniforms` (read back from the mock buffer) carry the radius, `projScale` =
  ½·180/tan(fov/2), both extents, `invProj[1][1]` = tan(fov/2) and a sample count clamped to 1…32.
  SSAO off keeps the prepass; intensity 0 computes nothing; prepass off removes both and restores
  `forge.main`'s own depth clear and writes; an orthographic camera gets the prepass but no SSAO;
  `RendererOptions.depthPrepass: false` / `ssao: false` veto them whatever the scene asks. A steady
  SSAO frame creates no texture or buffer, five prepass × SSAO × HDR combinations record no errors,
  and the fixture's teardown proves the SSAO buffer, AO fallback and pooled AO targets are released.
* **GPU timing (13.8)**: an enabled mock renderer exposes non-zero asynchronous frame/render/compute
  times and a `lights.assign` timestamp in `Renderer.stats.gpuPassTimes`; the matching `Profiler` frame
  record and per-pass scope receive those samples. The graph-specific test verifies `execute()` returns
  before map completion and reports separate render and compute passes.
* **Clustered lighting (13.3)**: with three point lamps added to the fixture, the uniform `LightBlock`
  holds the directional light alone while `cluster.lights` holds all three (same record layout, same
  field offsets, same values), `perFrame.flags` bit 5 is set, the uploaded quantisation reproduces
  `clusterSliceFor` at ten depths across the slice span, and the uploaded offset array is a prefix sum
  of the counts in which every index addresses a real light and every list is ascending. The pass list
  is *identical* with clustering on and off — it is a data change, not a pass. Clustering stays off for
  a directional-only scene, an orthographic camera, `settings.clusteredLighting = false` and
  `RendererOptions.clusteredLighting: false`. At 40 lights the cluster block carries all 39 locals
  while the uniform path truncates at 16 and reports `lightsDropped`. A steady clustered frame creates
  no buffer and no texture, five clustered × HDR × shadow combinations record no error, and the
  fixture's teardown proves the three cluster buffers are released.
* **Object culling (13.5)**: the mock's `"auto"` resolves to the CPU twin, which tests every batch in
  the frame that wrote it and reports `cullTested === batches` with the words in the `cull.visibility`
  buffer; a camera turned to the sky culls by frustum with `stats.cullFrustum` matching the words that
  say `CullReason.Frustum`. The device path (`objectCulling: "gpu"`) adds `forge.objects.cull` and,
  with the prepass running, `forge.hiz.0`; its dispatch covers the batch count in whole workgroups
  (`ceil(batches / 64)`), the visibility buffer the draws bind is the zeroed one (the device has
  reported nothing back — a frame whose words were never written draws everything rather than keeping
  last frame's verdicts), and `cullTested` is 0. Switching to `"cpu"` takes the pass out of the frame
  and restores the twin's numbers; the round trip to `"gpu"` brings the pass and its dispatch back (a
  disposed culler left referenced would silently drop it). `renderer.occlusionCulling = false` drops
  every `forge.hiz` pass while `forge.objects.cull` stays, and `true` brings them back — the level
  count is per-frame state, so a frame with no prepass never declares a pass that reads it.
* **Sky (Phase 8a)**: `scene.setSky()` inserts exactly one `forge.sky` pass directly after `forge.main`,
  drawing one triangle into the *same* colour target with the scene depth attached via an explicit
  load (`MockPassRecord.depthLoadOp === "load"`, `depthStoreOp === "store"` — the read-only attach's
  implicit load is not what the renderer relies on, because no check here can run WebKit and on iOS
  that implicit load lost the main pass's depth; the mock still rejects load/store ops on a
  read-only depth attachment as the spec does, for any pass that opts into read-only);
  `forge.main` switches its depth store op from `discard` to
  `store` while the sky runs and back when it stops; the pass adds no transient texture; a steady frame
  still creates nothing; the LDR path draws the sky straight into the swapchain; `setBackgroundColor`
  removes the pass; `RendererOptions.skyQuality: "low"` caps a `high` scene to 8 view samples
  (`stats.skySamples`) and `RendererOptions.sky: false` vetoes the pass. The sun comes from `sky.sunDirection`
  (stored normalised), else the first directional light, else a default, and a `setSkyOverride` is
  consumed by exactly one frame.

The mock validates attachment formats against pipelines, bind-group layouts, dynamic offsets and view
dimensions, so "no errors" is a statement about the command stream, not just about exceptions.

### `tests/objectCulling.test.ts` — the object culler's conservatism (Phase 13.5)

`engine/src/rendering/objectCulling.ts` in sixteen tests. The question is never "does it run" but "does
it ever drop something that is visible":

* `cullPlanesFrom` against `Frustum.setFromViewProjection` (normalized comparison, same order, same
  facing): the shader extracts its own planes from the frame's view-projection, and a plane the two
  derivations disagreed about is geometry that stops being drawn in one path and not the other.
* `cullBatchesOnCpu` over a deterministic sweep of 7×7×9 boxes: any box with a point inside the frustum
  survives (the point-in-frustum property, walked here independently of the code under test), boxes
  behind the camera / above the frustum / past the far plane are culled with the right reason, each
  batch's own `maxDistance` drops it only once its sphere no longer reaches (`distance − radius >
  limit`), the test is skipped when the frame's flags do not carry the distance bit, and the 8192-batch
  cap leaves the tail at zero — untested means visible, never wrongly culled.
* The HiZ test: the metre inversion (`far·near / (far − ndc·(far − near))`, unwritten texels exactly
  `far`), the level size chain and level count, a wall-vs-gap depth image (behind the wall occluded,
  over the gap kept, in front kept, straddling the edge kept), **the mirrored-row regression** — a
  floor depth image with a box over the empty top half, which a rectangle built from an un-negated NDC
  y reports as occluded — and a 120-box sweep asserting that every level-0 texel under a culled batch's
  padded footprint is nearer than that batch's nearest point. Flipping the twin's `sy` back to the
  mirrored form fails exactly the regression test (mutation-checked).
* The generated shader text: the constants, the embedded structs (`ObjectCullUniforms`,
  `ObjectBatchEntry`/`Block`, `ObjectCullStatsBlock`), one `@compute`, the visible-word reset, five
  `atomicAdd`s, the negated-y pixel row, the depth texture's three-argument `textureLoad`, and
  `validateWgsl` clean for all three modules. `tools/wgsl-check.mjs` validates the same structs against
  the parsed WGSL on the CPU side.
* `GpuObjectCuller`: the frame block (batch count, flags — the distance bit set because one batch has a
  limit, the occlusion bit only when a pyramid exists — the matrices verbatim, the target extent) and
  one bounds entry per batch with the limit at `min.w`; one pass, one whole-workgroup dispatch and the
  counter copy in the same command buffer; the pyramid's four levels for a 64×64 target with the
  per-level dispatch halving; the per-frame level count (a second frame with `occlude: false` records
  `forge.objects.cull` alone and uploads `hizLevels: 0`); and after `dispose` nothing is recorded and
  the stats read zero.

### `tests/rendering.test.ts` — Phase 1 renderer behaviour

Draw calls issued, `lookAt` reaches the frame (view faces the target, sun direction points at it),
projection aspect derives from the surface, empty scenes clear without errors, frustum culling,
debug lines, and zero leaked GPU buffers/textures on disposal.

### `tests/vehiclePhysics.test.ts` — Phase 11 physics / vehicle integration

Pins the Phase 11 exit criteria: `PhysicsBackend` / `ForgeJSPhysics` / `ForgeWasmPhysics` stub;
heightfield registered on the world; visual = collision = vehicle contact samples; kinematic
chassis collides with dynamic props; pitch/roll carry angular rates from suspension reaction + geometric spring and settle on slopes; wheel
contact via physics raycast/heightfield queries; crater/bump/side-slope/jump/unload/impact/rollover
stress cases stay finite; `vehicle.telemetry()` exposes load, travel, slip, tire force, RPM, gear,
ω, contact; `ForgeJSPhysics` / `PhysicsSystem` can adopt a shared `PhysicsWorld` (same identity;
heightfield + chassis visible to both) while the default remains single-owner.

### `tests/vehicles.test.ts` — the raycast car

Pins the claims in `docs/VEHICLES.md`: Pacejka is odd and peaks where the sampled slip says it does;
a constant torque produces `I·α = τ` and the rev limiter holds; upshift and downshift RPM fire;
an open diff splits equally and an LSD biases toward the slower wheel; aero drag is `½ρCdAv²`;
static load transfer follows the sign of `ax`. On the chassis: a 1000 kg, μ = 1 stop from 20 m/s
lands between 75% and 115% of `v²/(2μg)`; a 12° slope is climbed when μ exceeds `tan θ`; acceleration
shifts load rearward and braking shifts it forward; a short gearbox upshifts within 2.5 s; TC holds
peak driven |κ| under 0.35 and at least 0.15 below the same launch with TC off; identical inputs
repeat the pose; `VehicleSystem` steps once per fixed step and writes the chassis transform.
Brakes: a car parked on the foot brake, the handbrake or the latched parking brake holds its position
exactly with every wheel stopped (`ω = 0`, `spin` frozen — before the fix the four wheels kept
turning, 4.7 rad/s in gear on the flat, for as long as the brake was held); the parking brake holds
a 12° slope against full throttle; it locks all four wheels where the handbrake locks only the rears;
braking to a stop leaves the wheels stopped rather than spinning backwards; a braked airborne wheel
stops; and a brake held under full throttle gives the drive back as soon as it is released. The
playground's keyboard, pad, lamp and camera follow are not in this suite — `check:browser` proves the
scene loads without a GPU error, that `P` latches the brake with the pad lamp lit, that full throttle
does not move the latched car, and that releasing it drives the car away again.

### `tests/particles.test.ts` — the buffer, not a draw

Pins the claims in `docs/PARTICLES.md`: `integrateParticle` matches `analyticGravity` (semi-implicit,
not `½gt²` on the first step); drag damps and an expired life clears the slot; the compute shader
passes `validateWgsl`; cone emission, colour/size modules, the emit budget, and trails are
deterministic for a seed; 100k particles × 30 steps (drag 0) finish under 1 s and particle 0 matches
the curve; the mock device records the compute dispatch and does **not** set `gpuExecuted` (it does
not run WGSL); `ParticleSystem` and `ParticleWorld` each step once and pose a sprite. The real-GPU
half of that check is `check:browser`, not this file.

### `tests/environment.test.ts` — sun, sky, fog and the day/night cycle (Phase 8a)

Pure numbers against published references, no GPU:

* **Sun position** reproduces Meeus' worked examples — 7.a (Julian day of 1957-10-04.81 =
  2436116.31), 25.a (apparent RA 198.38°, Dec −7.785°, 0.99766 AU on 1992-10-13 0h) and 28.a
  (equation of time 13.7 min) — plus NOAA facts: declination ±23.44° at the solstices, noon elevation
  `90° − |φ − δ|` due south (due north at −33.9°), sunrise at 40°N on June 21 between azimuth 56°
  and 60° with a 14.9–15.2 h day, 18.6–19.1 h of daylight at 60°N, polar night at 80°N in December
  and midnight sun in June, solar noon 4 min/° of longitude, refraction ≈ 29′ at the horizon and 0
  at the zenith, and the engine-axis mapping (north = +Z, east = +X) with an exact inverse.
* **Atmosphere** derives Bruneton's Rayleigh table (5.802/13.558/33.1 ×10⁻⁶ m⁻¹) from the
  scattering formula to < 1 % in the green, normalises the Rayleigh, Cornette–Shanks and
  Henyey–Greenstein phase functions over the sphere, matches the closed-form vertical optical depth
  `β·H` to 1 % (≈ 0.10 Rayleigh-only in the green), gives a horizon air mass within 15 % of
  `√(πR/2H)` (≈ 35), makes the zenith blue and the sunset horizon red, red-shifts and dims direct sun
  toward the horizon (blue transmittance < 0.05 at 2°, 0 below), is azimuth-symmetric, dark when the
  sun is 30° down, shows lit ground below the horizon, and stays within 0.6–1.1× of a 512×32
  reference at 8×4 samples from 0.5° to 30° elevation (the cubic view-ray spacing; uniform spacing
  was 10× dark in horizon blue). The hemispherical ambient estimate is within 25 % of a
  4000-direction reference for Earth *and* the dust-lobed Mars preset, which reads butterscotch by
  day with a > 5× aureole.
* **Fog**: linear/exp² match their definitions, `FOG_MODE_ID` is pinned, and the height-fog closed
  form equals a 20 000-step brute-force integral of `ρ₀·e^{−k(y−b)}` along five camera→surface
  segments (including a near-horizontal one that exercises the small-`k` branch) to 6 decimals;
  the same formula lives in `WGSL_FOG`.
* **Scene settings**: fog defaults to `none` (opt-in), `setSky` stores a normalised sun direction and
  turns the sky on, `setBackgroundColor` turns it off, and the fog/sky blocks (including a custom
  atmosphere) survive `serialize()` → JSON → `applySerialized()`.
* **`DayNightCycle`** finds the directional light on attach, points it at the computed sun with the
  transmittance colour, turns it off at night with an ambient floor, tints the fog to the horizon,
  advances by *exactly* the fixed steps the clock executed (a 120 × 1/60 run and a 60 × 1/30 run land
  within one step, via `ManualClock`, whose constructor is fixed in this phase), wraps days and
  years in both directions, is idempotent per instant, and honours an explicit light and the
  `drive*` switches.

### `tests/environment8b.test.ts` — weather, clouds, water and lightning (Phase 8b)

CPU behaviour plus mock-device integration:

* **Weather state** orders the presets clear → storm, drifts exponentially (1 − 1/e of the gap per
  tau, path-independent down to float dust), turns the wind along the shortest arc, and drives fog
  density / sky turbidity / cloud cover + deck wind into the scene (or nothing, with the `drive*`
  switches off), advancing by exactly the fixed-step budget through `update()`.
* **Weather fields** are pure in (x, z, t, seed): zero gust samples exactly the mean wind,
  turbulence stays under `gust·(2 + 0.3·speed)` per component, temperature falls at the lapse rate,
  and a dry state rains nowhere.
* **Cloud deck**: coverage 0 is clear and 1 is overcast at `density`, the large-area mean rises
  monotonically with the slider, the CPU shading reproduces the documented formula (silver lobe
  toward the sun, dense cores transmitting less, linearity in the sun, horizon fade, noon brighter
  and bluer than sunset for the same deck), lit by `AtmosphereModel` transmittance + ambient — and
  `SkyLightingCache` re-evaluates only when the sun moves.
* **Water**: the Gerstner sampler reproduces single-wave closed forms (height, analytic normal,
  crest, `steepness/k` horizontal displacement), stays in its amplitude budget with unit normals and
  0..1 crests, foams past the threshold with a smoothstep shoulder; the grid source is a valid
  indexed plane with amplitude-padded bounds; `WaterSurface` owns the clock and the queries.
* **Lightning**: the flash envelope is a double stroke below 1 % after `flashDuration`, bolts are
  deterministic cloud-to-ground polylines of `2^subdivisions + 1` points, the Poisson scheduler
  replays identically for a seed and goes quiet with the tap closed, and `present()` drives the
  flash light, the sky exposure override and the bolt lines.
* **Mock-device rendering**: the `water` technique and the cloud deck (coverage 0.55) draw with zero
  validation errors and `stats.clouds === true`; a camera below `water.level` takes the underwater
  path (`stats.underwater`, no `forge.sky`, scene fog untouched); clouds/water/wind survive
  `serialize()` → JSON → `applySerialized()`.

### `tests/wgsl.test.ts` — the layout rules browsers disagree on

Chromium's compiler accepts uniform structs with a relaxed layout; WebKit rejects the module, which
on Safari is a black canvas with a live HUD. The suite asserts that every generated struct emits
scalar padding (never `array<u32, N>`), reports no `uniformLayoutProblems()`, keeps its byte
offsets/sizes (`PerFrame` 256 with `fogParams` at 240, `Light` 80, `LightBlock` 1296, `Shadow` 656
(with spot matrices at 288 and parameters at 544), `ShadowPass` 80, `Post` 48, `Material` 80, `Object` 176, `Instance` 80, `Sky` 128 B, `Cloud` 96 B,
`Water` 224 B, `Ssao` 112 B), that every
shipped shader variant — including the depth-only and post modules added in Phase 2, the sky
module added in Phase 8a, the water module added in Phase 8b and the SSAO module added in Phase 13 —
passes `validateWgsl`, that `toWgsl("uniform")`
throws for a sub-16-byte array stride, that struct-typed members sit on 16-byte boundaries, and that
`validateWgsl` flags the exact pattern that shipped (`pad68: array<u32, 3>`), nested-struct
strides, root-level uniform arrays and unpadded struct members while accepting legal layouts.
`semantics` issues pin the smoothstep class that failed the CI browser gate on the particle
billboard: literal reversed or equal edges (`smoothstep(0.5, 0.35, r)`, `smoothstep(0.5, 0.5, x)`,
negative/exponent literals included) are rejected with a message that names the
`1.0 - smoothstep(high, low, x)` rewrite, commented-out edges are ignored without shifting the
reported line, runtime (identifier) edges are not a static error, and the shipped
`PARTICLE_RENDER_SHADER` uses the spec-legal `1.0 - smoothstep(0.35, 0.5, r)` form.
Phase 13.3 adds `ClusterUniforms` (48 B) to the uniform registry and two *storage* blocks:
`ClusterLightBlock` (16 + 256 × 80 B) and `ClusterGridBlock` (3 072 × 8 + 98 304 × 4 B — far past the
64 KiB uniform binding limit, which is why both are storage-bound). The suite asserts they are sized
from the grid constants alone with nothing hardcoded, that their generated declarations appear
*verbatim* in the module that binds them (a hand-edited WGSL struct cannot be kept in step with the CPU
writer), and that the forward shader still passes the strict validator with them embedded. It also pins
the two source-level guarantees the pixel identity rests on: exactly one `fn lightContribution` with two
call sites (the uniform loop and the cluster loop shade through the same function), behind a runtime
`perFrame.flags & FLAGS_CLUSTERED` branch and no compile-time define, so every shipped variant contains
both paths and one pipeline can be A/B'd. `semantics` issues now also cover WGSL's **reserved words**:
the grid's offset array shipped as `meta`, which Tint rejects at parse time ("'meta' is a reserved
keyword") while the mock device and every structural check stay green — `reservedWordIssues` flags a
reserved word used as an identifier (struct member, local or global) on its real line, leaves attribute
spellings (`@align`, `@invariant`) and prose alone, does not claim the language's own words
(`struct`, `let`, `uniform`, `f16`), and the shipped corpus has none.

### `tests/physics.test.ts` — the solver, and the heightfield it stands on

Parabolic integration, restitution without micro-jitter, Coulomb friction on an incline, a stable
3-box stack, identical trajectories at 15/30/60/144 Hz, and raycasts against sphere and plane. Phase 9
added the heightfield contract (`collideSphereHeightfield` / `collideBoxHeightfield`, the contact type
every terrain-physics claim rests on): a sphere's penetration is measured from the sampled height with
the normal pointing *into* the field, a flat field contacting nothing above the surface, a box
generating one contact per penetrating corner only (four of eight for a box resting through a plane),
and a ball settling exactly one radius above a sloped field. It also pins shape-argument validation:
`new BoxShape(new Vec3(1, 1, 1))` used to produce NaN half-extents that surfaced much later as NaN
contacts; it now throws `UsageError` at the constructor, while finite degenerate sizes still clamp.

### `tests/tasks.test.ts` — worker execution (Phase 9.1)

Two layers against the same shipping code. The worker-scope protocol is driven in-process over a fake
scope: messages posted before the handlers exist are queued and replayed, a missing handler answers
`inlineFallback: true`, `InlineOnlyError` asks for the main thread, a cancel is acknowledged and a
result that arrives afterwards is discarded, and installing the scope twice is a no-op. The scheduler
is checked on the main thread: dedupe by key shares one promise, priority and FIFO order decide which
task runs first, `cancel`/`cancelGroup` reject with `TaskCancelledError`, `queueTimeoutMs` drops a task
that never starts, failures reject the submitter and count `failed++`, `(priority, key)` resolution
order holds, `dispose()` drains, and `stats()` reports workers/queued/running/completed counters.
Then a **real second thread** (`tests/support/workerThreads.ts` bundles the engine's own worker entry
with esbuild and runs it on `node:worker_threads`): a task reports the worker's `threadId`, three
workers run concurrently, terrain generated in a worker is **bit-identical** to inline generation
(including `pipelineHash`), progress messages are applied, two submits with one key across different
workers deliver the same object, cancellation while running works, a handler that only exists on the
main thread falls back inline, a throwing handler surfaces its message, and a worker killed mid-task
(`worker_threads` error) is retried inline while `workerFailures++` and the pool shrinks. The
`geometry.bvh` task is exercised the same way: the tree built on another thread is byte-identical to
the inline build (node arrays *and* hash) and answers the same ray, with the payload copied rather
than transferred so the caller keeps its geometry. `tests/workerBundling.test.ts` pins the packaging
half: the default worker must be constructed in the one shape bundlers statically recognise —
`new Worker(new URL("./worker-entry.js", import.meta.url), …)` — because computing the URL through a
variable makes Vite inline the worker's raw TypeScript as a `data:` asset URL instead of emitting a
compiled worker chunk (the worker then dies on a parse error, logged with an empty message —
"worker N crashed: unknown"). Crash logs are therefore required to name the entry script and to fall
back to the event's `filename:line` when there is no `message`.

### `tests/bvh.test.ts` — the mesh BVH (Phase 9.1)

The index the worker builds is only useful if it is correct and deterministic, so the suite pins
both: every triangle appears exactly once in `triOrder`, leaves never exceed `leafSize`, internal
nodes always have two children, the root bounds contain every vertex, and `maxDepth` is honoured.
400 deterministic rays are then answered by the BVH and by `raycastTriangles` (the brute-force
reference in the same module) and must agree *exactly* — same hit or miss, same triangle, same
distance — which is the strongest available check that the traversal preserves the query. Rebuilding
the same geometry yields byte-identical node arrays and the same FNV-1a `hash`, while a different
`leafSize` yields a different tree and a different hash. Degenerate inputs (no triangles, one
triangle, a zero-area triangle, every triangle co-located so the centroid extent is zero) must not
throw, must not recurse forever and must not report hits. Frustum/bounds queries are checked as
*candidate* sets: a superset of the brute-force per-triangle AABB test, and strictly smaller than the
whole mesh for a narrow view. The `geometry.bvh` payload round trip is covered here (structured
clone, `MeshBvh.fromData`) and on a real thread in `tests/tasks.test.ts`.

`tests/math.test.ts` gained the companion regression: `Mat4.multiply` used to corrupt the matrix it
was multiplying into (writing a column clobbers the columns later iterations still read), so the most
natural call in the API — `proj.multiply(view)` — produced a matrix with garbage translation
columns. The old frustum test hid it by passing a second argument that never existed and only
checking points on the axis; it now uses `multiplyMatrices` and the new case asserts in-place and
three-operand forms agree, including `m.multiply(m)`.

### `tests/gpuEnv.test.ts` — which Vulkan ICD the gate launches with

`tools/gpu-env.mjs` is asked, before any browser exists, which ICD a headless Chromium should use, and
the suite pins that answer by driving the tool as a CLI — the same way `scripts/setup-deps.sh` drives
it, so the shell script's contract is covered too. A directory shaped like a browser that bundles its
own stack must yield `VK_ICD_FILENAMES`/`VK_DRIVER_FILES` pointing at that file and its directory on
`LD_LIBRARY_PATH`; an ICD the caller already named must win; a build with no bundled ICD must set no
`VK_*` variable at all (the loader's own list is then the decision) while still searching the binary's
directory; payload libraries (the @sparticuz `al2023/lib`) must come first and no path may repeat; a
browser that does not exist must produce an answer, not a crash. This is the failure mode that costs
the most time, because the browser still starts: `navigator.gpu` exists, `requestAdapter()` returns
null, and the gate reports "did not run" while the engine is fine.

### `tests/resources.test.ts` — the resource cache (Phase 9.2)

Acquire/release refcounting, one load per id (a second acquire while a load is in flight joins it), a
disposer that runs exactly once when the last lease goes, `bytes` accounting reconciled against
`stats()`, pinned entries surviving eviction, and the eviction contract itself: `evictIdle()` collects
only entries idle past the grace period, `evictIdle(target)` evicts least-recently-used entries until
the byte target is met (ignoring the grace period, which is what memory pressure means), eviction
disposes the value and invalidates outstanding handles so a later `release()` is safe, an in-flight
load that gets evicted rejects its acquirer with `ResourceLifecycleError`, a failed load is retried on
the next acquire, and `stats().evictedBytes` grows by the evicted bytes.

### `tests/gpuMemory.test.ts` — GPU memory accounting (Phase 9.3)

`GraphicsDevice` instruments the *raw* device's allocation entry points, so a buffer created through
`device.device.createBuffer` is counted even when it bypasses the wrapper (which is how the renderer's
internal allocations are made). The suite pins: a fresh mock device reports zero bytes; a raw buffer
plus an engine buffer report exactly their sizes and counts; `describeTextureBytes` matches a mip
chain's byte sum; `device.beginFrame()` resets the per-frame counters; a steady rendered frame adds no
bytes and no allocations; a resize shows a bounded one-off texture cost; and `engine.gpuMemoryReport()`
assembles device bytes, render-graph transient/pooled bytes and registry evicted bytes into one
`GpuMemoryReport` with `tasks` visibility (`sum.bytes === sum.textureBytes + sum.bufferBytes`).

### `tests/coordinateSpaces.test.ts` — world, render, chunk and terrain spaces (Phase 9.4)

`worldToRender`/`renderToWorld` round-trip in float64, and a point 500 km from the origin survives the
round trip with < 1 mm of error while still narrowing to a float32 render coordinate (the point of
having an origin at all); `ChunkCoordinate` conversion floors negative world coordinates into the
right cell and rejects a non-positive chunk size with `RangeError`; chunk origins and offsets
reconstruct the world point; terrain coordinates and `CoordinateSpace.chunkOf`/`offsetOf` agree with
the standalone helpers, and `renderSpaceOf` reflects the live origin after a recenter.

### `tests/capabilities.test.ts` — the registry cannot lie (Phase 9.5 / 9.6)

Registry contract (unique ids, evidence for `verified`, a closer for `partial`, resolvable roadmap
references, every Phase 9 item claimed, `ROADMAP.md`'s engine-state block equal to the registry's phase
markers, JSON-safe snapshots and frozen entries) plus the two document cross-checks that give 9.6 its
teeth: every bullet in `docs/KNOWN-ISSUES.md` references a capability that is *not* verified, and the
stale Core entries about untested worker round-trips and untested eviction are gone. One test runs
`tools/docs-check.mjs` itself, so the gate cannot rot silently.

## A real browser + real WebGPU runs here

`tools/browser-check.mjs` starts the Vite demo on its PBR fixture (`?scene=pbr`; the no-query landing
page defaults to Mars Showcase), which has 19 instanced batches, an emissive cube, a shadow-casting
sun, HDR + bloom + 3 cascades. It drives headless Chromium over a real
WebGPU adapter (`google/swiftshader` with Vulkan backing), and asserts that:

- The no-query scene selector defaults to Mars Showcase, while an explicit `?scene=pbr` still routes to
  the PBR fixture used for the rendering-foundation assertions.
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
- **Depth prepass, SSAO and aliasing (Phase 13.1 / 13.2)**: the default frame runs exactly one
  `forge.prepass` (with `prepassDraws >= 1`) and the three `forge.ssao*` passes, in the order
  prepass → estimate → blur.h → blur.v → `forge.main`; `aliasedBytes > 0` with fewer physical than
  transient textures (measured: 11 transients → 10 textures, 921,600 B aliased at 1280×720).
- **SSAO A/B, per pixel at full resolution**: with the animation frozen, switching SSAO off must drop
  its passes (the prepass stays), and comparing the two frames pixel by pixel, SSAO must darken at
  least 0.1 % of the frame by more than one luma level, brighten **no** pixel by more than one level
  (ambient occlusion can only remove light), and lower the mean by less than 15 % (contact shading,
  not a dimmer). Measured on the PBR fixture: 3,905–4,066 of 921,600 px darker (up to ~5 levels,
depending on where the animation froze), 0 brighter.
- **Prepass identity**: with SSAO off, switching the prepass off as well must not change a single
  pixel by more than one level — measured: 0 pixels differ at all (max difference 0). That is the
  `@invariant` + shared-vertex-module design proven on a real compiler.
- **Clustered lighting identity (Phase 13.3)**: with the fixture's four lights, switching clustering
  off must not change a single pixel — measured 0 px differ by even one luma level (max diff 0.00) and
  the same 18 passes, because both light loops call the same shading function over the same lights in
  the same order. Anything else is a light the grid failed to index, or a slice boundary the CPU and
  the GPU quantise apart.
- **Many lights (Phase 13.3)**: the demo's **+36 lamps** rig puts 40 lights in the scene. Clustering
  must carry all 39 local lights (`clusteredLights === lights − 1`) with nothing dropped, the uniform
  path must truncate at 16 and report `lightsDropped`, and the clustered frame must be strictly
  brighter — measured 88,036 of 921,600 px brighter (up to 204 levels) and **none darker**, since
  adding lights can only add. Removing the rig restores the fixture's four lights, and the demo's
  `Clustered` button must move the setting it shows and mark itself pressed.
- **Cluster-fill identity (Phase 13.4)**: the demo's `?lightculling=cpu|gpu` switch (and the gate's
  `setLightCulling`) must produce the *same* picture over the fixture (measured: max luma diff 0.00,
  0 px beyond one level) and the same grid stats, with `forge.lights.assign` present in the gpu arm's
  frame and absent from the cpu arm's. Past the per-cluster cap (the 40-lamp ball) the two fills must
  keep the same 32 lamps — the eviction path is where a transcription error shows up as differently
  coloured pools of light.
- **Object-culling identity (Phase 13.5)**: with the animation frozen, the device cull path
  (`setObjectCulling("gpu")`) and the CPU twin (`"cpu"`) must draw the same frame (measured: max luma
  diff 0.00, 0 px beyond one level), `forge.objects.cull` must be in the gpu arm's pass list and absent
  from the cpu arm's, the twin must test every batch, and the device counters must be either the lagged
  zero or the frame's own batch count. **HiZ occlusion must only ever add draws**: with
  `setOcclusionCulling(false)` the `forge.hiz.*` passes disappear and the frame must not change at all
  (measured: 0 px differ, 0 px darker) — a batch it dropped as hidden was hidden. That assertion is what
  caught the mirrored-rectangle bug, which showed up in the *prepass* section as
  `16161 px differ by up to 162.0 luma levels` because the collapsed batches took their prepass depth
  with them.
- **Cascade debug view** renders without errors, and after every toggle the settings are restored,
  the pass count is back to the HDR default, SSAO is back on, and `gpuErrors` is still 0. The LDR
  readback above also asserts the prepass + SSAO chain survives the switch to the swapchain path.
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
  must present with `gpuErrors === 0`. The fountain must become ready, report `emitted > 0` (cumulative spawn counter — there is no concurrent live-count readback), and execute `particle.sim` / `particle.sort` / `particle.render` / `particle.resolve` after settle.
  The car is not driven here — stopping distance and the 12° climb are unit tests. Screenshots:
  `tools/.browser-check-vehicle.png`, `tools/.browser-check-particles.png`.
- **Sky and day/night (Phase 8a)**: `loadScene("sky")`, then `setTimeOfDay(12)`: the cycle must report
  daytime, `forge.sky` must be in the executed pass list *directly after* `forge.main` (the sky shader
  compiled and ran on the real adapter with `gpuErrors === 0`); `setTimeOfDay(1)` must report the sun
  off (`lightIntensity === 0`) and a mean luminance below half of noon's (measured 172 vs 6);
  `setSky(false)` must drop the pass (the graph re-plans) and `setSky(true)` + `setPlanet("mars")`
  must bring it back with zero GPU errors. Screenshots: `tools/.browser-check-sky-noon.png`,
  `-night.png`, `-mars.png` — the sun colour, ambient and fog colour the cycle derived are in the HUD.
- **The sky demo's on-screen buttons**: the scene's actions used to be keys-only (`[`/`]`, `T`,
  `M`); the buttons are the interface now, on every device. At the desktop width the panel must be
  `display: block` with all four buttons and the keyboard hint hidden, and a real `page.click` on
  each must move the state its key moves — `+1h` a clock hour forward, `Pause` stopping the clock
  (`timeScale === 0`) with the button marked pressed and the second tap restarting it and unmarking
  it, `Mars` swapping the planet (read back through `window.__forge.skyPlanet()`) with the button
  marked pressed and the second tap swapping back. Presses repaint synchronously, so these hold
  while the frame loop is frozen for the pixel A/Bs above.
- **Weather, water, lightning (Phase 8b)**: `loadScene("weather")`, then at noon `setWeather("clear")`
  (coverage < 0.2) vs `setWeather("storm")` (coverage > 0.9, `clouds` flag set): the overcast frame
  must be > 5 % brighter than the clear frame (measured 201 vs 148 — the deck whitens the sky while
  the sun still lights the ground, `docs/KNOWN-ISSUES.md`), with `forge.sky` in the pass list and
  `gpuErrors === 0` (the new water program and cloud bind group compiled on the real adapter); at
  night with the weather held clear, `setCoverage(1)` must darken the frame vs `setCoverage(0)` (the
  unlit deck occludes the stars); `triggerLightning()` must register a strike;
  `setUnderwater(true)` must drop `forge.sky` from the pass list with `underwater` set, and
  `setUnderwater(false)` must bring it back. Screenshots:
  `tools/.browser-check-weather-clear.png`, `-storm.png`, `-night.png`, `-underwater.png`.
- **The weather demo's on-screen buttons**: the buttons are this scene's interface on every device
  (the keys are only shortcuts), so the panel must be up at a phone width (390 × 780) too:
  `display: block` with all nine buttons and the keyboard hint hidden;
  `window.__forge.setWeather("rain")` (a change from outside the panel)
  must move the pressed marker to `Rain`; and a real `page.click` on each button must move the state
  its key moves — `Storm` > 0.9 coverage with the button marked pressed, `Strike` exactly +1 strike
  (`storm01` is 0 at that point, so the scheduler contributes nothing), `Dive` into the underwater
  path with `forge.sky` gone and back out, `+1h` a clock hour forward, and `Pause` freezing the
  day/night clock across two presented frames after which it moves again on resume. The clock is
  bracketed against the drift measured in the same run rather than wall-clock rate: the fixed clock
  is catch-up limited and SwiftShader presents the weather frame a couple of times a second, so the
  demo's 60× day runs far slower here (measured ~0.0028 h per 2 frames). Finally the viewport goes
  back to desktop width, where the panel must still be shown with the hint hidden. Screenshot:
  `tools/.browser-check-weather-touch.png` (the panel as a phone sees it).

Run it with `npm run check:browser`, then **look at `tools/.browser-check.png`**: the automated
thresholds prove the passes ran and changed the pixels in the right direction; whether the shadows
are crisp and the bloom halo is where the emissive cube is remains an eyeball check.

Provisioning is part of the gate's contract, not a prerequisite left to the reader:
`scripts/setup-deps.sh` installs the Vulkan loader and a software ICD (Mesa's lavapipe) when the machine
has none, and `tools/gpu-env.mjs` — the one place that decides — points `VK_ICD_FILENAMES` at the ICD
bundled next to the browser when the build ships one, otherwise leaves the system list to the loader
and says so. Both choices are printed before the adapter probe, so a run that cannot present WebGPU is
never mistaken for a broken engine. `npm run setup` also writes that environment to
`$TMPDIR/forge-gpu-env.sh` for launching the same browser by hand.

The browser it drives is Chromium, and specifically the *full* build (`channel: "chromium"`).
Playwright's default headless launch uses `chromium-headless-shell`, which has no WebGPU at all — under
it the page boots with no adapter and the gate reports an engine failure that is really a browser
choice (this is how the CI job first failed). The pass line prints the adapter it found
(`gpu: adapter ok (google / swiftshader)`), and a failure prints the same probe, so the log says
whether the browser or the engine was at fault. WebKit (Safari, every iOS browser) is stricter about
uniform address-space layout, and that difference is enforced statically instead: `StructDef.toWgsl("uniform")`
refuses illegal definitions, `validateWgsl` applies the same rules to shader text at module creation,
and `check:wgsl` + `tests/wgsl.test.ts` run both. No automated check compiles the shaders on WebKit.

## Verified capabilities

* **A rendered frame with the Phase 2 chain.** Headless Chromium renders the PBR scene through
  cascaded shadow maps, an `rgba16float` forward pass, a 5-mip bloom chain and a tonemap resolve, with
  real shader compilation and zero GPU errors.
* **Render graph semantics.** Validation, culling, live-range aliasing, cross-frame pooling and
  retirement, single-submit recording — all on the mock device, where every allocation is visible.
  Aliasing also happens in the production frame now (the SSAO chain), on the mock and on real WebGPU.
* **Depth prepass and SSAO (Phase 13.1).** The prepass frame is pixel-identical to the frame without
  it on real WebGPU; SSAO only ever darkens, locally. `docs/RENDERING.md` §4a says how, §9 what it
  does not do.
* **GPU object culling (Phase 13.5).** Frustum, per-batch distance and HiZ occlusion on the device
  (`forge.objects.cull` + the `forge.hiz.<n>` pyramid), with the CPU twin as the mock device's path and
  as the reference `tests/objectCulling.test.ts` pins byte for byte. On real WebGPU the two cullers draw
  the same frame, the pass belongs to the arm that ran it, and switching the HiZ stage off never
  darkens a pixel. `docs/RENDERING.md` §4d says how; per-batch granularity, the 8192-batch cap and the
  CPU path's missing occlusion are `KNOWN-ISSUES.md`.
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
* **A sun, a sky and fog.** The sun position is checked against Meeus/NOAA numbers, the atmosphere
  against closed forms and published coefficients, the fog against a brute-force integral
  (`tests/environment.test.ts`); the `forge.sky` pass structure is pinned on the mock
  (`tests/frame.test.ts`) and compiled + A/B'd (noon vs night) on real WebGPU in `check:browser`.
  What is *not* checked is colorimetric accuracy against a reference sky image or a spectral model —
  `docs/ENVIRONMENT.md` §6 lists the approximations.

* **Worker execution on real threads.** `tests/tasks.test.ts` runs the shipping worker scope on
  `node:worker_threads`: results, cancellation, progress, deterministic terrain identical to inline
  generation, and crash recovery. A *browser* worker round-trip is still not asserted
  (`capability: workers.browserThreads`), because neither the demo nor the gate submits a task.
* **A mesh BVH, built on any thread.** `tests/bvh.test.ts` pins correctness (parity with brute force
  over 400 rays), determinism (byte-identical rebuilds and a stable hash) and degenerate input;
  `tests/tasks.test.ts` proves the same tree is produced by a real worker thread. Nothing *uses* it
  yet — raycasts, culling and the broadphase are unchanged (`capability: physics.spatialIndex`).
* **GPU memory accounting and resource eviction.** `tests/gpuMemory.test.ts` counts bytes through the
  raw device's own entry points; `tests/resources.test.ts` pins eviction, refcounts and stale handles.
* **Coordinate spaces.** `tests/coordinateSpaces.test.ts` is the reference for `docs/COORDINATES.md`.
* **The project's own claims.** `npm run docs:check` fails when the capability registry, `ROADMAP.md`'s
  status block and `docs/KNOWN-ISSUES.md` disagree — a limitation cannot outlive its implementation,
  and a phase cannot be advertised as verified while a capability inside it is not.

## Not verified yet

* **A WebKit compile.** Uniform-layout strictness is enforced by the static validator and unit tests
  (above), not by running Safari; there is no WebKit build in the sandbox.
* **Bloom and shadow *quality*.** The gates prove the effects are present and act in the right
  direction (A/B luminance) and that the cascade fit is geometrically correct; they do not compare
  against a reference image. The same holds for SSAO: the gate proves it darkens contact areas, never
  brightens and is not a global dimmer — not that its occlusion matches a ray-traced reference.
* **GPU timestamp fidelity on physical adapters.** The mock tests exercise asynchronous timestamp resolves and readback with deterministic nanosecond clocks; no CI assertion compares timestamp-query durations against a physical GPU or another timing source.
* **A browser-side worker round-trip.** The Node suites drive the shipping worker scope on real
  threads, but no test starts a module worker in a browser and submits a task through it
  (`capability: workers.browserThreads`).
* **Mesh decoding off-thread.** There is no glTF/GLB decoder to run anywhere yet
  (`capability: assets.meshDecoding`), so Phase 9.1's third bullet stays open.
* **Using the BVH.** The tree exists, is deterministic and can be built in a worker; grid-marched
  terrain raycasts, the pairwise broadphase and per-batch AABB culling do not consult it
  (`capability: physics.spatialIndex`). Nothing measures a speed-up yet.
* **Per-instance GPU visibility remains coarse.** The device HiZ pass culls whole colour batches:
  one visible instance keeps its batch. Phase 13.9 separately assigns CPU-side world-AABB masks and
  contiguous instance ranges to cascade/spot maps, but those shadow submissions are not driven by
  the HiZ cull pass. The device does not yet independently compact individual instances across the
  colour and shadow passes (`capability: rendering.cullCoverage`).
* **Terrain streaming quality.** The browser gate proves the terrain camera can move and stays above
  the surface, and the unit suites cover chunk generation, LOD selection, the resident-chunk budget
  and elevation queries; nobody asserts *how much* of the world is resident, how the boundary of the
  loaded disc looks, or how long a hitch a chunk takes to generate on a given machine.
* **Particle *rendering* completeness.** Unit suites and the browser gate prove the Phase 12 GPU
  fountain path: GPU emit/sim, frustum+distance compact, and `drawIndirect` billboard / soft-particle
  render through `particle.sim` / `particle.sort` / `particle.render` / `particle.resolve`. They do
  not prove mesh particles, ribbon draw, HiZ occlusion cull, or particle/terrain collision — those
  remain deferred (`docs/PARTICLES.md`, `docs/KNOWN-ISSUES.md`). The Phase 7 CPU path still poses
  sprite entities for weather/Mars dust demos; that is not the Phase 12 fountain.
* **Vehicle handling quality.** The unit suite proves the analytic stop, the slope, load transfer,
  shifts, and TC slip. The browser gate only proves the playground loads. Nobody asserts that the
  ramp mesh and the ground query stay coincident after a camera-follow frame, or that the car is
  pleasant to drive.
* **Sky *appearance*.** The gates prove the sky pass runs, darkens at night and swaps presets; the
  colours are validated numerically against the CPU model's closed forms, not against photographs or
  a spectral reference renderer. Multiple scattering is absent (`docs/KNOWN-ISSUES.md`).
* **The limits of a green CI run.** CI executes the CPU gates, prints in the job log what it does not
  cover (`capability: testing.browserGateInCi`), and runs the WebGPU browser gate as a separate
  *advisory* job. Making that job real needed three things a sandbox with a prepared browser gets for
  free: the full Chromium build (`channel: "chromium"` — the bundled headless shell has no WebGPU at
  all), a Vulkan loader with a software ICD (Playwright never installs `libvulkan1`, so without it
  `navigator.gpu` exists and `requestAdapter()` still returns null), and a page that does not request a
  favicon it does not have (a 404 is a console error, and console errors fail the gate). The middle
  one is now `scripts/setup-deps.sh`, run by the job exactly as a developer runs it locally, so the two
  cannot drift; the job pins the browser it provisions through `PLAYWRIGHT_CHROMIUM` and attaches the
  setup script's output to the pull request next to the gate's.
  Its log is mirrored onto the pull request as a comment, because job logs cannot be downloaded from
  every environment. If that runner cannot launch a WebGPU browser the script exits 2, the job
  says so and passes with a warning — it proves nothing about rendering, which is exactly what an
  advisory check should admit. WebKit and mobile browsers are not run in CI, and GPU timestamp fidelity
  is not asserted on a physical adapter; a failing advisory job never blocks a merge, so a green PR is
  not a rendering verdict.
