# Particles (Phase 7 + Phase 12)

One GPU storage buffer holds every GPU particle. 100k particles are not 100k entities. The CPU
simulation remains the reference. Phase 12 makes the GPU path authoritative for emission,
integration (with modules), culling and billboard/soft rendering through render-graph passes
`particle.sim` / `particle.sort` / `particle.render` / `particle.resolve`.

## Demo

`npm run demo`, then **Particles (P7)**, or open `?scene=particles`.

A GPU fountain at 100k capacity. `GpuParticleWorld` attaches to the engine device; the renderer
enqueues the particle passes. No sprite entities are created.

## Layout

16 floats per particle, matching `Particle` in the particle shaders:

| offset | field |
| --- | --- |
| 0–2 | position |
| 3 | life |
| 4–6 | velocity |
| 7 | maxLife |
| 8–11 | colour |
| 12 | size |
| 13 | seed (also rotation phase on the GPU path) |
| 14 | age |
| 15 | flags (`FLAG_ALIVE` = 1) |

Integration is semi-implicit Euler: `v += g·dt`, `v *= max(0, 1 − drag·dt)`, `p += v·dt`, then life
and age. The tight gravity check (`PARTICLE_SIM_SHADER` / `integrateParticle`) and the Phase 12
full-sim share that core; the full-sim also applies turbulence, noise, attractors, velocity boost,
and colour/size/rotation over life.

## GPU path (Phase 12)

`GpuParticleSystem` owns:

- the authoritative particle storage buffer
- a 4-sample trail history buffer (ribbon draw deferred)
- emit / full-sim / frustum+distance cull / billboard+soft render / resolve pipelines

Emission is a ring-buffer compute write hashed from `(seed, emitIndex)` — deterministic for a seed.
Soft particles sample the scene depth attachment; stretched billboards elongate along velocity.

## CPU path (Phase 7 reference)

`ParticleWorld` / `ParticleSimulation` / `ParticleSystem` still exist for tests and as the fallback
reference. Do not attach both `ParticleWorld` and `ParticleSystem` to the same simulation.

## GPU gravity check

`runParticleGravityCheck(device, options)` still verifies the tight integrator against
`analyticGravity` (used by `npm run check:browser`).

## What is tested

`tests/particles.test.ts` covers the CPU reference, the gravity check on the mock device, WGSL
validation of every Phase 12 shader, the 100k-without-ECS invariant, 10k/50k/100k capacity stress on
the mock device, and `GpuParticleWorld` creating zero entities.

## Limitations

See `docs/KNOWN-ISSUES.md` § Particles: ribbon/mesh deferred, HiZ deferred, collision deferred,
variable-rate CPU `ParticleSystem`.
