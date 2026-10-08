# Particles (Phase 7 + Phase 12)

One GPU storage buffer holds every GPU particle. 100k particles are not 100k entities. The CPU
simulation remains the reference. Phase 12 makes the GPU path authoritative for emission,
integration (with modules), culling and billboard/soft rendering through render-graph passes
`particle.sim` / `particle.sort` / `particle.render` / `particle.resolve`.

## Demo

`npm run demo`, then **Particles (P12 GPU)**, or open `?scene=particles`.

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
- a 4-sample trail history buffer (ring written by the full-sim, slot-zeroed by emit on recycle)
- emit / full-sim / frustum+distance cull / billboard+soft render / ribbon vertex stage / resolve pipelines

Emission is a ring-buffer compute write hashed from `(seed, emitBase + i)` (monotonic across ring wraps) — deterministic for a seed. Draw uses `drawIndirect` over the frustum/distance compacted list.
Soft particles sample the scene depth attachment; stretched billboards elongate along velocity.

## Ribbon trails (Phase 12.4/12.7)

With `ribbons: true`, the same `particle.render` pass first draws trail ribbons and then the
billboards, so the sparks cap the strips in the alpha order. There is no CPU mesh and no
generated geometry: the vertex stage (`PARTICLE_RIBBON_SHADER`) pulls one particle per instance
from the *same* compacted visible list as the billboards and triangulates its 4-sample trail ring
in place — three quads, six vertices each, 18 vertices per particle (`PARTICLE_RIBBON_VERTS`),
duplicated across the diagonal so both triangles of a quad are degenerate-safe.

- The ring is stored by `u32(age·30) % 4`, so the vertex stage sorts the four samples newest-first
  with a fixed five-comparator network — a pure function of the buffer bytes, no temporal order assumed.
  A segment whose older sample was never written (the particle is younger than the ring) is skipped,
  so a brand-new life simply has no ribbon yet instead of a spike toward the ring's zero sample.
- Width is `size · ribbonSizeScale`, tapered toward the oldest sample by `ribbonTailWidth`; a
  reused slot's ring is zeroed by the emit pass, so a new life never draws its predecessor's trail.
- Alpha fades toward the tail as `fade²`; the strip is camera-facing (segment × view-ray cross
  product, with stable fallbacks when the segment points at the camera).
- The cull pass counts survivors into a second indirect record (`[18, visible]` at byte 16) only
  while the frame's ribbon flag is set; the resolve pass zeroes it, so toggling `setRibbons`
  mid-run can never draw a stale count. With soft particles enabled the strips sample the same
  scene depth as the billboards.
- The toggle is live (`GpuParticleWorld.setRibbon`); the `particles` demo builds with ribbons on
  and `?ribbons=0` pins them off for an A/B link.

## CPU path (Phase 7 reference)

`ParticleWorld` / `ParticleSimulation` / `ParticleSystem` still exist for tests and as the fallback
reference. Do not attach both `ParticleWorld` and `ParticleSystem` to the same simulation.

CPU module ports kept for the reference path: gravity, drag, colour-over-life, size-over-life, and
cone sampling. Velocity boost, attractor, and rotation-over-life are **GPU-only** (configured via
`GpuParticleModulesConfig` / `PARTICLE_FULL_SIM_SHADER`); the matching CPU classes were removed.

## Accounting (no fake alive)

`GpuParticleSystem` / the particles demo expose `emitted` (cumulative spawn count from the CPU emit
budget) and `capacity`. There is **no** GPU readback of concurrent live particles, so APIs must not
report a fake `alive` count derived from `emitted`. The CPU `ParticleSimulation.alive` field remains
honest for the Phase 7 reference path only.

## GPU gravity check

`runParticleGravityCheck(device, options)` still verifies the tight integrator against
`analyticGravity` (used by `npm run check:browser`).

## What is tested

`tests/particles/particles.test.ts` covers the CPU reference, the gravity check on the mock device, WGSL
validation of every Phase 12 shader, the 100k-without-ECS invariant, 10k/50k/100k capacity stress on
the mock device, `GpuParticleWorld` creating zero entities, and the ribbon contract: the 18-vertex
record drawn before the billboards, the live toggle's effect on the frame, and the emit/cull/resolve
pins around the ring and the second indirect record.

## Limitations

See `docs/KNOWN-ISSUES.md` § Particles: mesh particles deferred, HiZ deferred, collision
deferred, variable-rate CPU `ParticleSystem`. Ribbons draw from a fixed 4-sample ring only — no
per-particle texture coordinates, no ribbon UV/texturing, no sharp-turn mitring.
