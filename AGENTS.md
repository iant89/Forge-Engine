# AGENTS.md — working in this repository

Guidance for coding agents (and humans) contributing to Forge, a browser-native WebGPU 3D engine.
Read this before running anything. `ARCHITECTURE.md` explains *why* the code is shaped the way it is;
this file is about *how to work in it* without breaking the things the tests were written to protect.

## 0. Start here: one command sets up the toolchain

> **There is a dependency install script. Use it first — it makes building and testing much quicker
> than discovering missing pieces one failed command at a time.**
>
> ```sh
> npm run setup            # or: scripts/setup-deps.sh
> npm run setup:check      # verify only; exits 1 if anything is missing or at the wrong version
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

Flags: `--check` (verify only), `--no-browser` (skip the browser step), `--browser` (fail instead of
warn when no browser can be provisioned), `--verbose`. In sandboxes where the public CDNs are blocked
the bundled-Chromium path is the one that works; do not spend time trying to `playwright install`.

## 1. Commands you will actually run

```sh
npm run typecheck        # tsc -b engine (strict) + examples tsconfig
npm test                 # vitest: math, renderGraph, shadows, pipeline, frame + rendering (mock GPU device), wgsl
npm run check:wgsl       # structural WGSL validation + strict uniform address-space layout of every shipped shader
npm run verify           # typecheck + test + check:wgsl — run this before every commit
npm run check:browser    # REAL WebGPU: Vite demo in headless Chromium/SwiftShader, asserts on pixels
npm run demo             # Vite dev server for examples/ (binds 0.0.0.0, allowedHosts: true)
```

`verify` is necessary but not sufficient for rendering changes. The mock device cannot tell you whether
anything is *visible*; `check:browser` can, and it writes `tools/.browser-check.png` — **look at the
screenshot**, don't just read the pass/fail line. (A previous black-screen bug passed every automated
gate because the thresholds were too loose; they have since been tightened, but a human/agent eyeball
on the PNG is still the cheapest check there is.)

## 2. Repository map (what exists today)

```
engine/src/          @forge/engine — the runtime, zero runtime deps, builds with tsc
  core/              Engine loop, config, time, events, logging, task scheduler + worker entry
  gpu/               GraphicsDevice, buffer/struct writers, formats, shader cache, constants
  math/              Vec/Mat/Quat, Double3 (large worlds), geometry (AABB/Frustum/Ray), noise, rng
  rendering/         Renderer (one frame in/out), RenderGraph (validation, culling, aliasing, pooling),
                     shadows.ts (cascade fit), PipelineFactory, Material, Geometry, primitives,
                     uniforms (single source of truth for WGSL structs), shaders/{standard,post,common}.ts
  scene/             Scene, EntityWorld (ECS-ish), component stores, Transform/Camera/Light/Renderable
  physics/           fixed-step rigid bodies (Phase 5). Vehicles are not in this solver.
  vehicles/          raycast car: Pacejka, suspension, engine/gearbox/diff, aero, TC/ABS (docs/VEHICLES.md)
  particles/         CPU simulation + a compute integrator for the same gravity/drag/life step (docs/PARTICLES.md)
  resources/         ResourceRegistry, textures + defaults
  testing/           MockGPUDevice (strict validation, leak tracking) used by the mock-GPU suites
examples/            Vite demo — scenes: pbr, cubes, terrain, realistic, vehicle-playground, particles.
                     Also the fixture `check:browser` drives. Orbit keyboard pan is on unless a scene sets `keyboard: false`.
tests/               vitest suites (math, ecs, vehicles, particles, terrain, physics, renderGraph, wgsl, …)
benchmarks/          100k-entity ECS bench and 100k-particle integrator bench (`npm run bench`)
tools/               wgsl-check.mjs (includes PARTICLE_SIM_SHADER), browser-check.mjs (includes the real-GPU gravity check)
scripts/             setup-deps.sh
docs/VERIFICATION.md What each automated gate actually proves — keep it truthful when you change gates
docs/RENDERING.md    The renderer as built: frame structure, render graph rules, HDR/bloom, CSM, how to add a pass
docs/VEHICLES.md     Phase 6 as built, including what the chassis test actually asserts
docs/PARTICLES.md    Phase 7 as built: CPU is the reference, the compute shader is the integrator only
ARCHITECTURE.md      Design + rationale; ROADMAP.md — phases 8–14 are not built
```

The demo aliases `@forge/engine` to `engine/src/index.ts` (see `examples/vite.config.ts`), so there is
no build step between editing engine source and seeing it in the browser.

## 3. Conventions that are load-bearing (break these and things silently go dark)

* **Coordinate system: +Y up, camera/light look down their local +Z, view space is left-handed.**
  `Mat4.setLookAt` returns a *view* matrix (world→view; eye maps to origin, target to `(0,0,+d)`).
  `Mat4.setPerspective`/`setOrthographic` map depth to WebGPU's `[0,1]` with `clipW = z`.
  `Frustum.setFromViewProjection` extracts planes for exactly that convention.
  The render pipeline uses `frontFace: "cw"` because outward-wound primitives land clockwise on screen
  under this projection. These four agree with each other and are pinned by `tests/math.test.ts`;
  change one and you must change them all, plus the tests.
* **`Transform.lookAt(target)` aims local +Z at `target`.** Lights travel along their +Z, so
  `sun.transform.lookAt(x)` shines at `x`; the renderer refreshes `Light.direction` from the world
  matrix every frame while `followRotation` is true.
* **Matrices are column-major `Float32Array(16)`** and are uploaded as-is. Never transpose on upload.
* **`Mat4.transformPoint(v, out)` and friends must stay alias-safe** (`out === v` is how the scratch
  vectors are used). Read the inputs into locals before writing `out`; `tests/math.test.ts` pins it.
* **Every GPU pass goes through the `RenderGraph`.** Declare what a pass reads and attaches (per
  mip/layer where it matters); never call `encoder.beginRenderPass` on a texture the graph does not
  know about. The graph validates before recording and pools textures by descriptor — a steady frame
  must report `texturesCreated: 0` (asserted by `tests/frame.test.ts` and `check:browser`).
* **WGSL uniform structs are generated from `engine/src/rendering/uniforms.ts`.** Do not hand-edit
  struct declarations in `shaders/standard.ts` or `shaders/post.ts`; change the TS definition and
  `check:wgsl` will confirm the 16-byte alignment. Hand-written WGSL must still pass `check:wgsl`.
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
  `dispose()`; `tests/rendering.test.ts` asserts `mock.outstanding` is empty after teardown.
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
2. Reproduce the camera/light math in a throwaway vitest file against `Mat4`/`Frustum` directly
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
