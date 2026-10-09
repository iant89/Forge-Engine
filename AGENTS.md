# AGENTS.md — working in this repository

Guidance for coding agents (and humans) contributing to Forge, a browser-native WebGPU 3D engine.
Read this before running anything. `ARCHITECTURE.md` explains *why* the code is shaped the way it is;
this file is about *how to work in it* without breaking the things the tests were written to protect.

## 0. Start here: set up the toolchain before testing

> **Before running any tests, run `scripts/setup-deps.sh` (or `npm run setup`) and let it finish. It
> provisions the npm dependencies and installs/extracts headless Chromium + SwiftShader for the
> browser checks. Do not begin testing until this setup step has run.**
>
> ```sh
> scripts/setup-deps.sh    # required before testing; provisions dependencies and Chromium
> npm run setup            # equivalent npm entry point
> npm run setup:check      # verify only; does not install missing dependencies or Chromium
> ```

`scripts/setup-deps.sh` is idempotent: it probes every dependency, compares versions against the
repo's own manifests (`engines.node` in `package.json`, the pins in `package-lock.json`, the
`@sparticuz/chromium` package version), and only installs what is missing or wrong. On a healthy
checkout it finishes in well under a second and prints a status table. It provisions:

| Dependency | Checked against | Fixed by |
| --- | --- | --- |
| Node.js | `engines.node` (`>=20.11`) | nvm/fnm if one is already installed; otherwise it tells you |
| npm | lockfile v3 → npm ≥ 7 | reports (npm ships with Node) |
| npm packages | exact versions in `package-lock.json` | `npm ci` (never `npm install`) |
| Headless Chromium + SwiftShader | `@sparticuz/chromium` major version | extracts the bundled binary to `$TMPDIR` (where `tools/browser-check.mjs` looks); falls back to Playwright's download when its CDN is reachable |
| Vulkan loader + software ICD | the loader on disk, and the ICDs in `/usr/share/vulkan/icd.d` | `libvulkan1` + Mesa's lavapipe via the distro's package manager (`sudo`, only when it will not prompt). A browser that bundles its own ICD (`vk_swiftshader_icd.json` next to the binary) does not need them, and then this is a warning, not a failure |

Flags: `--check` (verify only), `--no-browser` (skip the browser and Vulkan steps), `--browser` (fail
instead of warn when no browser can be provisioned), `--verbose`.

Which ICD the headless gate is launched with is decided by `tools/gpu-env.mjs` (and pinned by
`tests/tools/gpuEnv.test.ts`): the one bundled next to the browser when it has one — then `VK_ICD_FILENAMES`
and `VK_DRIVER_FILES` point at it and its directory goes on `LD_LIBRARY_PATH` — otherwise nothing at
all and the system loader picks. `npm run setup` writes that environment to
`$TMPDIR/forge-gpu-env.sh` so you can `source` it before launching the same browser by hand. Chrome
starts with no such ICD look healthy (`navigator.gpu` exists) and then `requestAdapter()` returns null,
which is what the gate reports as "did not run" rather than a failure. In sandboxes where the public CDNs are blocked
the bundled-Chromium path is the one that works; do not spend time trying to `playwright install`.

## 1. Commands you will actually run

```sh
npm run typecheck        # strict engine + examples + tests typecheck
npm test                 # selrun full suite; ordered, one process per linked suite
npm run test:serial      # explicitly run the ordered linked suites sequentially
npm run test:affected    # select from staged/unstaged/deleted/renamed/untracked changes (see §8)
npm run test:affected:print  # show the working-tree selection and reasons without running it
npm run test:affected -- --base origin/main  # compare origin/main...HEAD only; ignore working-tree changes
npm run test:check       # verify suite manifests, explicit covers, links, and declared count
npm run check:wgsl       # structural WGSL validation + strict uniform address-space layout of every shipped shader
npm run verify           # typecheck + test + check:wgsl — run this before every commit
npm run lint:arch        # import boundaries (ARCHITECTURE.md §2), no WebGL anywhere, no engine/src deep imports
npm run docs:check       # capability registry agrees with ROADMAP.md's state block and docs/KNOWN-ISSUES.md
npm run check:browser    # REAL WebGPU: Vite demo in headless Chromium/SwiftShader, all sections
npm run check:browser:renderer # full-gate PBR/rendering A/B section only
npm run check:browser:terrain # full-gate terrain population/camera/compute section only
npm run check:browser:vehicle-particles # full-gate parking-brake + particle section only
npm run check:browser:animation # full-gate skinned-arm section only
npm run check:browser:environment # full-gate sky + weather section only
npm run check:browser:mars # full-gate Mars inspector/showcase/drive/HGA/arm section only
npm run check:browser:mars-workers # scoped native-worker + Mars upload/render check, NOT the full gate
npm run check:browser:mars-generator # scoped real-WebGPU crater-rim mask check, NOT the full gate
npm run check:browser:terrain-layers # scoped real-GPU splat pixel oracle + showcase A/B, NOT the full gate
npm run demo             # Vite dev server for examples/ (binds 0.0.0.0, allowedHosts: true)
```

The default `check:browser` runs the six named sections above, in order, in one browser session. Each
`check:browser:<section>` command starts a fresh browser and runs only that section; a section pass is
not a full-gate pass. `verify` is necessary but not sufficient for rendering changes. The mock device
cannot tell you whether anything is *visible*; `check:browser` can, and it writes
`tools/.browser-check.png` — **look at the screenshot**, don't just read the pass/fail line. (A previous
black-screen bug passed every automated gate because the thresholds were too loose; they have since
been tightened, but a human/agent eyeball on the PNG is still the cheapest check there is.)

## 2. Repository map (what exists today)

```
engine/src/          @forge/engine — the runtime, zero runtime deps, builds with tsc
  core/              Engine loop, config, time, events, logging, task scheduler + worker entry
  gpu/               GraphicsDevice, buffer/struct writers, formats, shader cache, constants
  math/              Vec/Mat/Quat, Double3 (large worlds), geometry (AABB/Frustum/Ray), noise, rng
  rendering/         Renderer (one frame in/out), RenderGraph (validation, culling, aliasing, pooling),
                     shadows.ts (cascade fit), PipelineFactory, Material, Geometry, primitives,
                     uniforms (single source of truth for WGSL structs), shaders/{standard,post,sky,common}.ts
  scene/             Scene, EntityWorld (ECS-ish), component stores, Transform/Camera/Light/Renderable
  physics/           fixed-step rigid bodies (Phase 5). Vehicles are not in this solver.
  vehicles/          raycast car: Pacejka, suspension, engine/gearbox/diff, aero, TC/ABS (docs/VEHICLES.md)
  particles/         CPU simulation + a compute integrator for the same gravity/drag/life step (docs/PARTICLES.md)
  environment/       sun position (NOAA/Meeus), AtmosphereModel (CPU twin of the sky shader), fog formulas,
                     DayNightCycle (docs/ENVIRONMENT.md). Phase 8b (weather/clouds/water) goes here too.
  population/        Phase 14 world population: deterministic scatter into SoA blocks, PopulationWorld
                     streaming; the seam (blocks + source/collector) lives in scene/population.ts
  resources/         ResourceRegistry, textures + defaults
  testing/           MockGPUDevice (strict validation, leak tracking) used by the mock-GPU suites
examples/            Vite demo — scenes: pbr, cubes, terrain, realistic, vehicle-playground, particles, sky, weather, mars-showcase.
                     Also the fixture `check:browser` drives. Orbit keyboard pan is on unless a scene sets `keyboard: false`.
tests/<area>/        selrun TypeScript suites; `tests/full.test.ts` is the ordered link list
packages/selrun/     local manifest-driven runner, catalog validation, and affected-suite selector
benchmarks/          100k-entity ECS bench and 100k-particle integrator bench (`npm run bench`)
tools/               wgsl-check.mjs (includes PARTICLE_SIM_SHADER + SKY_SHADER), browser-check.mjs (real-GPU gravity check, sky A/B); browser smokes remain separate from Node suites
scripts/             setup-deps.sh
docs/VERIFICATION.md What each automated gate actually proves — keep it truthful when you change gates
docs/RENDERING.md    The renderer as built: frame structure, render graph rules, HDR/bloom, CSM, sky pass, how to add a pass
docs/VEHICLES.md     Phase 6 as built, including what the chassis test actually asserts
docs/PARTICLES.md    Phase 7 as built: CPU is the reference, the compute shader is the integrator only
docs/ENVIRONMENT.md  Phase 8a as built: solar model, atmosphere, fog, day/night — and what 8b still owes
ARCHITECTURE.md      Design + rationale; ROADMAP.md — phase 8b and phases 9–14 are not built
```

The demo aliases `@forge/engine` to `engine/src/index.ts` (see `examples/vite.config.ts`), so there is
no build step between editing engine source and seeing it in the browser.

## 3. Conventions that are load-bearing (break these and things silently go dark)

* **Coordinate system: +Y up, camera/light look down their local +Z, view space is left-handed.**
  `Mat4.setLookAt` returns a *view* matrix (world→view; eye maps to origin, target to `(0,0,+d)`).
  `Mat4.setPerspective`/`setOrthographic` map depth to WebGPU's `[0,1]` with `clipW = z`.
  `Frustum.setFromViewProjection` extracts planes for exactly that convention.
  The render pipeline uses `frontFace: "cw"` because outward-wound primitives land clockwise on screen
  under this projection. These four agree with each other and are pinned by `tests/math/math.test.ts`;
  change one and you must change them all, plus the tests.
* **`Transform.lookAt(target)` aims local +Z at `target`.** Lights travel along their +Z, so
  `sun.transform.lookAt(x)` shines at `x`; the renderer refreshes `Light.direction` from the world
  matrix every frame while `followRotation` is true.
* **Matrices are column-major `Float32Array(16)`** and are uploaded as-is. Never transpose on upload.
* **`Mat4.transformPoint(v, out)` and friends must stay alias-safe** (`out === v` is how the scratch
  vectors are used). Read the inputs into locals before writing `out`; `tests/math/math.test.ts` pins it.
* **Every GPU pass goes through the `RenderGraph`.** Declare what a pass reads and attaches (per
  mip/layer where it matters); never call `encoder.beginRenderPass` on a texture the graph does not
  know about. The graph validates before recording and pools textures by descriptor — a steady frame
  must report `texturesCreated: 0` (asserted by `tests/rendering/frame.test.ts` and `check:browser`).
* **WGSL uniform structs are generated from `engine/src/rendering/uniforms.ts`.** Do not hand-edit
  struct declarations in `shaders/standard.ts`, `shaders/post.ts` or `shaders/sky.ts`; change the TS
  definition and `check:wgsl` will confirm the 16-byte alignment. Hand-written WGSL must still pass
  `check:wgsl`.
* **The sky shader and `environment/atmosphere.ts` are twins.** Same integral, same constants (via
  `SkyUniforms`), same cubic sample spacing. A change to one is a change to both, and
  `tests/environment/environment.test.ts` is where the CPU side is pinned against closed forms.
* **The strictest browser decides what is valid WGSL, and it is not the one `check:browser` runs.**
  Chromium accepts uniform structs with a relaxed layout (`array<u32, 3>` padding, arrays with a
  stride below 16 bytes, struct members off 16-byte boundaries) without being asked; WebKit rejects
  the shader module, and the result on iOS/macOS Safari is a black canvas with a live HUD and no
  error in the page. `StructDef.toWgsl("uniform")` emits padding as `u32` scalars and throws on a
  definition that breaks the uniform rules; `validateWgsl` (run by `ShaderCache` and `check:wgsl`)
  applies the same rules to every `var<uniform>` in hand-written WGSL. Do not weaken either to make
  a shader "work" in Chrome.
* **Colour is linear inside the shader; sRGB encode happens at output** (the swapchain format is not
  an sRGB format). In HDR mode "output" is the tonemap pass and the forward pass writes linear
  radiance to `rgba16float` (`perFrame.flags` bit 1); in LDR mode the standard shader encodes. The
  clear colour is encoded on the CPU to match whichever target it clears — keep them in step.
* **Hot data lives in typed arrays** (`TransformStore`, instance/object arenas). No per-frame object
  allocation in `Renderer.renderScene`, `collectBatches`, or the transform update; use the scratch
  fields that already exist on the class.
* **GPU lifetime is explicit.** Anything that creates a `GPUBuffer`/`GPUTexture` must release it in a
  `dispose()`; `tests/rendering/rendering.test.ts` asserts `mock.outstanding` is empty after teardown.
* **Public API only from the demo/tests** (`@forge/engine`), never deep imports into `engine/src`.

## 4. Editing rules

* TypeScript is strict with `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `noUnusedLocals`.
  Use `import type` for types, `.js` extensions on relative imports, and `!`/`?? 0` on indexed reads.
* Keep the doc comment at the top of each module accurate — they describe contracts, not history.
* If you change what a gate checks, update `docs/VERIFICATION.md` (test counts, what is asserted).
* Don't commit generated artifacts: `node_modules/`, `dist/`, `*.tsbuildinfo`, `tools/*.png` are
  ignored; leave them that way.
* Commit messages: imperative subject, a body that says what was broken and why the fix is right.

## 5. Debugging rendering problems — the order that works

0. Read the page. The demo HUD shows `gpu ok` / `gpu errors N` and pins the first GPU error (shader
   compile diagnostics, uncaptured validation errors, render exceptions) in the red box under it —
   that string is the bug report from a device you cannot attach devtools to. `engine.stats().lastError`
   carries the same text.
1. `npm run check:browser` and open `tools/.browser-check.png`. Black frame with HUD only means the
   camera/culling path, not the shader — *on Chromium*. The HUD's `graph N passes (M culled)` line
   and `engine.stats().renderPasses` tell you which passes actually ran: a missing `forge.bloom.*`
   or `forge.shadow.*` is a settings/quality gate or a culled pass (nothing consumed its output),
   not a shader problem; a `UsageError` naming a pass is a wrong `reads`/`color`/`depth` declaration. A black frame on Safari with a green
   `check:browser` is a WebKit-only shader rejection until proven otherwise: run `npm run check:wgsl`
   and look for uniform-layout issues first.
2. Reproduce the camera/light math in a throwaway `tsx` script against `Mat4`/`Frustum` directly
  (fast, no GPU) before touching the renderer.
3. For lighting: temporarily raise `scene.settings.ambientIntensity` or the light `intensity` in the
   demo to separate "nothing drawn" from "drawn but dark".
4. Check the winding/`frontFace` pair before suspecting the fragment shader.
5. Only then add `console.log` in the shader-side data path (uniform writes in `renderer.ts`).

## 6. Environment notes for sandboxed agents

* Servers must bind `0.0.0.0` (the Vite config already does) and the browser you preview in is not
  the sandbox — never point client code at `localhost`.
* `nodejs.org` and the Playwright CDN may be unreachable; `npm ci` from the registry usually works.
  The setup script's bundled-Chromium route needs no external network once `node_modules` exists.
* `check:browser` exits `2` (NOT RUN) rather than failing when no browser can launch, so a green
  `verify` never implies the browser gate passed. Run it explicitly and quote its output.

## 7. Session memory & change log (read these first, write to them always)

* **`mnemosyne.md` is the notes system for future sessions.** Read it before starting work. Anything
  may be placed into it: real bugs found (symptom, root cause, fix), hard-won repo facts, lessons
  that code comments are the wrong shape for. Append dated entries at the bottom; keep them short
  and link to files instead of pasting code.
* **`change-log.md` is the JSON-backed activity history** (future data source for an interactive
  history page). Append one `change` entry per file you create, modify, or delete — model name
  (+ version when known), file, and a brief what + why — following the schemas in the file header.
  Before each PR merge, append a `pr-merge` entry summarising all changes in that PR. Validate the
  ```json fence still parses after every edit.

## 8. Selective testing — explicit production coverage, test-only import tracing

`npm test` runs every linked suite in the declared order, one process per suite. During the edit loop,
`npm run test:affected` uses the same catalog to run only suites supported by direct-file, explicit
coverage, or test-helper evidence. The rules are implemented and tested in `packages/selrun/` and
summarized in `docs/TESTING.md`.

* **Production changes use only explicit `@covers` claims.** Every suite has both a leading JSDoc
  header and an exported `suite` manifest. Each cover is a repository-backed path (or a deliberate
  glob); one source file may be covered by many suites, and one suite may cover many source files.
  Never collapse claims or assign a single owner per source path. Importing `@forge/engine` does not
  imply coverage of every file re-exported by the public barrel.
* **Static import closure is test-only.** A changed suite selects itself directly. A changed test
  helper selects suites whose static imports reach it, including through other test helpers. Dynamic
  imports are not followed. Production changes are never selected by importing a production module;
  they require an explicit `@covers` match.
* **Working-tree and base changes are different inputs.** With no `--base`, selection includes staged,
  unstaged, deleted, renamed, and untracked paths. `npm run test:affected -- --base REF` compares
  exactly `REF...HEAD` and ignores all local working-tree state. Rename/copy records include both paths.
* **The catalog is guarded.** `npm run test:check` validates every suite header/export, unique suite
  name, repository-backed area, every `@covers` claim, one ordered link per discovered suite in
  `tests/full.test.ts`, and the `report(n)` count. The linked array is the execution order; do not
  silently sort it. Suite areas must come from directories in this repository—do not invent names.
* **Browser smokes remain separate.** The real-WebGPU and end-to-end checks run under
  `npm run check:browser*`; they are not Node test suites and do not belong in `tests/<area>/*.test.ts`.
* **CI**: pull requests select against the PR base; pushes to `main` run the full suite. The
  `full-test-run` label, a `[full-ci]` head-commit token, or a manual dispatch with `full: true` also
  forces the full run.
