# What is verified, and how

Phase 1 is implemented but **not fully verified**. This file states exactly which claims are backed by
an automated check, so nothing in `ROADMAP.md` has to be taken on faith.

## Runs green today

| Command | Checks | Status |
| --- | --- | --- |
| `npm run typecheck` | `tsc -b engine` (strict mode, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`) | passing |
| `npm test` | `tests/math.test.ts` — 23 tests over the math layer | passing |
| `npm run check:wgsl` | structural WGSL validation of every shipped shader + 16-byte layout sizing | passing |
| `npm run verify` | the three above, in order | passing |

The math suite deliberately pins the conventions the rest of the engine assumes: the `+Z` forward view
space shared by `Mat4.setLookAt`/`setPerspective`/`Frustum`, WebGPU's `[0,1]` depth range, the
`[0,1]`-safe deterministic hash/noise, float64-pair and `Double3.writeRelativeFloat32` precision, and
`TransformStore` dirty-skip behaviour. Writing it found four real defects (OpenGL-style projection
convention, ortho depth mapped to `[-1,1]`, a frustum near plane derived for the wrong convention, and a
`mix32(0) === 0` fixed point that flattened the noise tile at the world origin).

## Not verified yet — do not claim these

* **Anything GPU.** No browser or WebGPU adapter is available in this environment. `check:browser`
  therefore exits `2` ("not run") on purpose; a green `verify` does not imply a frame was ever presented.
* **`Engine` / `Renderer` / `Scene` at runtime.** The mock render test written during this pass did not
  reach green and was removed rather than left red; the next task is to finish it (drive
  `Renderer.renderScene` on `createMockGpu()` and assert `drawCalls >= 1`, zero validation errors, and
  zero leaked buffers/textures after dispose).
* **Resources, ECS lifecycle, task scheduler, terrain tasks.** Compiling and unit-testable, but no tests
  exist yet for eviction order, stale-handle safety under structural edits, or worker round-trips.
* **`npm run demo`.** `examples/` has a Vite script but no entry file yet, so nothing is served.

## Mock-device caveat

`engine/src/testing/mockGpu.ts` validates usage bits, bind group layout agreement, offsets/alignment,
viewport bounds, destroyed-resource reuse and leaks (`outstanding`). It is **not** a WGSL compiler:
`validateWgsl` is structural. Both together still miss driver-specific behaviour, which is why the browser
gate stays on the critical path.
