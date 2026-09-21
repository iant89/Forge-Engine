# What is verified, and how

Phase 1 rendering and core engine foundations are **verified** through automated tests and headless real-WebGPU checks.
This file states exactly which claims are backed by an automated check, so nothing in `ROADMAP.md` has to be taken on faith.

## Setting up

`npm run setup` (`scripts/setup-deps.sh`) installs or verifies every prerequisite below — Node, npm,
the locked packages, and the headless Chromium + SwiftShader build that `check:browser` drives —
checking versions first and only installing what is missing or wrong. `npm run setup:check` verifies
without changing anything.

## Runs green today

| Command | Checks | Status |
| --- | --- | --- |
| `npm run typecheck` | `tsc -b engine` (strict mode, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`) and examples tsconfig | passing |
| `npm test` | 30 tests: `tests/math.test.ts` (25 math tests) and `tests/rendering.test.ts` (5 mock-GPU renderer tests) | passing |
| `npm run check:wgsl` | structural WGSL validation of every shipped shader + 16-byte layout sizing | passing |
| `npm run check:browser` | Headless Chromium + SwiftShader: real WebGPU loop, shadow + main passes, frame advancement, pixel variation, resize resilience | passing |
| `npm run verify` | typecheck, test, and check:wgsl in sequence | passing |

The math suite deliberately pins the conventions the rest of the engine assumes: the `+Z` forward view
space shared by `Mat4.setLookAt`/`setPerspective`/`Frustum`, WebGPU's `[0,1]` depth range, the
`[0,1]`-safe deterministic hash/noise, float64-pair and `Double3.writeRelativeFloat32` precision, and
`TransformStore` dirty-skip behaviour.

The rendering test suite (`tests/rendering.test.ts`) drives `Renderer.renderScene` on the mock WebGPU device,
asserting that draw calls are issued (`drawCalls >= 1`, `triangles >= 12`), both shadow and main render passes
execute, frustum culling properly culls objects outside the camera view, debug line rendering functions, zero WebGPU
validation errors occur, and all GPU buffers/textures are cleanly released upon disposal without leaks.

## A real browser + real WebGPU runs here

`tools/browser-check.mjs` starts the Vite demo, drives headless Chromium over a real WebGPU adapter
(`google/swiftshader` with Vulkan backing), and asserts that:
- Frames advance continuously (`frame > before.frame`, ~50-60 fps).
- Draw calls are active (`drawCalls >= 14`, `triangles >= 74`).
- Real geometry and lighting render to the canvas (>8 distinct pixel colours, and a mean luminance high enough to prove the camera is actually aimed at the lit scene rather than at black sky).
- Resizing the viewport recreates the swapchain/depth buffers and presentation continues seamlessly without stalling.

Run it with `npm run check:browser`.

## Verified capabilities

* **A rendered frame.** Headless Chromium renders the 3D scene (ground plane, cubes, lighting) with real WebGPU shader compilation, draw calls, depth testing, and presentation.
* **`Engine` / `Renderer` / `Scene` at runtime.** Verified both through `tests/rendering.test.ts` on the strict mock device and through `npm run check:browser` in real Chromium.
* **GPU resource lifecycle.** Clean teardown on disposal with zero leaked GPU buffers or textures asserted by `MockGPUDevice.outstanding`.

## Not verified yet (Phase 2 / Phase 3 scope)

* **Multi-threaded task scheduler and worker round-trips.** Worker entry and scheduler are implemented, but worker execution across threads is pending Phase 2 test suites.
* **Terrain generation and streaming.** Voxel/heightmap generation tasks and chunk streaming will be tested in Phase 2.
* **Resource cache eviction policies.** Texture and mesh resource managers compile, but LRU eviction under memory pressure is not yet tested.
