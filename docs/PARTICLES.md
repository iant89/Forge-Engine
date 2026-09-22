# Particles (Phase 7)

One `Float32Array` holds every particle. 100k particles are not 100k entities. The CPU simulation
is the reference. A compute shader implements the same gravity, drag, and life step. Emission,
colour, size, and trails stay on the CPU — the shader does not spawn, and there is no particle
pass in the render graph.

## Demo

`npm run demo`, then **Particles (P7)**, or open `?scene=particles`.

A fountain of 200 unlit boxes. `ParticleWorld.update` is the only stepper: it emits, integrates,
records trails, and poses `spriteEntities`. Do not also add a `ParticleSystem` for the same
simulation. That steps it twice.

The shared material does not read per-particle colour. `ColorOverLifeModule` and
`SizeOverLifeModule` write the buffer; size is applied as the sprite's scale, colour is not. Trails
are recorded (length 8) and not drawn.

## Layout

16 floats per particle, matching `Particle` in `PARTICLE_SIM_SHADER`:

| offset | field |
| --- | --- |
| 0–2 | position |
| 3 | life |
| 4–6 | velocity |
| 7 | maxLife |
| 8–11 | colour |
| 12 | size |
| 13 | seed |
| 14 | age |
| 15 | flags (`FLAG_ALIVE` = 1) |

Integration is semi-implicit Euler: `v += g·dt`, `v *= max(0, 1 − drag·dt)`, `p += v·dt`, then life
and age. With drag 0 that is **not** `½gt²` from rest after one step — velocity is updated before
position, so one step from rest moves by `g·dt²`, and the closed form after `n` steps is
`analyticGravity`. The CPU function `integrateParticle` and the WGSL entry `csMain` use that same
order. `check:wgsl` validates the shader text; it does not compile it.

## GPU check

`runParticleGravityCheck(device, options)` uploads a rest state, dispatches the compute pipeline
`steps` times, reads the buffer back, and compares it to `analyticGravity`.

- On the mock device the dispatch is recorded and WGSL does not run, so `gpuExecuted` is false and
  `computeTouchCount` is the proof the pipeline was touched. `cpuError` is still the analytic check.
- On a real device `gpuExecuted` is true only if the readback actually moved. A shader that compiled
  and dispatched but did not write leaves the uploaded rest state, and the check reports that.

The demo exposes it as `window.__forge.runParticleGravityCheck`. `npm run check:browser` calls it
on the page's device and requires `gpuExecuted` with `gpuError < 1e-2`.

## Using it

```ts
import { ParticleWorld, ColorOverLifeModule, SizeOverLifeModule } from "@forge/engine";

const fountain = new ParticleWorld({
  capacity: 200,
  gravity: { x: 0, y: -9.81, z: 0 },
  drag: 0.4,
  seed: 7,
});
fountain.simulation.emitter.rate = 80;
fountain.simulation.modules.push(new SizeOverLifeModule(0.28, 0.04));
scene.add(fountain);
fountain.spriteEntities = spriteEntityIds; // optional; hidden when no particle is left
```

`ParticleComponent` plus `ParticleSystem` is the other owner (one step per frame, band 400, not once
per physics substep — a hitch must not quintuple a fountain). Pick one owner per simulation.

Emission is deterministic for a seed. The emitter uses its own RNG, not `Math.random`. `rate` is
particles per second; a fractional leftover carries. `maxEmitsPerFrame` and the buffer length are
the caps.

## What is tested

`tests/particles.test.ts` (13):

- The integrator matches `analyticGravity`, including the semi-implicit (not `½gt²`) first step.
- Drag damps speed; a particle whose life expires is cleared.
- `PARTICLE_SIM_SHADER` passes `validateWgsl`.
- Cone emission is deterministic for a seed.
- Colour and size lerp across life.
- Emission respects `maxParticles` / `maxEmitsPerFrame`.
- A trail records the positions just visited.
- The same seed produces the same buffer.
- 100k alive particles, drag 0, 30 steps, finish under 1 s, and particle 0 matches the analytic curve.
- The mock device dispatches the compute pipeline (`gpuExecuted === false`, `computeTouchCount > 0`,
  `cpuError < 1e-4`, no mock errors).
- `ParticleSystem` poses a sprite from a `ParticleComponent` and does not require a second call.
- `ParticleWorld` steps from the scene object alone.
- Two emitters with the same seed emit the same first particle (`Math.random` is not in the path).

`npm run bench` runs the same 100k × 30 integrate and exits non-zero if it takes 1 s or more, or if
the rest particle leaves the analytic curve. On the machine that produced `docs/VERIFICATION.md`
that integrate was about 100 ms.

## Limitations

- The GPU shader integrates. It does not emit, run modules, or write trails. Those are CPU.
- No billboard or trail draw. The demo poses a few hundred `Renderable` boxes. 100k is a buffer
  benchmark, not a frame of sprites.
- Per-particle colour stays in the buffer. One material is shared.
- There is no particle pass in the render graph, and no GPU budget beyond the capacity you allocate.
- `ParticleSystem` is variable-rate. Do not expect it to match a fixed-step physics trajectory across
  frame rates; the analytic check calls `step` / the compute shader with an explicit `dt`.
